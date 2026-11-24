/* eslint-env node */
// What happens when a product changes, every night, and when emails go out.
// Dependencies come in as arguments (repo, admin, shopify readers, Klaviyo),
// so tests can run every path without Shopify or Klaviyo.

import { shopToday } from "./dates.js";
import { isVisibleToCustomer, noticeFor, planChanges, REMOVAL_CONFIRM_MS } from "./changes.js";
import { buildEmailRows } from "./emails.js";
import { refreshProfileIfStale } from "./profile.js";
import * as shopifyReaders from "./shopify.js";
import { klaviyoConfig, sendKlaviyoEvent } from "./klaviyo.js";

export const MAX_EMAIL_ATTEMPTS = 5;

/**
 * Defaults for production; tests replace any of them.
 * PLANNED_ORDER_REMOVAL_CONFIRM_HOURS (default 20) is how long a product must
 * stay hidden before the next check removes it; 0 lets QA test it at once.
 */
export function defaultDeps(overrides = {}, env = process.env) {
  const hours = Number(env.PLANNED_ORDER_REMOVAL_CONFIRM_HOURS);
  return {
    shopify: shopifyReaders,
    klaviyo: klaviyoConfig(env),
    sendEvent: sendKlaviyoEvent,
    logger: console,
    removalConfirmMs: Number.isFinite(hours) && hours >= 0 && env.PLANNED_ORDER_REMOVAL_CONFIRM_HOURS !== "" ? hours * 3600000 : REMOVAL_CONFIRM_MS,
    ...overrides,
  };
}

const distinct = (list) => [...new Set(list.filter(Boolean))];

function logEntry(shop, event, now) {
  const { from, to, reason, quantity } = event;
  return {
    shop,
    type: event.type,
    source: event.source,
    customerId: event.customerId,
    productId: event.productId ?? null,
    variantId: event.variantIds?.[0] ?? event.variantId ?? null,
    title: event.title ?? null,
    details: JSON.stringify(Object.fromEntries(Object.entries({ from, to, reason, quantity }).filter(([, v]) => v !== undefined))),
    createdAt: now,
  };
}

/** Saves the result of planChanges and leaves a cart message for every event. */
async function commitChanges({ repo, shop, items, result, now, today, notify }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const changedCustomers = new Set();
  result.deletes.forEach((id) => changedCustomers.add(byId.get(id)?.customerId));
  result.updates.forEach(({ id, data }) => {
    if ("releaseDate" in data || "state" in data) changedCustomers.add(byId.get(id)?.customerId);
  });
  changedCustomers.delete(undefined);

  const notices = new Map();
  if (notify) {
    result.events.forEach((event) => {
      if (!notices.has(event.customerId)) notices.set(event.customerId, []);
      notices.get(event.customerId).push(noticeFor(event, today, now));
    });
  }

  const logs = result.events.map((event) => logEntry(shop, event, now));
  // Hidden for the first time: removed only if the next check still can't see it.
  result.updates
    .filter(({ data }) => data.missingSince instanceof Date)
    .forEach(({ id }) => {
      const item = byId.get(id);
      logs.push({
        shop,
        type: "hidden",
        source: "nightly",
        customerId: item.customerId,
        productId: item.productId ?? null,
        variantId: item.variantId,
        title: item.title || item.handle,
        details: JSON.stringify({ quantity: item.quantity }),
        createdAt: now,
      });
    });

  if (!result.updates.length && !result.deletes.length && !logs.length) return;
  await repo.applyChanges(shop, { updates: result.updates, deletes: result.deletes, notices, changedCustomers, logs, now });
}

async function storefrontUrlFor({ repo, shop, admin, settings, deps }) {
  if (settings.storefrontUrl || !admin) return settings.storefrontUrl || null;
  try {
    const url = await deps.shopify.fetchStorefrontUrl(admin);
    if (url) await repo.saveSettings(shop, { storefrontUrl: url });
    return url;
  } catch (error) {
    deps.logger.warn(`[plan] Store URL not loaded: ${error.message}`);
    return null;
  }
}

