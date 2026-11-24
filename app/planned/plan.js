// A customer's planned order on the server: read it, apply the theme's
// operations (see ops.js) and save the result in one transaction.
//
// `repo` is the storage (repo.server.js for Prisma, a memory repo in tests).
// `lookupVariants(ids)` asks Shopify about variants and returns a Map:
//   id -> { productId, handle, title, status, releaseDate }   variant exists
//   id -> null                                                variant doesn't exist
// Ids missing from the map (or a failed lookup) fall back to the theme's data.

import { LIMITS } from "./ops.js";
import { displayDate } from "./dates.js";
import { isLiveStatus } from "./shopify.js";

export const MAX_NOTICES = 20;
const ITEM_FIELDS = ["productId", "handle", "title", "quantity", "releaseDate", "state", "addedAt"];

export function parseNotices(text) {
  try {
    const list = JSON.parse(text || "[]");
    return Array.isArray(list) ? list.filter((notice) => notice && typeof notice.id === "string") : [];
  } catch {
    return [];
  }
}

/** Adds a cart message; keeps the newest MAX_NOTICES. */
export function pushNotice(notices, notice) {
  return [...notices.filter((existing) => existing.id !== notice.id), notice].slice(-MAX_NOTICES);
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const byTime = new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime();
    return byTime || String(a.variantId).localeCompare(String(b.variantId));
  });
}

/** Variant ids worth asking Shopify about before applying `ops`. */
export function variantsToLookUp(ops, currentItems) {
  const known = new Map(currentItems.map((item) => [item.variantId, item]));
  const ids = new Set();
  ops.forEach((op) => {
    if (op.op === "add" && !known.get(op.v)?.productId) ids.add(op.v);
    else if (op.op === "import") op.items.forEach((item) => !known.has(item.v) && ids.add(item.v));
    else if (op.op === "remove" && op.reason === "missing" && known.has(op.v)) ids.add(op.v);
  });
  return [...ids];
}

/** Same shape as the events of changes.js, so both can be logged and emailed alike. */
function eventFor(item, type, source, details) {
  return {
    type,
    source,
    variantId: item.variantId,
    productId: item.productId ?? null,
    title: item.title || item.handle,
    handle: item.handle,
    quantity: item.quantity,
    addedAt: item.addedAt,
    ...details,
    details,
  };
}

function applyAdd(state, op, lookup, now) {
  const info = lookup?.get(op.v);
  if (info === null) {
    state.rejected.push({ op: "add", v: op.v, error: "variant not found" });
    return;
  }

  const existing = state.items.get(op.v);
  if (existing) {
    existing.quantity = Math.min(LIMITS.maxQuantity, existing.quantity + op.q);
    existing.state = "p";
    existing.productId = info?.productId ?? existing.productId;
    existing.handle = info?.handle || op.h || existing.handle;
    existing.title = info?.title || op.ti || existing.title;
    existing.releaseDate = info ? info.releaseDate : op.r;
    return;
  }

  const handle = info?.handle || op.h;
  if (!handle) {
    state.rejected.push({ op: "add", v: op.v, error: "missing product handle" });
    return;
  }
  if (state.items.size >= LIMITS.maxItems) {
    state.rejected.push({ op: "add", v: op.v, error: "planned order is full" });
    return;
  }
  state.items.set(op.v, {
    variantId: op.v,
    productId: info?.productId ?? null,
    handle,
    title: info?.title || op.ti || "",
    quantity: op.q,
    releaseDate: info ? info.releaseDate : op.r,
    state: "p",
    addedAt: now,
  });
}

function applyPatch(state, op) {
  const item = state.items.get(op.v);
  if (!item) {
    state.rejected.push({ op: "patch", v: op.v, error: "not in the planned order" });
    return;
  }
  if (op.q != null) item.quantity = op.q;
  if (op.s) item.state = op.s;
  if (op.h) item.handle = op.h;
  if (op.ti) item.title = op.ti;
  if (op.r !== undefined && op.r !== item.releaseDate) {
    // Only the cart's check against Shopify is a real date change; other
    // patches just carry what the page showed.
    if (op.reason === "reconcile") {
      state.events.push(eventFor(item, "date_changed", "cart", { from: item.releaseDate, to: op.r }));
    }
    item.releaseDate = op.r;
  }
}

function applyRemove(state, op, lookup) {
  const item = state.items.get(op.v);
  if (!item) return;

  if (op.reason === "missing") {
    // The cart couldn't load the product for this customer. A renamed product
    // (new handle) is not a removal: keep it under the new handle.
    const info = lookup?.get(op.v);
    if (info && isLiveStatus(info.status) && info.handle && info.handle !== item.handle) {
      state.events.push(eventFor(item, "handle_changed", "cart", { from: item.handle, to: info.handle }));
      item.handle = info.handle;
      item.title = info.title || item.title;
      item.productId = info.productId ?? item.productId;
      return;
    }
    let reason = "unknown";
    if (info === null) reason = "deleted";
    else if (info && !isLiveStatus(info.status)) reason = "not_active";
    else if (info) reason = "catalogue";
    state.events.push(eventFor(item, "removed", "cart", { reason, quantity: item.quantity }));
  }
  state.items.delete(op.v);
}

