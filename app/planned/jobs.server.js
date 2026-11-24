// Wires jobs.js to Prisma, Shopify and Klaviyo for the routes.

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { prismaRepo } from "./repo.server";
import { defaultDeps, deliverEmails, processProductChange, queueEmails, runNightlyCheck } from "./jobs.js";
import { runExclusive } from "./locks.js";

export const repo = prismaRepo();

/** Sends queued emails without delaying the caller. */
export function deliverInBackground(shop, deps = defaultDeps()) {
  runExclusive(`email:${shop}`, () => deliverEmails({ repo, shop, deps })).catch((error) =>
    console.error(`[plan] Email delivery failed for ${shop}: ${error.message}`),
  );
}

/** A product's ordering date changed, or it was deleted. */
export function onProductChanged({ shop, productId, deleted = false, admin }) {
  return runExclusive(shop, async () => {
    const deps = defaultDeps();
    const result = await processProductChange({ repo, shop, productId, deleted, admin, deps });
    if (result.events.length) deliverInBackground(shop, deps);
    return result;
  });
}

/** The cart reported a date change or removal for this customer (proxy.plan.jsx). */
export async function onCartEvents({ shop, customerId, events, admin }) {
  const relevant = events.filter((event) => event.type === "date_changed" || event.type === "removed");
  if (!relevant.length) return;
  const deps = defaultDeps();
  await queueEmails({ repo, shop, events: relevant.map((event) => ({ ...event, customerId })), admin, deps });
  deliverInBackground(shop, deps);
}

export async function runNightlyForShop(shop, admin = null) {
  const client = admin || (await unauthenticated.admin(shop)).admin;
  return runExclusive(shop, () => runNightlyCheck({ repo, shop, admin: client, deps: defaultDeps() }));
}

/** Every shop with an offline session (installed). One shop failing doesn't stop the others. */
export async function runNightlyForAllShops() {
  const sessions = await prisma.session.findMany({ where: { isOnline: false }, select: { shop: true }, distinct: ["shop"] });
  const results = {};
  for (const { shop } of sessions) {
    try {
      results[shop] = await runNightlyForShop(shop);
    } catch (error) {
      console.error(`[plan] Nightly check failed for ${shop}: ${error.message}`);
      results[shop] = { error: error.message };
      await repo
        .createLogs([
          {
            shop,
            type: "check_run",
            source: "nightly",
            customerId: null,
            productId: null,
            variantId: null,
            title: null,
            details: JSON.stringify({ failed: true, errors: [error.message] }),
            createdAt: new Date(),
          },
        ])
        .catch(() => {});
    }
  }
  return results;
}
