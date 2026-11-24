/* eslint-env node */
import { timingSafeEqual } from "node:crypto";
import { runNightlyForAllShops } from "../planned/jobs.server";

/**
 * External scheduler endpoint: POST /api/cron/nightly
 * Header: Authorization: Bearer <PLANNED_ORDER_CRON_SECRET>
 *
 * Starts the nightly check for every installed shop and answers at once (202);
 * each shop's result is in the app's Activity page ("Nightly check").
 */
export const action = async ({ request }) => {
  const secret = process.env.PLANNED_ORDER_CRON_SECRET || "";
  if (secret.length < 24) {
    return Response.json({ error: "PLANNED_ORDER_CRON_SECRET is not configured (min. 24 characters)." }, { status: 503 });
  }
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(provided, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  runNightlyForAllShops().catch((error) => console.error(`[plan] Nightly run failed: ${error.message}`));
  return Response.json({ started: new Date().toISOString() }, { status: 202 });
};

export const loader = () => Response.json({ error: "Use POST" }, { status: 405 });

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
