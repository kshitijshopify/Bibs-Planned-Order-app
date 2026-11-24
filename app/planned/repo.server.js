// Prisma storage for plan.js and jobs.js. Every method can run inside a transaction.
// tests/helpers/memory-repo.js implements the same methods for the tests.

import prisma from "../db.server";
import { parseNotices, pushNotice } from "./plan.js";

export const DEFAULT_SETTINGS = { emailsEnabled: false, storefrontUrl: null, updatedBy: null, updatedAt: null };

function methods(db) {
  return {
    // ---- one customer's plan (plan.js) ----
    listItems: (shop, customerId) =>
      db.planItem.findMany({
        where: { shop, customerId },
        orderBy: [{ addedAt: "asc" }, { id: "asc" }],
      }),
    createItem: (data) => db.planItem.create({ data }),
    updateItem: (id, data) => db.planItem.update({ where: { id }, data }),
    deleteItem: (id) => db.planItem.delete({ where: { id } }),
    getCustomer: (shop, customerId) =>
      db.planCustomer.findUnique({ where: { shop_customerId: { shop, customerId } } }),
    upsertCustomer: (shop, customerId, data) =>
      db.planCustomer.upsert({
        where: { shop_customerId: { shop, customerId } },
        create: { shop, customerId, ...data },
        update: data,
      }),
    createLogs: (entries) => (entries.length ? db.activityLog.createMany({ data: entries }) : null),

    // ---- whole shop (jobs.js) ----
    listShopItems: (shop) => db.planItem.findMany({ where: { shop }, orderBy: { id: "asc" } }),
    listProductItems: (shop, productId) => db.planItem.findMany({ where: { shop, productId }, orderBy: { id: "asc" } }),
    listShopsWithPlans: async () =>
      (await db.planItem.findMany({ distinct: ["shop"], select: { shop: true } })).map((row) => row.shop),
    listCustomers: (shop, customerIds) =>
      db.planCustomer.findMany({ where: { shop, ...(customerIds ? { customerId: { in: customerIds } } : {}) } }),

    getSettings: async (shop) => ({
      shop,
      ...DEFAULT_SETTINGS,
      ...((await db.appSettings.findUnique({ where: { shop } })) || {}),
    }),
    saveSettings: (shop, data) =>
      db.appSettings.upsert({ where: { shop }, create: { shop, ...data }, update: data }),

    /** Saves the result of changes.js in one go: items, cart messages, "last update", activity. */
    applyChanges: (shop, { updates, deletes, notices, changedCustomers, logs, now }) =>
      runTransaction(db, async (tx) => {
        for (const { id, data } of updates) await tx.planItem.update({ where: { id }, data });
        if (deletes.length) await tx.planItem.deleteMany({ where: { id: { in: deletes } } });
        const customers = new Set([...changedCustomers, ...notices.keys()]);
        for (const customerId of customers) {
          const existing = await tx.planCustomer.findUnique({ where: { shop_customerId: { shop, customerId } } });
          let list = parseNotices(existing?.notices);
          (notices.get(customerId) || []).forEach((notice) => {
            list = pushNotice(list, notice);
          });
          const data = { notices: JSON.stringify(list) };
          if (changedCustomers.has(customerId)) data.planUpdatedAt = now;
          await tx.planCustomer.upsert({
            where: { shop_customerId: { shop, customerId } },
            create: { shop, customerId, ...data },
            update: data,
          });
        }
        if (logs.length) await tx.activityLog.createMany({ data: logs });
      }),

    /** Adds email rows; a row whose uniqueId already exists is left alone. Returns the new rows. */
    createEmailEvents: async (rows) => {
      if (!rows.length) return [];
      const shop = rows[0].shop;
      const existing = await db.emailEvent.findMany({
        where: { shop, uniqueId: { in: rows.map((row) => row.uniqueId) } },
        select: { uniqueId: true },
      });
      const seen = new Set(existing.map((row) => row.uniqueId));
      const fresh = rows.filter((row) => !seen.has(row.uniqueId) && seen.add(row.uniqueId));
      if (fresh.length) await db.emailEvent.createMany({ data: fresh });
      return fresh;
    },
    listDeliverableEmails: (shop, maxAttempts) =>
      db.emailEvent.findMany({
        where: {
          shop,
          OR: [{ status: "pending" }, { status: "failed", attempts: { lt: maxAttempts } }],
        },
        orderBy: { id: "asc" },
        take: 500,
      }),
    updateEmailEvent: (id, data) => db.emailEvent.update({ where: { id }, data }),

    /** customers/delete: the customer's plan, messages and email rows go. */
    deleteCustomerData: (shop, customerId) =>
      runTransaction(db, async (tx) => {
        await tx.planItem.deleteMany({ where: { shop, customerId } });
        await tx.planCustomer.deleteMany({ where: { shop, customerId } });
        await tx.emailEvent.deleteMany({ where: { shop, customerId } });
      }),
  };
}

// Inside an interactive transaction `db` has no $transaction: run directly.
function runTransaction(db, fn) {
  return typeof db.$transaction === "function" ? db.$transaction(fn) : fn(db);
}

export function prismaRepo(client = prisma) {
  return {
    ...methods(client),
    transaction: (fn) => client.$transaction((tx) => fn(methods(tx))),
  };
}
