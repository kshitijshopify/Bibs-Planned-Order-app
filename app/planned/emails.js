// Turns plan events (date changed, removed) into customer email rows
// (EmailEvent) with the Klaviyo event properties. Pure.
//
// Removal emails only name the product: the brief asks not to show details of
// a product the customer can no longer see, or the reason.

import { displayDate, isFutureRelease } from "./dates.js";
import { METRICS } from "./metrics.js";

export const EMAIL_KINDS = ["date_changed", "removed"];

function productKey(event) {
  return event.productId || `handle:${event.handle}`;
}

export function uniqueIdFor(event, customerId) {
  if (event.type === "date_changed") {
    return `planned-order:date:${customerId}:${productKey(event)}:${event.from || "none"}>${event.to || "none"}`;
  }
  // The same product can be planned and removed again later: the time it was added tells them apart.
  const added = event.addedAt ? new Date(event.addedAt).getTime() : 0;
  return `planned-order:removed:${customerId}:${productKey(event)}:${added}`;
}

export function propertiesFor(event, { storefrontUrl, today }) {
  const cartUrl = storefrontUrl ? `${storefrontUrl}/cart` : null;
  if (event.type === "removed") {
    return {
      ProductTitle: event.title,
      Quantity: event.quantity,
      CartURL: cartUrl,
    };
  }
  return {
    ProductTitle: event.title,
    ProductHandle: event.handle,
    ProductURL: storefrontUrl && event.handle ? `${storefrontUrl}/products/${event.handle}` : null,
    ProductImageURL: event.imageUrl || null,
    Quantity: event.quantity,
    PreviousDate: event.from || "",
    PreviousDateFormatted: displayDate(event.from),
    NewDate: event.to || "",
    NewDateFormatted: displayDate(event.to),
    OrderableNow: !isFutureRelease(event.to, today),
    CartURL: cartUrl,
  };
}

/**
 * One row per customer event. Rows that won't be sent are kept as "skipped"
 * with the reason, so the admin shows who would have been emailed.
 *
 * customers: Map customerId -> { email }
 */
export function buildEmailRows({ shop, events, customers, emailsEnabled, klaviyoReady, storefrontUrl, today }) {
  return events
    .filter((event) => EMAIL_KINDS.includes(event.type) && event.customerId)
    .map((event) => {
      const email = customers.get(event.customerId)?.email || null;
      let skip = null;
      if (!emailsEnabled) skip = "Emails are switched off in Settings";
      else if (!klaviyoReady) skip = "Klaviyo key is not set (KLAVIYO_PRIVATE_KEY)";
      else if (!email) skip = "No email address for this customer";
      return {
        shop,
        customerId: event.customerId,
        email,
        kind: event.type,
        metric: METRICS[event.type],
        uniqueId: uniqueIdFor(event, event.customerId),
        productId: event.productId || null,
        title: event.title || null,
        properties: JSON.stringify(propertiesFor(event, { storefrontUrl, today })),
        status: skip ? "skipped" : "pending",
        error: skip,
      };
    });
}
