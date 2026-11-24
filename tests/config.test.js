import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { checkProductionConfig, envValue, readAppConfig } from "../scripts/config-check.mjs";
import { missingRenderDisk, resolveDatabaseUrl } from "../app/database-url.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const prodToml = read("shopify.app.bibs-planned-order.toml");
const devToml = read("shopify.app.toml");
// render-setup/ is local only (git-ignored): its tests are skipped where it doesn't exist.
const hasRenderSetup = existsSync(new URL("../render-setup/web-service.env", import.meta.url));
const readSetup = (file) => (hasRenderSetup ? read(`render-setup/${file}`) : "");
const renderYaml = readSetup("render.yaml");
const webEnv = readSetup("web-service.env");
const cronEnv = readSetup("cron-job.env");

const APP_URL = "https://bibs-planned-order-app.onrender.com";
const SECRET = "x".repeat(32);
const sampleWebEnv = (overrides = {}) =>
  Object.entries({
    NODE_VERSION: "22.12.0",
    SHOPIFY_API_KEY: "c6bfd545287261f49548bea9bf75e7f8",
    SHOPIFY_API_SECRET: "shpss_test",
    SHOPIFY_APP_URL: APP_URL,
    SCOPES: "write_app_proxy,read_products,read_customers,read_publications",
    KLAVIYO_PRIVATE_KEY: "pk_test",
    PLANNED_ORDER_CRON_SECRET: SECRET,
    ...overrides,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
const sampleCronEnv = (overrides = {}) =>
  Object.entries({ NODE_VERSION: "22.12.0", SHOPIFY_APP_URL: APP_URL, PLANNED_ORDER_CRON_SECRET: SECRET, ...overrides })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

// ---- the real files ------------------------------------------------------------------

test("production config passes the deploy check and matches the dev config", () => {
  const { errors } = checkProductionConfig({ prodToml, devToml });
  assert.deepEqual(errors, []);
  const prod = readAppConfig(prodToml);
  assert.deepEqual(prod.scopes, ["read_customers", "read_products", "read_publications", "write_app_proxy"]);
  assert.deepEqual(prod.proxy, { url: "/proxy", prefix: "apps", subpath: "planned-order" });
  assert.equal(prod.webhooks.length, 4);
  assert.equal(prod.events.length, 1);
});

test("every route the config points to exists", () => {
  const prod = readAppConfig(prodToml);
  const paths = [...prod.webhooks, ...prod.events].map((entry) => entry.split(" -> ")[1]);
  const files = {
    "/webhooks/app/uninstalled": "app/routes/webhooks.app.uninstalled.jsx",
    "/webhooks/app/scopes_update": "app/routes/webhooks.app.scopes_update.jsx",
    "/webhooks/products/delete": "app/routes/webhooks.products.delete.jsx",
    "/webhooks/customers/delete": "app/routes/webhooks.customers.delete.jsx",
    "/webhooks/products/release-date": "app/routes/webhooks.products.release-date.jsx",
  };
  assert.deepEqual(paths.sort(), Object.keys(files).sort());
  Object.values(files).forEach((file) => assert.ok(read(file).includes("authenticate.webhook"), file));
  assert.ok(read("app/routes/proxy.plan.jsx").includes("authenticate.public.appProxy"));
});

test("render-setup (local): env files match the production config", { skip: !hasRenderSetup && "render-setup/ not present" }, () => {
  const { errors } = checkProductionConfig({ prodToml, devToml, renderYaml, webEnv, cronEnv });
  assert.deepEqual(errors, []);
  assert.match(renderYaml, /mountPath: \/var\/data/);
  for (const key of ["NODE_VERSION", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES", "KLAVIYO_PRIVATE_KEY", "PLANNED_ORDER_CRON_SECRET"]) {
    assert.notEqual(envValue(webEnv, key), null, key);
  }
  // Node version on Render satisfies package.json engines (>=22.12).
  const version = envValue(webEnv, "NODE_VERSION").split(".").map(Number);
  assert.ok(version[0] > 22 || (version[0] === 22 && version[1] >= 12), version.join("."));
});

// ---- the checker itself ------------------------------------------------------------------

const withUrl = (url) =>
  prodToml.replaceAll("https://bibs-planned-order-app.onrender.com", url);

test("placeholder or mismatched URLs stop the deploy", () => {
  const check = (toml, appUrl) => checkProductionConfig({ prodToml: toml, devToml, appUrl }).errors.join("\n");
  assert.match(check(withUrl("https://example.com")), /placeholder/);
  assert.match(check(withUrl("https://abc.trycloudflare.com")), /placeholder/);
  assert.match(check(withUrl("http://bibs.onrender.com")), /https/);
  assert.match(check(prodToml, "https://other.onrender.com"), /differ/);
  assert.equal(check(prodToml, "https://bibs-planned-order-app.onrender.com/"), "");
  const badRedirect = prodToml.replace("https://bibs-planned-order-app.onrender.com/api/auth/callback", "https://x.com/api/auth/callback");
  assert.match(check(badRedirect), /redirect_url/);
});

test("config drift between dev and production is caught", () => {
  const check = (toml) => checkProductionConfig({ prodToml: toml, devToml }).errors.join("\n");
  assert.match(check(prodToml.replace(",read_publications", "")), /scopes differ/);
  assert.match(check(prodToml.replace('subpath = "planned-order"', 'subpath = "plan"')), /app_proxy/);
  assert.match(check(prodToml.replace('topics = [ "products/delete" ]', 'topics = [ "products/update" ]')), /webhook/);
  assert.match(check(prodToml.replace("automatically_update_urls_on_dev = false", "automatically_update_urls_on_dev = true")), /must be false/);
});

test("Render env files are checked against the app config", () => {
  const check = (web, cron = sampleCronEnv()) => checkProductionConfig({ prodToml, devToml, webEnv: web, cronEnv: cron });
  assert.deepEqual(check(sampleWebEnv()).errors, []);
  assert.deepEqual(check(sampleWebEnv()).warnings, []);
  assert.match(check(sampleWebEnv({ SHOPIFY_APP_URL: "https://bibs-planned-order-ab12.onrender.com" })).errors.join(), /differ/);
  assert.match(check(sampleWebEnv({ SHOPIFY_API_KEY: "other" })).errors.join(), /client_id/);
  assert.match(check(sampleWebEnv({ SCOPES: "read_products" })).errors.join(), /SCOPES/);
  assert.match(check(sampleWebEnv({ PLANNED_ORDER_CRON_SECRET: "short" })).errors.join(), /24 characters/);
  assert.match(check(sampleWebEnv(), sampleCronEnv({ PLANNED_ORDER_CRON_SECRET: "y".repeat(32) })).errors.join(), /cron-job.env PLANNED_ORDER_CRON_SECRET/);
  assert.match(check(sampleWebEnv({ SHOPIFY_API_SECRET: "", KLAVIYO_PRIVATE_KEY: "" })).warnings.join(), /SHOPIFY_API_SECRET.*KLAVIYO_PRIVATE_KEY|KLAVIYO/s);
  assert.equal(envValue("# KLAVIYO_PRIVATE_KEY=pk\nKLAVIYO_PRIVATE_KEY=", "KLAVIYO_PRIVATE_KEY"), "");
});

// ---- database location -----------------------------------------------------------------------

test("the database is on the Render disk when there is one, else prisma/dev.sqlite", () => {
  assert.equal(resolveDatabaseUrl({}, () => true), "file:/var/data/prod.sqlite");
  assert.equal(resolveDatabaseUrl({}, () => false), "file:dev.sqlite");
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: "file:/tmp/x.sqlite" }, () => true), "file:/tmp/x.sqlite");
  assert.equal(missingRenderDisk({ RENDER: "true" }, "file:dev.sqlite"), true);
  assert.equal(missingRenderDisk({ RENDER: "true" }, "file:/var/data/prod.sqlite"), false);
  assert.equal(missingRenderDisk({}, "file:dev.sqlite"), false);
});
