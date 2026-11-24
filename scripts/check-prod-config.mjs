/* eslint-env node */
// npm run check:prod  (also runs first in npm run deploy:prod)
// Stops a production deploy with a placeholder URL, or with config that differs
// from what was tested locally. When the local, git-ignored render-setup/ folder
// exists, its env files are checked against the production config too.
import { existsSync, readFileSync } from "node:fs";
import { checkProductionConfig } from "./config-check.mjs";

const path = (file) => new URL(`../${file}`, import.meta.url);
const read = (file) => readFileSync(path(file), "utf8");
const readIfThere = (file) => (existsSync(path(file)) ? read(file) : null);

const webEnv = readIfThere("render-setup/web-service.env");
const { errors, warnings, config } = checkProductionConfig({
  prodToml: read("shopify.app.bibs-planned-order.toml"),
  devToml: read("shopify.app.toml"),
  renderYaml: readIfThere("render-setup/render.yaml"),
  webEnv,
  cronEnv: readIfThere("render-setup/cron-job.env"),
  appUrl: process.env.SHOPIFY_APP_URL || "",
});

console.log(`Production app: ${config.clientId}  URL: ${config.applicationUrl}`);
console.log(webEnv ? "Checked with render-setup/web-service.env and cron-job.env." : "render-setup/ not found: Render env files not checked.");

// The URL must really serve this app; otherwise Shopify admin, the app proxy and webhooks all get 404.
if (!errors.length) {
  const loginUrl = `${new URL(config.applicationUrl).origin}/auth/login`;
  try {
    const response = await fetch(loginUrl, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    if (response.headers.get("x-render-routing") === "no-server") {
      errors.push(`No Render service at ${config.applicationUrl}. Copy the exact URL from the top of the Render web service page.`);
    } else if (response.status !== 200) {
      errors.push(`${loginUrl} answered HTTP ${response.status}; the app should show its login page (200). Check the Render logs.`);
    } else {
      console.log(`Live: ${loginUrl} → 200`);
    }
  } catch (error) {
    errors.push(`Could not reach ${loginUrl} (${error.message}). Is the Render web service live?`);
  }
}
warnings.forEach((warning) => console.warn(`  ! ${warning}`));
if (errors.length) {
  console.error("\nNot ready to deploy:");
  errors.forEach((error) => console.error(`  ✗ ${error}`));
  process.exit(1);
}
console.log("Config OK. Before deploying, check once:");
[
  "Render web service is live with its env vars and the /var/data disk (render-setup/README.md)",
  "Dev Dashboard → app → Protected customer data access is filled in (customers/delete and customer names/emails need it)",
].forEach((line) => console.log(`  • ${line}`));
