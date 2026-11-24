// Data for the admin pages (server only).

import prisma from "../db.server";
import { klaviyoConfig } from "./klaviyo.js";
import { DEFAULT_SETTINGS } from "./repo.server";
import { formatTime } from "./admin-views.js";

export const REQUIRED_SCOPES = ["write_app_proxy", "read_products", "read_customers", "read_publications"];
const CHECK_STALE_MS = 36 * 60 * 60 * 1000;

export async function getSettings(shop) {
  return { shop, ...DEFAULT_SETTINGS, ...((await prisma.appSettings.findUnique({ where: { shop } })) || {}) };
}

export async function lastCheckRun(shop) {
  const log = await prisma.activityLog.findFirst({
    where: { shop, type: "check_run" },
    orderBy: { createdAt: "desc" },
  });
  if (!log) return null;
  let details = {};
  try {
    details = JSON.parse(log.details || "{}");
  } catch {
    details = {};
  }
  return { at: log.createdAt.getTime(), label: formatTime(log.createdAt), details, failed: Boolean(details.failed) };
}

/** What still needs doing before the app works fully; shown on the overview and settings. */
export async function setupStatus(shop, scope) {
  const [settings, check] = await Promise.all([getSettings(shop), lastCheckRun(shop)]);
  const granted = String(scope || "").split(",").map((s) => s.trim());
  const klaviyo = klaviyoConfig();
  const now = Date.now();
  return {
    emailsEnabled: settings.emailsEnabled,
    klaviyoConfigured: klaviyo.configured,
    klaviyoMasked: klaviyo.masked,
    missingScopes: REQUIRED_SCOPES.filter((s) => !granted.includes(s)),
    lastCheck: check,
    checkStale: !check || now - check.at > CHECK_STALE_MS,
    cronConfigured: (process.env.PLANNED_ORDER_CRON_SECRET || "").length >= 24,
  };
}
