// Read-only views for the admin (pure; the routes load the rows).

import { displayDate, isFutureRelease, SHOP_TIMEZONE } from "./dates.js";

const sum = (list, pick) => list.reduce((total, entry) => total + pick(entry), 0);
const DAY_MS = 24 * 60 * 60 * 1000;

export function formatTime(value, timeZone = SHOP_TIMEZONE) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

/** Whole days from `today` to `date` (both YYYY-MM-DD). */
export function daysUntil(date, today) {
  if (!date || !today) return null;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

export function inDaysLabel(days) {
  if (days === null || days === undefined) return "";
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** "planned" (date in the future), "kept" (released, kept for later) or "available". */
export function itemStatus(item, today) {
  if (isFutureRelease(item.releaseDate, today)) return "planned";
  return item.state === "d" ? "kept" : "available";
}

export const ITEM_STATUS = {
  planned: { label: "Planned", tone: "info" },
  available: { label: "Now orderable", tone: "success" },
  kept: { label: "Kept for later", tone: "neutral" },
};

/** Future ordering dates, oldest first, each with its products. */
export function upcomingReleases(items, today) {
  const byDate = new Map();
  items
    .filter((item) => isFutureRelease(item.releaseDate, today))
    .forEach((item) => {
      if (!byDate.has(item.releaseDate)) byDate.set(item.releaseDate, new Map());
      const products = byDate.get(item.releaseDate);
      const key = item.productId || item.handle;
      if (!products.has(key)) {
        products.set(key, {
          productId: item.productId,
          handle: item.handle,
          title: item.title || item.handle,
          quantity: 0,
          customers: new Set(),
        });
      }
      const product = products.get(key);
      product.quantity += item.quantity;
      product.customers.add(item.customerId);
    });

  return [...byDate.keys()].sort().map((date) => {
    const products = [...byDate.get(date).values()];
    const customers = new Set(products.flatMap((product) => [...product.customers]));
    return {
      date,
      dateDisplay: displayDate(date),
      days: daysUntil(date, today),
      quantity: sum(products, (product) => product.quantity),
      customers: customers.size,
      products: products
        .map((product) => ({ ...product, customers: product.customers.size }))
        .sort((a, b) => b.quantity - a.quantity || a.title.localeCompare(b.title)),
    };
  });
}

/** One row per customer with a plan, most recently changed first. */
export function customerPlans(items, customers, today) {
  const profiles = new Map(customers.map((customer) => [customer.customerId, customer]));
  const byCustomer = new Map();
  items.forEach((item) => {
    if (!byCustomer.has(item.customerId)) byCustomer.set(item.customerId, []);
    byCustomer.get(item.customerId).push(item);
  });

  return [...byCustomer.entries()]
    .map(([customerId, list]) => {
      const profile = profiles.get(customerId);
      const planned = list.filter((item) => isFutureRelease(item.releaseDate, today));
      const futureDates = planned.map((item) => item.releaseDate).sort();
      const lastItemChange = Math.max(...list.map((item) => new Date(item.updatedAt).getTime()));
      const updatedAt = profile?.planUpdatedAt ? new Date(profile.planUpdatedAt).getTime() : lastItemChange;
      return {
        customerId,
        name: profile?.name || null,
        email: profile?.email || null,
        companyName: profile?.companyName || null,
        products: list.length,
        quantity: sum(list, (item) => item.quantity),
        planned: planned.length,
        plannedQuantity: sum(planned, (item) => item.quantity),
        orderable: list.length - planned.length,
        nextDate: futureDates[0] || "",
        nextDateDisplay: displayDate(futureDates[0]),
        updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function customerLabel(customer, customerId) {
  return customer?.name || customer?.email || `Customer ${customerId}`;
}

/** Sort helpers for customer rows (customers without a date or name go last). */
export const compareCustomers = {
  nextDate: (a, b) => (a.nextDate || "9999-99-99").localeCompare(b.nextDate || "9999-99-99"),
  name: (a, b) =>
    customerLabel(a, a.customerId).localeCompare(customerLabel(b, b.customerId), undefined, { sensitivity: "base" }),
};

/** The numbers at the top of the overview. */
export function overviewMetrics({ items, emails, today, now }) {
  const planned = items.filter((item) => isFutureRelease(item.releaseDate, today));
  const waiting = items.filter((item) => !isFutureRelease(item.releaseDate, today));
  const dates = [...new Set(planned.map((item) => item.releaseDate))].sort();
  const next = dates[0] || null;
  const since = now.getTime() - 30 * DAY_MS;
  const recentEmails = emails.filter((email) => new Date(email.createdAt).getTime() >= since);
  const count = (status) => recentEmails.filter((email) => email.status === status).length;
  return {
    customers: new Set(items.map((item) => item.customerId)).size,
    plannedQuantity: sum(planned, (item) => item.quantity),
    plannedProducts: new Set(planned.map((item) => item.productId || item.handle)).size,
    dates: dates.length,
    next: next
      ? {
          date: next,
          dateDisplay: displayDate(next),
          days: daysUntil(next, today),
          products: new Set(planned.filter((i) => i.releaseDate === next).map((i) => i.productId || i.handle)).size,
        }
      : null,
    waitingItems: waiting.length,
    waitingQuantity: sum(waiting, (item) => item.quantity),
    waitingCustomers: new Set(waiting.map((item) => item.customerId)).size,
    emails: { sent: count("sent"), failed: count("failed"), skipped: count("skipped"), pending: count("pending") },
  };
}

// ---- activity ----------------------------------------------------------------------

export const ACTIVITY_KINDS = {
  date_changed: { label: "Date changed", tone: "info" },
  removed: { label: "Removed", tone: "critical" },
  hidden: { label: "Hidden", tone: "warning" },
  handle_changed: { label: "Renamed", tone: "neutral" },
  imported: { label: "Copied from browser", tone: "neutral" },
  check_run: { label: "Nightly check", tone: "success" },
  check_failed: { label: "Nightly check", tone: "critical" },
  email_sent: { label: "Email sent", tone: "success" },
  email_failed: { label: "Email failed", tone: "critical" },
  email_skipped: { label: "Email not sent", tone: "neutral" },
  email_pending: { label: "Email queued", tone: "caution" },
};

export const ACTIVITY_GROUPS = [
  { value: "all", label: "All" },
  { value: "dates", label: "Date changes", kinds: ["date_changed"] },
  { value: "removals", label: "Removals", kinds: ["removed", "hidden"] },
  { value: "emails", label: "Emails", kinds: ["email_sent", "email_failed", "email_skipped", "email_pending"] },
  { value: "checks", label: "Nightly checks", kinds: ["check_run", "check_failed"] },
  { value: "other", label: "Other", kinds: ["handle_changed", "imported"] },
];

export const SOURCES = {
  webhook: "Product updated",
  product_deleted: "Product deleted",
  nightly: "Nightly check",
  cart: "Customer's cart",
  browser: "Customer's browser",
  klaviyo: "Klaviyo",
  admin: "Admin",
};

const REMOVAL_REASONS = {
  deleted: "the product or variant was deleted",
  not_active: "the product is no longer active",
  catalogue: "it is no longer in the customer's catalogue",
  unknown: "the customer's cart couldn't load it",
};

function parseDetails(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

const pieces = (quantity) => (quantity === undefined || quantity === null ? "" : `${quantity} pcs`);

export function describeCheckRun(details) {
  if (details.failed) return `Failed: ${(details.errors || []).join("; ")}`;
  const parts = [
    `${details.items ?? 0} planned items checked`,
    details.dateChanges ? `${details.dateChanges} date changes` : null,
    details.removed ? `${details.removed} removed` : null,
    details.hidden ? `${details.hidden} hidden (removed next night if still hidden)` : null,
    details.emails?.sent ? `${details.emails.sent} emails sent` : null,
    details.emails?.failed ? `${details.emails.failed} emails failed` : null,
    details.catalogueChecked === false && details.items ? "catalogue not checked" : null,
  ].filter(Boolean);
  const errors = details.errors?.length ? ` · Problems: ${details.errors.join("; ")}` : "";
  return parts.join(" · ") + errors;
}

function describeLog(log, details) {
  switch (log.type) {
    case "date_changed": {
      const to = details.to ? displayDate(details.to) : "orderable now";
      return `Ordering date ${displayDate(details.from) || "none"} → ${to}${details.quantity ? ` · ${pieces(details.quantity)}` : ""}`;
    }
    case "removed":
      return `Removed from the plan: ${REMOVAL_REASONS[details.reason] || details.reason || "unknown reason"}${details.quantity ? ` · ${pieces(details.quantity)}` : ""}`;
    case "hidden":
      return "Not in the customer's catalogue tonight. Removed at the next nightly check if still hidden.";
    case "handle_changed":
      return `Product URL changed: ${details.from} → ${details.to}`;
    case "imported":
      return `Plan saved in the browser copied to the app: ${details.added} of ${details.received} products`;
    case "check_run":
      return describeCheckRun(details);
    default:
      return log.type;
  }
}

const EMAIL_LABELS = {
  date_changed: "Ordering date changed",
  removed: "Product removed",
  test: "Test email",
};

/** Activity log rows and email rows as one list, newest first. */
export function activityEntries({ logs, emails, customers }) {
  const names = new Map(customers.map((c) => [c.customerId, customerLabel(c, c.customerId)]));
  const nameFor = (id) => (id ? names.get(id) || `Customer ${id}` : "");

  const fromLogs = logs.map((log) => {
    const details = parseDetails(log.details);
    const kind = log.type === "check_run" && details.failed ? "check_failed" : log.type;
    return {
      key: `log-${log.id ?? `${log.type}-${new Date(log.createdAt).getTime()}`}`,
      at: new Date(log.createdAt).getTime(),
      kind,
      customerId: log.customerId,
      customer: nameFor(log.customerId),
      productId: log.productId,
      product: log.title || "",
      text: describeLog(log, details),
      source: SOURCES[log.source] || log.source || "",
    };
  });

  const fromEmails = emails.map((email) => {
    const kind = `email_${email.status}`;
    const what = EMAIL_LABELS[email.kind] || email.kind;
    const to = email.email ? ` to ${email.email}` : "";
    const detail =
      email.status === "sent"
        ? `${what}${to}`
        : email.status === "pending"
          ? `${what}${to}: waiting to be sent`
          : `${what}${to}: ${email.error || "unknown error"}${email.attempts ? ` (${email.attempts} attempts)` : ""}`;
    return {
      key: `email-${email.id}`,
      at: new Date(email.sentAt || email.lastAttemptAt || email.createdAt).getTime(),
      kind,
      customerId: email.customerId,
      customer: nameFor(email.customerId),
      productId: email.productId,
      product: email.title || "",
      text: detail,
      source: "Klaviyo",
    };
  });

  return [...fromLogs, ...fromEmails].sort((a, b) => b.at - a.at);
}

/** A customer's items for the detail page: planned by date, now orderable, kept for later. */
export function customerItemGroups(items, today) {
  const planned = items
    .filter((item) => itemStatus(item, today) === "planned")
    .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  const dates = [...new Set(planned.map((item) => item.releaseDate))];
  return {
    planned: dates.map((date) => ({
      date,
      dateDisplay: displayDate(date),
      days: daysUntil(date, today),
      items: planned.filter((item) => item.releaseDate === date),
    })),
    available: items.filter((item) => itemStatus(item, today) === "available"),
    kept: items.filter((item) => itemStatus(item, today) === "kept"),
  };
}
