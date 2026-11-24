/* eslint-env node */
// Called once a day by the scheduler (Render Cron Job), e.g. 01:00 UTC.
// Env: SHOPIFY_APP_URL (same value as the web service) and
//      PLANNED_ORDER_CRON_SECRET (same value as the web service).
const appUrl = (process.env.PLANNED_ORDER_APP_URL || process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
const secret = process.env.PLANNED_ORDER_CRON_SECRET ?? "";

if (!appUrl || !secret) {
  console.error("SHOPIFY_APP_URL (or PLANNED_ORDER_APP_URL) and PLANNED_ORDER_CRON_SECRET are required.");
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/cron/nightly`, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
});
const body = await response.text();
console.log(`HTTP ${response.status} ${body}`);
if (!response.ok) process.exit(1);
