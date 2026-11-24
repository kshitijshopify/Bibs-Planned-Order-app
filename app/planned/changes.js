// Compares planned items with Shopify's current products and decides what
// changes: new ordering dates, removals, renamed products. Pure: the caller
// loads the data and saves the result (jobs.server.js).
//
// Removals that come from a catalogue check need two checks in a row: the
// first marks the item (missingSince), the next one at least `confirmMs` later
// removes it. A product unpublished by mistake for a few hours is not removed.

import { isFutureRelease } from "./dates.js";
import { isLiveStatus } from "./shopify.js";

export const REMOVAL_CONFIRM_MS = 20 * 60 * 60 * 1000;

function productKey(item, state) {
  return state?.productId || item.productId || `handle:${item.handle}`;
}

/**
 * @param items     PlanItem rows of one shop
 * @param variants  Map variantId -> product state | null (deleted); ids missing from the map are skipped
 * @param visible   optional (item, state) => true | false | null; only the nightly check passes it
 * @returns { updates: [{ id, data }], deletes: [id], events: [...] } with one event per customer, product and change
 */
export function planChanges({ items, variants, visible = null, now, today, source, confirmMs = REMOVAL_CONFIRM_MS }) {
  const updates = [];
  const deletes = [];
  const groups = new Map();

  const addEvent = (item, state, type, extra) => {
    const key = `${item.customerId}|${productKey(item, state)}|${type}`;
    let event = groups.get(key);
    if (!event) {
      event = {
        type,
        source,
        customerId: item.customerId,
        productId: state?.productId ?? item.productId ?? null,
        title: state?.title || item.title || item.handle,
        handle: state?.handle || item.handle,
        imageUrl: state?.imageUrl || null,
        quantity: 0,
        variantIds: [],
        addedAt: item.addedAt,
        ...extra,
      };
      groups.set(key, event);
    }
    event.quantity += item.quantity;
    event.variantIds.push(item.variantId);
    if (new Date(item.addedAt) < new Date(event.addedAt)) event.addedAt = item.addedAt;
  };

  for (const item of items) {
    if (!variants.has(item.variantId)) continue;
    const state = variants.get(item.variantId);

    if (state === null) {
      deletes.push(item.id);
      addEvent(item, null, "removed", { reason: "deleted" });
      continue;
    }

    const data = {};
    if (state.productId && state.productId !== item.productId) data.productId = state.productId;
    if (state.handle && state.handle !== item.handle) data.handle = state.handle;
    if (state.title && state.title !== item.title) data.title = state.title;

    if (visible) {
      const seen = isLiveStatus(state.status) ? visible(item, state) : false;
      if (seen === false) {
        const since = item.missingSince ? new Date(item.missingSince).getTime() : null;
        if (since === null) {
          data.missingSince = now;
        } else if (now.getTime() - since >= confirmMs) {
          deletes.push(item.id);
          addEvent(item, state, "removed", { reason: isLiveStatus(state.status) ? "catalogue" : "not_active" });
          continue;
        }
      } else if (seen === true && item.missingSince) {
        data.missingSince = null;
      }
    }

    if (state.releaseDate !== item.releaseDate) {
      data.releaseDate = state.releaseDate;
      // A product moved back to a future date is planned again, not "kept for later".
      if (item.state === "d" && isFutureRelease(state.releaseDate, today)) data.state = "p";
      addEvent(item, state, "date_changed", { from: item.releaseDate, to: state.releaseDate });
    }

    if (Object.keys(data).length) updates.push({ id: item.id, data });
  }

  return { updates, deletes, events: [...groups.values()] };
}

/** Cart message for an event (shown once, next time the customer opens the cart). */
export function noticeFor(event, today, now) {
  const orderableNow = event.type === "date_changed" && !isFutureRelease(event.to, today);
  return {
    id: `${event.type}:${event.productId || event.handle}:${event.to ?? ""}:${now.getTime()}`,
    type: orderableNow ? "now_available" : event.type,
    title: event.title,
    date: event.type === "date_changed" ? event.to || "" : "",
    at: now.toISOString(),
  };
}

/**
 * Catalogue visibility for B2B contacts (pure; data from shopify.js).
 * Visible when any company location the customer buys for has an ACTIVE
 * catalog whose publication includes the product. A catalog without a
 * publication follows the sales channel (Online Store), as Shopify documents.
 *
 * Returns true, false, or null when it can't be decided safely (then nothing
 * is removed): customers who aren't B2B contacts, locations without an active
 * catalog, or data that couldn't be loaded. The theme's cart check still
 * covers those customers.
 */
export function isVisibleToCustomer({ locations, catalogsByLocation, publishedOn, state }) {
  if (!isLiveStatus(state.status)) return false;
  if (!locations || !locations.length) return null;
  const onlineStore = Boolean(state.onlineStoreUrl);

  let unknown = false;
  for (const locationId of locations) {
    const catalogs = catalogsByLocation.get(locationId);
    const active = (catalogs || []).filter((catalog) => catalog.status === "ACTIVE");
    if (!active.length) {
      unknown = true;
      continue;
    }
    for (const catalog of active) {
      if (!catalog.publicationId) {
        if (onlineStore) return true;
        continue;
      }
      const published = publishedOn?.get(catalog.publicationId);
      if (published === true) return true;
      if (published === undefined) unknown = true;
    }
  }
  return unknown ? null : false;
}