function applyImport(state, op, lookup, now) {
  let added = 0;
  op.items.forEach((entry) => {
    if (state.items.has(entry.v) || state.items.size >= LIMITS.maxItems) return;
    const info = lookup?.get(entry.v);
    if (info === null) return;
    const handle = info?.handle || entry.h;
    if (!handle) return;
    state.items.set(entry.v, {
      variantId: entry.v,
      productId: info?.productId ?? null,
      handle,
      title: info?.title || entry.ti || "",
      quantity: entry.q,
      // Keep the date the customer last saw, so the cart still reports a change.
      releaseDate: entry.r,
      state: entry.s,
      addedAt: entry.a ? new Date(entry.a) : now,
    });
    added += 1;
  });
  state.migrated = true;
  state.events.push({
    type: "imported",
    source: "browser",
    details: { added, received: op.items.length },
  });
}

function applyOp(state, op, lookup, now) {
  switch (op.op) {
    case "add":
      return applyAdd(state, op, lookup, now);
    case "patch":
      return applyPatch(state, op);
    case "remove":
      return applyRemove(state, op, lookup);
    case "import":
      return applyImport(state, op, lookup, now);
    case "ack":
      state.notices = state.notices.filter((notice) => !op.ids.includes(notice.id));
      return undefined;
    default:
      return undefined;
  }
}

function changedFields(before, after) {
  const diff = {};
  ITEM_FIELDS.forEach((field) => {
    const a = before[field] instanceof Date ? before[field].getTime() : before[field];
    const b = after[field] instanceof Date ? after[field].getTime() : after[field];
    if ((a ?? null) !== (b ?? null)) diff[field] = after[field];
  });
  return diff;
}

function pickItem(item) {
  return Object.fromEntries(ITEM_FIELDS.map((field) => [field, item[field]]));
}

export async function getPlan({ repo, shop, customerId }) {
  const [items, customer] = await Promise.all([
    repo.listItems(shop, customerId),
    repo.getCustomer(shop, customerId),
  ]);
  return { items: sortItems(items), notices: parseNotices(customer?.notices) };
}

export async function updatePlan({
  repo,
  shop,
  customerId,
  ops,
  lookupVariants,
  now = new Date(),
  logger = console,
}) {
  const ids = variantsToLookUp(ops, await repo.listItems(shop, customerId));
  let lookup = null;
  if (ids.length && lookupVariants) {
    try {
      lookup = await lookupVariants(ids);
    } catch (error) {
      logger.warn(`[plan] Shopify variant lookup failed, using the theme's data: ${error.message}`);
    }
  }

  return repo.transaction(async (tx) => {
    const current = await tx.listItems(shop, customerId);
    const customer = await tx.getCustomer(shop, customerId);
    const original = new Map(current.map((item) => [item.variantId, item]));
    const state = {
      items: new Map(current.map((item) => [item.variantId, { ...item }])),
      notices: parseNotices(customer?.notices),
      migrated: false,
      events: [],
      rejected: [],
    };

    ops.forEach((op) => applyOp(state, op, lookup, now));

    let changed = false;
    for (const [variantId, item] of original) {
      if (!state.items.has(variantId)) {
        await tx.deleteItem(item.id);
        changed = true;
      }
    }
    for (const [variantId, item] of state.items) {
      const before = original.get(variantId);
      if (!before) {
        const created = await tx.createItem({ shop, customerId, variantId, ...pickItem(item) });
        item.id = created.id;
        changed = true;
        continue;
      }
      const diff = changedFields(before, item);
      if (Object.keys(diff).length) {
        await tx.updateItem(before.id, diff);
        changed = true;
      }
    }

    const notices = JSON.stringify(state.notices);
    const customerData = {};
    if (!customer || notices !== (customer.notices ?? "[]")) customerData.notices = notices;
    if (state.migrated && !customer?.migratedAt) customerData.migratedAt = now;
    if (changed) customerData.planUpdatedAt = now;
    if (!customer || Object.keys(customerData).length) {
      await tx.upsertCustomer(shop, customerId, customerData);
    }

    if (state.events.length) {
      await tx.createLogs(
        state.events.map((event) => ({
          shop,
          customerId,
          type: event.type,
          source: event.source,
          variantId: event.variantId ?? null,
          productId: event.productId ?? null,
          title: event.title ?? null,
          details: JSON.stringify(event.details || {}),
          createdAt: now,
        })),
      );
    }

    return {
      items: sortItems(state.items.values()),
      notices: state.notices,
      events: state.events,
      rejected: state.rejected,
      changed,
    };
  });
}

/** The theme's format: { v, h, q, r, ti, s, a } plus cart messages. */
export function toClientPlan({ items, notices }) {
  return {
    items: items.map((item) => ({
      v: Number(item.variantId),
      h: item.handle,
      q: item.quantity,
      r: item.releaseDate || "",
      ti: item.title || "",
      s: item.state === "d" ? "d" : "p",
      a: new Date(item.addedAt).getTime(),
    })),
    notices: notices.map((notice) => ({
      id: notice.id,
      type: notice.type,
      title: notice.title || "",
      date: notice.date || "",
      dateDisplay: displayDate(notice.date),
    })),
  };
}
