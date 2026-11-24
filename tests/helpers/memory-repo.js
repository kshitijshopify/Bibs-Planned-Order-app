// In-memory stand-in for app/planned/repo.server.js.
import { parseNotices, pushNotice } from "../../app/planned/plan.js";

const DEFAULT_SETTINGS = { emailsEnabled: false, storefrontUrl: null, updatedBy: null, updatedAt: null };

export function createMemoryRepo() {
  let nextId = 1;
  let nextEmailId = 1;
  const items = [];
  const customers = new Map();
  const logs = [];
  const settings = new Map();
  const emails = [];
  const key = (shop, customerId) => `${shop}|${customerId}`;

  const repo = {
    items,
    customers,
    logs,
    settings,
    emails,

    /** Test helper: adds a plan item directly. */
    seedItem(data) {
      const now = new Date("2026-11-01T10:00:00Z");
      const row = {
        id: nextId++,
        productId: null,
        title: "",
        releaseDate: "",
        state: "p",
        missingSince: null,
        addedAt: now,
        updatedAt: now,
        ...data,
      };
      items.push(row);
      return row;
    },

    async listShopItems(shop) {
      return items.filter((item) => item.shop === shop).map((item) => ({ ...item }));
    },

    async listProductItems(shop, productId) {
      return items.filter((item) => item.shop === shop && item.productId === productId).map((item) => ({ ...item }));
    },

    async listShopsWithPlans() {
      return [...new Set(items.map((item) => item.shop))];
    },

    async listCustomers(shop, customerIds) {
      return [...customers.values()]
        .filter((c) => c.shop === shop && (!customerIds || customerIds.includes(c.customerId)))
        .map((c) => ({ ...c }));
    },

    async getSettings(shop) {
      return { shop, ...DEFAULT_SETTINGS, ...(settings.get(shop) || {}) };
    },

    async saveSettings(shop, data) {
      const row = { ...(settings.get(shop) || {}), ...data, updatedAt: new Date() };
      settings.set(shop, row);
      return { shop, ...row };
    },

    async applyChanges(shop, { updates, deletes, notices, changedCustomers, logs: entries, now }) {
      for (const { id, data } of updates) {
        const row = items.find((item) => item.id === id);
        if (row) Object.assign(row, data, { updatedAt: now });
      }
      for (const id of deletes) {
        const index = items.findIndex((item) => item.id === id);
        if (index !== -1) items.splice(index, 1);
      }
      for (const customerId of new Set([...changedCustomers, ...notices.keys()])) {
        const existing = await repo.getCustomer(shop, customerId);
        let list = parseNotices(existing?.notices);
        (notices.get(customerId) || []).forEach((notice) => {
          list = pushNotice(list, notice);
        });
        const data = { notices: JSON.stringify(list) };
        if (changedCustomers.has(customerId)) data.planUpdatedAt = now;
        await repo.upsertCustomer(shop, customerId, data);
      }
      logs.push(...entries);
    },

    async createEmailEvents(rows) {
      const fresh = [];
      for (const row of rows) {
        if (emails.some((e) => e.shop === row.shop && e.uniqueId === row.uniqueId)) continue;
        const created = { id: nextEmailId++, attempts: 0, sentAt: null, lastAttemptAt: null, createdAt: new Date(), ...row };
        emails.push(created);
        fresh.push(created);
      }
      return fresh;
    },

    async listDeliverableEmails(shop, maxAttempts) {
      return emails
        .filter((e) => e.shop === shop && (e.status === "pending" || (e.status === "failed" && e.attempts < maxAttempts)))
        .map((e) => ({ ...e }));
    },

    async updateEmailEvent(id, data) {
      Object.assign(emails.find((e) => e.id === id), data);
    },

    async deleteCustomerData(shop, customerId) {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].shop === shop && items[i].customerId === customerId) items.splice(i, 1);
      }
      customers.delete(key(shop, customerId));
      for (let i = emails.length - 1; i >= 0; i -= 1) {
        if (emails[i].shop === shop && emails[i].customerId === customerId) emails.splice(i, 1);
      }
    },

    async listItems(shop, customerId) {
      return items
        .filter((item) => item.shop === shop && item.customerId === customerId)
        .sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt) || a.id - b.id)
        .map((item) => ({ ...item }));
    },

    async createItem(data) {
      const now = new Date();
      const row = { id: nextId++, addedAt: now, ...data, updatedAt: now };
      items.push(row);
      return { ...row };
    },

    async updateItem(id, data) {
      const row = items.find((item) => item.id === id);
      if (!row) throw new Error(`No item ${id}`);
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },

    async deleteItem(id) {
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) throw new Error(`No item ${id}`);
      items.splice(index, 1);
    },

    async getCustomer(shop, customerId) {
      const customer = customers.get(key(shop, customerId));
      return customer ? { ...customer } : null;
    },

    async upsertCustomer(shop, customerId, data) {
      const id = key(shop, customerId);
      const existing = customers.get(id);
      const row = existing
        ? Object.assign(existing, data, { updatedAt: new Date() })
        : {
            shop,
            customerId,
            name: null,
            email: null,
            companyName: null,
            profileAt: null,
            notices: "[]",
            planUpdatedAt: null,
            migratedAt: null,
            createdAt: new Date(),
            ...data,
            updatedAt: new Date(),
          };
      customers.set(id, row);
      return { ...row };
    },

    async createLogs(entries) {
      logs.push(...entries);
    },

    async transaction(fn) {
      return fn(repo);
    },
  };
  return repo;
}