/** Creates the email rows for `events` (pending, or skipped with the reason). */
export async function queueEmails({ repo, shop, events, admin = null, deps, now = new Date() }) {
  const relevant = events.filter((event) => event.type === "date_changed" || event.type === "removed");
  if (!relevant.length) return [];
  const settings = await repo.getSettings(shop);
  const customerIds = distinct(relevant.map((event) => event.customerId));
  const customers = new Map((await repo.listCustomers(shop, customerIds)).map((c) => [c.customerId, c]));

  // An email address is only needed when the email will really be sent.
  if (settings.emailsEnabled && deps.klaviyo.configured && admin) {
    for (const customerId of customerIds) {
      if (customers.get(customerId)?.email) continue;
      const updated = await refreshProfileIfStale({
        repo,
        shop,
        customerId,
        fetchProfile: (id) => deps.shopify.fetchCustomerProfile(admin, id),
        now,
        logger: deps.logger,
        force: true,
      });
      if (updated) customers.set(customerId, updated);
    }
  }

  const rows = buildEmailRows({
    shop,
    events: relevant,
    customers,
    emailsEnabled: settings.emailsEnabled,
    klaviyoReady: deps.klaviyo.configured,
    storefrontUrl: await storefrontUrlFor({ repo, shop, admin, settings, deps }),
    today: shopToday(now),
  });
  return repo.createEmailEvents(rows);
}

