// Checks the production app config before `shopify app deploy` (pure: text in,
// problems out). Used by scripts/check-prod-config.mjs and tests/config.test.js.
// Reads only the simple TOML/YAML these files use, so no parser is needed.

const PLACEHOLDER_HOSTS = ["example.com", "shopify.dev", "trycloudflare.com", "localhost"];

const first = (text, pattern) => pattern.exec(text)?.[1] ?? null;
const strings = (list) => [...String(list ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);

/** Text of a [table] up to the next top-level [table]; the header must start a line (not a comment). */
function block(text, header) {
  const match = new RegExp(`^\\[${header}\\][ \\t]*$`, "m").exec(text);
  if (!match) return "";
  const rest = text.slice(match.index + match[0].length);
  const next = rest.search(/^\[[^[]/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The parts of a shopify.app*.toml that must match between dev and production. */
export function readAppConfig(toml) {
  const proxy = block(toml, "app_proxy");
  return {
    clientId: first(toml, /^client_id\s*=\s*"([^"]*)"/m),
    applicationUrl: first(toml, /^application_url\s*=\s*"([^"]*)"/m),
    scopes: (first(toml, /^scopes\s*=\s*"([^"]*)"/m) || "").split(",").map((s) => s.trim()).filter(Boolean).sort(),
    proxy: {
      url: first(proxy, /^url\s*=\s*"([^"]*)"/m),
      prefix: first(proxy, /^prefix\s*=\s*"([^"]*)"/m),
      subpath: first(proxy, /^subpath\s*=\s*"([^"]*)"/m),
    },
    webhooks: [...toml.matchAll(/^\s*uri\s*=\s*"([^"]*)"\s*\n\s*topics\s*=\s*\[([^\]]*)\]/gm)]
      .map((m) => `${strings(m[2]).join(",")} -> ${m[1]}`)
      .sort(),
    events: [...toml.matchAll(/triggers\s*=\s*\[([^\]]*)\]\s*\n\s*uri\s*=\s*"([^"]*)"/gm)]
      .map((m) => `${strings(m[1]).join(",")} -> ${m[2]}`)
      .sort(),
    redirectUrls: strings(first(toml, /redirect_urls\s*=\s*\[([\s\S]*?)\]/m)),
    updateUrlsOnDev: first(toml, /^automatically_update_urls_on_dev\s*=\s*(true|false)/m),
  };
}

const scopeList = (text) => String(text || "").split(",").map((s) => s.trim()).filter(Boolean).sort();

/** SCOPES value in render.yaml (web service). */
export function renderScopes(yaml) {
  return scopeList(first(yaml, /key:\s*SCOPES\s*\n\s*value:\s*"?([^"\n]+)"?/m));
}

/** KEY=value from a .env-style file (comment lines ignored); null when the key is absent. */
export function envValue(text, key) {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(text || "");
  return match ? match[1].trim().replace(/^"(.*)"$/, "$1") : null;
}

/**
 * Render env files (render-setup/, local only): web-service.env must match the
 * production toml, cron-job.env must match the web service.
 */
function checkRenderEnv({ prod, webEnv, cronEnv, errors, warnings }) {
  const web = (key) => envValue(webEnv, key);
  if (web("SHOPIFY_API_KEY") !== prod.clientId) errors.push(`web-service.env SHOPIFY_API_KEY (${web("SHOPIFY_API_KEY")}) is not the app's client_id (${prod.clientId})`);
  if (!web("SHOPIFY_API_SECRET")) warnings.push("web-service.env: SHOPIFY_API_SECRET is empty; fill it before pasting into Render.");
  if (!web("KLAVIYO_PRIVATE_KEY")) warnings.push("web-service.env: KLAVIYO_PRIVATE_KEY is empty; no customer emails until it is set.");
  if ((web("PLANNED_ORDER_CRON_SECRET") || "").length < 24) errors.push("web-service.env: PLANNED_ORDER_CRON_SECRET must have at least 24 characters");
  if (JSON.stringify(scopeList(web("SCOPES"))) !== JSON.stringify(prod.scopes)) {
    errors.push(`web-service.env SCOPES (${web("SCOPES")}) differ from the app scopes (${prod.scopes.join(",")})`);
  }
  if (cronEnv) {
    ["SHOPIFY_APP_URL", "PLANNED_ORDER_CRON_SECRET"].forEach((key) => {
      if (envValue(cronEnv, key) !== web(key)) errors.push(`cron-job.env ${key} is not the same as in web-service.env`);
    });
  }
}

export function checkProductionConfig({ prodToml, devToml, renderYaml = null, webEnv = null, cronEnv = null, appUrl = "" }) {
  const errors = [];
  const warnings = [];
  const prod = readAppConfig(prodToml);
  const dev = readAppConfig(devToml);
  appUrl = appUrl || envValue(webEnv, "SHOPIFY_APP_URL") || "";

  let url = null;
  try {
    url = new URL(prod.applicationUrl || "");
  } catch {
    errors.push(`application_url is not a valid URL: ${prod.applicationUrl}`);
  }
  if (url) {
    if (url.protocol !== "https:") errors.push("application_url must start with https://");
    if (PLACEHOLDER_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      errors.push(`application_url is still a placeholder (${url.hostname}); use the Render URL`);
    }
    if (url.pathname !== "/" || url.search) errors.push("application_url must be the bare https://host (no path)");
    const base = url.origin;
    if (!prod.redirectUrls.length) errors.push("[auth] redirect_urls is empty");
    prod.redirectUrls
      .filter((redirect) => !redirect.startsWith(`${base}/`))
      .forEach((redirect) => errors.push(`redirect_url ${redirect} doesn't start with ${base}/`));
    if (appUrl && appUrl.replace(/\/$/, "") !== base) {
      errors.push(`SHOPIFY_APP_URL (${appUrl}) and application_url (${base}) differ; they must be the same`);
    }
  }
  if (prod.updateUrlsOnDev !== "false") errors.push("[build] automatically_update_urls_on_dev must be false in production");

  if (dev.clientId !== prod.clientId) {
    warnings.push(`Dev config uses another app (${dev.clientId}) than production (${prod.clientId}).`);
  }
  const same = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      errors.push(`${label} differ between shopify.app.toml and production:\n    dev:  ${JSON.stringify(a)}\n    prod: ${JSON.stringify(b)}`);
    }
  };
  same("scopes", dev.scopes, prod.scopes);
  same("[app_proxy]", dev.proxy, prod.proxy);
  same("webhook subscriptions", dev.webhooks, prod.webhooks);
  same("event subscriptions", dev.events, prod.events);
  if (renderYaml) same("SCOPES in render.yaml and the app scopes", renderScopes(renderYaml), prod.scopes);
  if (webEnv) checkRenderEnv({ prod, webEnv, cronEnv, errors, warnings });
  if (prod.proxy.url && /^https?:/.test(prod.proxy.url)) {
    warnings.push("[app_proxy] url is absolute; a relative /proxy follows application_url automatically.");
  }
  return { errors, warnings, config: prod };
}