/** Sends pending emails and retries failed ones (up to MAX_EMAIL_ATTEMPTS). */
export async function deliverEmails({ repo, shop, deps, now = new Date() }) {
  const settings = await repo.getSettings(shop);
  const rows = await repo.listDeliverableEmails(shop, MAX_EMAIL_ATTEMPTS);
  const summary = { sent: 0, failed: 0, skipped: 0 };

  for (const row of rows) {
    if (!settings.emailsEnabled || !deps.klaviyo.configured || !row.email) {
      // Switched off (or key removed) after the email was queued: don't send it later by surprise.
      if (row.status === "pending") {
        const reason = !settings.emailsEnabled
          ? "Emails were switched off before sending"
          : !deps.klaviyo.configured
            ? "Klaviyo key is not set (KLAVIYO_PRIVATE_KEY)"
            : "No email address for this customer";
        await repo.updateEmailEvent(row.id, { status: "skipped", error: reason });
        summary.skipped += 1;
      }
      continue;
    }

    const result = await deps.sendEvent({
      key: deps.klaviyo.key,
      metric: row.metric,
      email: row.email,
      properties: JSON.parse(row.properties || "{}"),
      uniqueId: row.uniqueId,
      time: row.createdAt,
    });
    const attempts = row.attempts + 1;
    if (result.ok) {
      await repo.updateEmailEvent(row.id, { status: "sent", error: null, attempts, lastAttemptAt: now, sentAt: now });
      summary.sent += 1;
    } else {
      await repo.updateEmailEvent(row.id, {
        status: "failed",
        error: result.error || `HTTP ${result.status}`,
        attempts: result.retryable ? attempts : MAX_EMAIL_ATTEMPTS,
        lastAttemptAt: now,
      });
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * Webhook / event: a product's ordering date changed, or the product was deleted.
 * Reads the product's current state (deliveries can arrive out of order) and
 * updates every plan that has it.
 */
export async function processProductChange({ repo, shop, productId, deleted = false, admin, deps, now = new Date() }) {
  const items = await repo.listProductItems(shop, productId);
  if (!items.length) return { items: 0, events: [] };

  const variantIds = distinct(items.map((item) => item.variantId));
  const variants = deleted
    ? new Map(variantIds.map((id) => [id, null]))
    : await deps.shopify.lookupVariants(admin, variantIds);

  const today = shopToday(now);
  const result = planChanges({ items, variants, now, today, source: deleted ? "product_deleted" : "webhook" });
  await commitChanges({ repo, shop, items, result, now, today, notify: true });
  await queueEmails({ repo, shop, events: result.events, admin, deps, now });
  return { items: items.length, events: result.events };
}

/** Builds visible(item, state) for the nightly check, or a function that only knows product status. */
async function catalogueVisibility({ admin, items, variants, deps }) {
  try {
    const customerIds = distinct(items.map((item) => item.customerId));
    const locationsByCustomer = await deps.shopify.fetchCustomerLocations(admin, customerIds);
    const locationIds = distinct([...locationsByCustomer.values()].flat());
    const catalogsByLocation = await deps.shopify.fetchLocationCatalogs(admin, locationIds);
    const publicationIds = distinct(
      [...catalogsByLocation.values()].flat().filter((c) => c.status === "ACTIVE").map((c) => c.publicationId),
    );
    const productIds = distinct([...variants.values()].map((state) => state?.productId));
    const publications = await deps.shopify.fetchProductPublications(admin, productIds, publicationIds);
    return {
      checked: true,
      visible: (item, state) =>
        isVisibleToCustomer({
          locations: locationsByCustomer.get(item.customerId) ?? null,
          catalogsByLocation,
          publishedOn: publications.get(state.productId),
          state,
        }),
    };
  } catch (error) {
    deps.logger.warn(`[plan] Catalogue check skipped: ${error.message}`);
    return { checked: false, error: error.message, visible: () => null };
  }
}

/**
 * Nightly check for one shop: ordering dates (in case an event was missed),
 * deleted products, products hidden from the customer's catalogue, customer
 * profiles, and email retries.
 */
export async function runNightlyCheck({ repo, shop, admin, deps, now = new Date() }) {
  const today = shopToday(now);
  const items = await repo.listShopItems(shop);
  const summary = { items: items.length, dateChanges: 0, removed: 0, hidden: 0, catalogueChecked: false, errors: [] };

  if (items.length) {
    const variantIds = distinct(items.map((item) => item.variantId));
    const variants = await deps.shopify.lookupVariants(admin, variantIds, { skipFailedChunks: true, logger: deps.logger });
    if (variants.size < variantIds.length) summary.errors.push(`${variantIds.length - variants.size} variants couldn't be loaded`);

    const catalogue = await catalogueVisibility({ admin, items, variants, deps });
    summary.catalogueChecked = catalogue.checked;
    if (catalogue.error) summary.errors.push(`Catalogue check: ${catalogue.error}`);

    const result = planChanges({
      items,
      variants,
      visible: catalogue.visible,
      now,
      today,
      source: "nightly",
      confirmMs: deps.removalConfirmMs ?? REMOVAL_CONFIRM_MS,
    });
    await commitChanges({ repo, shop, items, result, now, today, notify: true });
    summary.dateChanges = result.events.filter((e) => e.type === "date_changed").length;
    summary.removed = result.events.filter((e) => e.type === "removed").length;
    summary.hidden = result.updates.filter(({ data }) => data.missingSince instanceof Date).length;

    for (const customerId of distinct(items.map((item) => item.customerId))) {
      await refreshProfileIfStale({
        repo,
        shop,
        customerId,
        fetchProfile: (id) => deps.shopify.fetchCustomerProfile(admin, id),
        now,
        logger: deps.logger,
      });
    }
    await queueEmails({ repo, shop, events: result.events, admin, deps, now });
  }

  summary.emails = await deliverEmails({ repo, shop, deps, now });
  await repo.createLogs([
    {
      shop,
      type: "check_run",
      source: "nightly",
      customerId: null,
      productId: null,
      variantId: null,
      title: null,
      details: JSON.stringify(summary),
      createdAt: now,
    },
  ]);
  return summary;
}
