import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverEmails, MAX_EMAIL_ATTEMPTS, processProductChange, queueEmails, runNightlyCheck } from "../app/planned/jobs.js";
import { REMOVAL_CONFIRM_MS } from "../app/planned/changes.js";
import { parseOps } from "../app/planned/ops.js";
import { updatePlan } from "../app/planned/plan.js";
import { createMemoryRepo } from "./helpers/memory-repo.js";

const SHOP = "bibs-dev.myshopify.com";
const NOW = new Date("2026-11-18T01:00:00Z");
const silent = { warn() {}, error() {}, log() {} };

const product = (extra = {}) => ({
  productId: "900",
  handle: "pacifier",
  title: "Pacifier",
  status: "ACTIVE",
  onlineStoreUrl: "https://dist/products/pacifier",
  imageUrl: "https://cdn/p.jpg",
  releaseDate: "2027-02-15",
  ...extra,
});

function fakeShopify(data = {}) {
  const calls = [];
  const pick = (source, ids) => new Map(ids.filter((id) => id in source).map((id) => [id, source[id]]));
  return {
    calls,
    async lookupVariants(admin, ids) {
      calls.push(["lookupVariants", ids]);
      if (data.failLookup) throw new Error("lookup down");
      return pick(data.variants || {}, ids);
    },
    async fetchCustomerLocations(admin, ids) {
      if (data.failCatalogue) throw new Error("catalogue down");
      return pick(data.locations || {}, ids);
    },
    async fetchLocationCatalogs(admin, ids) {
      return pick(data.catalogs || {}, ids);
    },
    async fetchProductPublications(admin, productIds) {
      return new Map(productIds.map((id) => [id, new Map(Object.entries(data.publications?.[id] || {}))]));
    },
    async fetchCustomerProfile(admin, id) {
      calls.push(["fetchCustomerProfile", id]);
      if (data.failProfile) throw new Error("not approved");
      return data.profiles?.[id] ?? null;
    },
    async fetchStorefrontUrl() {
      return "https://dist.bibs.com";
    },
  };
}

function setup({ shopify = {}, emailsEnabled = true, configured = true, sendResult } = {}) {
  const repo = createMemoryRepo();
  if (emailsEnabled) repo.settings.set(SHOP, { emailsEnabled: true });
  const sent = [];
  const deps = {
    shopify: fakeShopify(shopify),
    klaviyo: { configured, key: "pk_test_1234567890" },
    sendEvent: async (args) => {
      sent.push(args);
      return typeof sendResult === "function" ? sendResult(args, sent.length) : { ok: true, status: 202 };
    },
    logger: silent,
  };
  return { repo, deps, sent };
}

async function customer(repo, customerId, email) {
  await repo.upsertCustomer(SHOP, customerId, { email, name: `Customer ${customerId}`, profileAt: NOW });
}

const seed = (repo, customerId, variantId, extra = {}) =>
  repo.seedItem({ shop: SHOP, customerId, variantId, productId: "900", handle: "pacifier", title: "Pacifier", quantity: 6, releaseDate: "2027-02-15", ...extra });

// ---- product events ------------------------------------------------------------------

test("a new ordering date reaches every plan: date, cart message, activity and one email each", async () => {
  const { repo, deps, sent } = setup({ shopify: { variants: { 11: product({ releaseDate: "2027-03-01" }), 12: product({ releaseDate: "2027-03-01" }) } } });
  seed(repo, "1", "11");
  seed(repo, "1", "12", { quantity: 4 });
  seed(repo, "2", "11", { quantity: 3 });
  await customer(repo, "1", "mette@example.com");
  await customer(repo, "2", "lars@example.com");

  const result = await processProductChange({ repo, shop: SHOP, productId: "900", admin: {}, deps, now: NOW });
  assert.equal(result.events.length, 2);
  assert.deepEqual(repo.items.map((i) => i.releaseDate), ["2027-03-01", "2027-03-01", "2027-03-01"]);

  const notices = JSON.parse(repo.customers.get(`${SHOP}|1`).notices);
  assert.deepEqual(notices.map((n) => [n.type, n.title, n.date]), [["date_changed", "Pacifier", "2027-03-01"]]);
  assert.equal(repo.customers.get(`${SHOP}|1`).planUpdatedAt, NOW);
  assert.deepEqual(repo.logs.map((l) => [l.type, l.source, l.customerId]), [
    ["date_changed", "webhook", "1"],
    ["date_changed", "webhook", "2"],
  ]);

  assert.deepEqual(repo.emails.map((e) => [e.customerId, e.status]), [["1", "pending"], ["2", "pending"]]);
  const summary = await deliverEmails({ repo, shop: SHOP, deps, now: NOW });
  assert.deepEqual(summary, { sent: 2, failed: 0, skipped: 0 });
  assert.equal(sent[0].metric, "Planned Order Date Changed");
  assert.equal(sent[0].email, "mette@example.com");
  assert.equal(sent[0].properties.Quantity, 10);
  assert.equal(sent[0].properties.ProductURL, "https://dist.bibs.com/products/pacifier");
  assert.equal(sent[0].uniqueId, "planned-order:date:1:900:2027-02-15>2027-03-01");
  assert.deepEqual(repo.emails.map((e) => e.status), ["sent", "sent"]);

  // The same event delivered again changes nothing and sends nothing.
  const again = await processProductChange({ repo, shop: SHOP, productId: "900", admin: {}, deps, now: NOW });
  assert.equal(again.events.length, 0);
  assert.equal(repo.emails.length, 2);
});

test("a deleted product leaves every plan with a removal email that only names it", async () => {
  const { repo, deps, sent } = setup();
  seed(repo, "1", "11");
  await customer(repo, "1", "mette@example.com");

  await processProductChange({ repo, shop: SHOP, productId: "900", deleted: true, admin: {}, deps, now: NOW });
  assert.equal(repo.items.length, 0);
  assert.equal(deps.shopify.calls.length, 0, "no Shopify call for a deleted product");
  await deliverEmails({ repo, shop: SHOP, deps, now: NOW });
  assert.equal(sent[0].metric, "Planned Order Product Removed");
  assert.deepEqual(Object.keys(sent[0].properties).sort(), ["CartURL", "ProductTitle", "Quantity"]);
});

test("with emails switched off, changes still apply and the emails are recorded as skipped", async () => {
  const { repo, deps, sent } = setup({ emailsEnabled: false, shopify: { variants: { 11: product({ releaseDate: "2027-05-01" }) } } });
  seed(repo, "1", "11");
  await customer(repo, "1", "mette@example.com");

  await processProductChange({ repo, shop: SHOP, productId: "900", admin: {}, deps, now: NOW });
  await deliverEmails({ repo, shop: SHOP, deps, now: NOW });
  assert.equal(repo.items[0].releaseDate, "2027-05-01");
  assert.deepEqual(repo.emails.map((e) => [e.status, e.error]), [["skipped", "Emails are switched off in Settings"]]);
  assert.equal(sent.length, 0);
});

test("a missing email address is loaded from Shopify before the email is queued", async () => {
  const { repo, deps, sent } = setup({
    shopify: { variants: { 11: product({ releaseDate: "2027-05-01" }) }, profiles: { 1: { name: "Mette", email: "m@x.dk", companyName: "Baby ApS" } } },
  });
  seed(repo, "1", "11");
  await repo.upsertCustomer(SHOP, "1", { profileAt: NOW }); // recent attempt, but no email

  await processProductChange({ repo, shop: SHOP, productId: "900", admin: {}, deps, now: NOW });
  await deliverEmails({ repo, shop: SHOP, deps, now: NOW });
  assert.equal(sent[0].email, "m@x.dk");
  assert.equal(repo.customers.get(`${SHOP}|1`).companyName, "Baby ApS");
});

test("failed sends are retried; permanent errors are not", async () => {
  const { repo, deps } = setup({
    sendResult: (args) =>
      args.email === "temp@x.dk"
        ? { ok: false, status: 503, error: "busy", retryable: true }
        : { ok: false, status: 400, error: "Invalid email", retryable: false },
  });
  await repo.createEmailEvents([
    { shop: SHOP, customerId: "1", email: "temp@x.dk", kind: "removed", metric: "M", uniqueId: "u1", properties: "{}", status: "pending", error: null },
    { shop: SHOP, customerId: "2", email: "bad", kind: "removed", metric: "M", uniqueId: "u2", properties: "{}", status: "pending", error: null },
  ]);

  await deliverEmails({ repo, shop: SHOP, deps, now: NOW });
  assert.deepEqual(repo.emails.map((e) => [e.status, e.attempts]), [["failed", 1], ["failed", MAX_EMAIL_ATTEMPTS]]);

  for (let i = 0; i < MAX_EMAIL_ATTEMPTS + 2; i += 1) await deliverEmails({ repo, shop: SHOP, deps, now: NOW });
  assert.deepEqual(repo.emails.map((e) => e.attempts), [MAX_EMAIL_ATTEMPTS, MAX_EMAIL_ATTEMPTS]);
});

test("emails queued before they were switched off are not sent later", async () => {
  const { repo, deps, sent } = setup();
  await repo.createEmailEvents([
    { shop: SHOP, customerId: "1", email: "m@x.dk", kind: "removed", metric: "M", uniqueId: "u1", properties: "{}", status: "pending", error: null },
  ]);
  await repo.saveSettings(SHOP, { emailsEnabled: false });
  await deliverEmails({ repo, shop: SHOP, deps, now: NOW });
  assert.equal(sent.length, 0);
  assert.equal(repo.emails[0].status, "skipped");
});

test("changes the cart reports are emailed once, even if reported twice", async () => {
  const { repo, deps } = setup();
  await customer(repo, "1", "m@x.dk");
  const ops = parseOps({ ops: [{ op: "add", v: 11, q: 6, h: "pacifier", r: "2027-02-15" }] }).ops;
  await updatePlan({ repo, shop: SHOP, customerId: "1", ops, now: NOW, logger: silent });
  const change = parseOps({ ops: [{ op: "patch", v: 11, r: "2027-04-01", reason: "reconcile" }] }).ops;
  const { events } = await updatePlan({ repo, shop: SHOP, customerId: "1", ops: change, now: NOW, logger: silent });

  const withCustomer = events.map((event) => ({ ...event, customerId: "1" }));
  await queueEmails({ repo, shop: SHOP, events: withCustomer, admin: {}, deps, now: NOW });
  await queueEmails({ repo, shop: SHOP, events: withCustomer, admin: {}, deps, now: NOW });
  assert.equal(repo.emails.length, 1);
  assert.equal(JSON.parse(repo.emails[0].properties).NewDateFormatted, "01/04/2027");
});

// ---- nightly check -------------------------------------------------------------------------

const b2b = {
  locations: { 1: ["L1"], 2: ["L2"] },
  catalogs: { L1: [{ status: "ACTIVE", publicationId: "P1" }], L2: [{ status: "ACTIVE", publicationId: "P2" }] },
  publications: { 900: { P1: true, P2: false } },
};

test("nightly: a product hidden from a customer's catalogue is removed on the second night", async () => {
  const { repo, deps, sent } = setup({ shopify: { variants: { 11: product() }, ...b2b } });
  seed(repo, "1", "11");
  seed(repo, "2", "11");
  await customer(repo, "1", "a@x.dk");
  await customer(repo, "2", "b@x.dk");

  const first = await runNightlyCheck({ repo, shop: SHOP, admin: {}, deps, now: NOW });
  assert.equal(first.hidden, 1);
  assert.equal(first.removed, 0);
  assert.equal(repo.items.length, 2);
  assert.ok(repo.items.find((i) => i.customerId === "2").missingSince);
  assert.ok(repo.logs.some((l) => l.type === "hidden" && l.customerId === "2"));

  const second = await runNightlyCheck({ repo, shop: SHOP, admin: {}, deps, now: new Date(NOW.getTime() + REMOVAL_CONFIRM_MS) });
  assert.equal(second.removed, 1);
  assert.deepEqual(repo.items.map((i) => i.customerId), ["1"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, "b@x.dk");
  assert.equal(JSON.parse(repo.customers.get(`${SHOP}|2`).notices)[0].type, "removed");
  assert.equal(repo.logs.filter((l) => l.type === "check_run").length, 2);
});

test("nightly: a missed date change is caught; a failed catalogue check removes nothing", async () => {
  const { repo, deps } = setup({ shopify: { variants: { 11: product({ releaseDate: "2027-06-01" }) }, failCatalogue: true } });
  const marked = seed(repo, "1", "11", { missingSince: new Date(NOW.getTime() - 2 * REMOVAL_CONFIRM_MS) });
  await customer(repo, "1", "a@x.dk");

  const summary = await runNightlyCheck({ repo, shop: SHOP, admin: {}, deps, now: NOW });
  assert.equal(summary.dateChanges, 1);
  assert.equal(summary.removed, 0);
  assert.equal(summary.catalogueChecked, false);
  assert.match(summary.errors.join(), /Catalogue check: catalogue down/);
  assert.equal(repo.items[0].id, marked.id);
  assert.equal(repo.items[0].releaseDate, "2027-06-01");
});

test("nightly: old profiles are refreshed and failed emails retried", async () => {
  let calls = 0;
  const { repo, deps } = setup({
    shopify: { variants: { 11: product() }, ...b2b, profiles: { 1: { name: "New name", email: "a@x.dk" } } },
    sendResult: () => (++calls === 1 ? { ok: false, status: 500, error: "x", retryable: true } : { ok: true, status: 202 }),
  });
  seed(repo, "1", "11");
  await repo.upsertCustomer(SHOP, "1", { email: "a@x.dk", name: "Old", profileAt: new Date("2026-01-01") });
  await repo.createEmailEvents([
    { shop: SHOP, customerId: "1", email: "a@x.dk", kind: "removed", metric: "M", uniqueId: "u1", properties: "{}", status: "pending", error: null },
  ]);
  await deliverEmails({ repo, shop: SHOP, deps, now: NOW });
  assert.equal(repo.emails[0].status, "failed");

  const summary = await runNightlyCheck({ repo, shop: SHOP, admin: {}, deps, now: NOW });
  assert.equal(repo.customers.get(`${SHOP}|1`).name, "New name");
  assert.deepEqual(summary.emails, { sent: 1, failed: 0, skipped: 0 });
  assert.equal(repo.emails[0].status, "sent");
});

test("customers/delete removes the customer's plan and email rows", async () => {
  const { repo } = setup();
  seed(repo, "1", "11");
  seed(repo, "2", "11");
  await customer(repo, "1", "a@x.dk");
  await repo.createEmailEvents([
    { shop: SHOP, customerId: "1", email: "a@x.dk", kind: "removed", metric: "M", uniqueId: "u1", properties: "{}", status: "sent", error: null },
  ]);
  await repo.deleteCustomerData(SHOP, "1");
  assert.deepEqual(repo.items.map((i) => i.customerId), ["2"]);
  assert.equal(repo.customers.has(`${SHOP}|1`), false);
  assert.equal(repo.emails.length, 0);
});

test("the removal wait can be shortened for QA, never made invalid", async () => {
  const { defaultDeps } = await import("../app/planned/jobs.js");
  assert.equal(defaultDeps({}, {}).removalConfirmMs, REMOVAL_CONFIRM_MS);
  assert.equal(defaultDeps({}, { PLANNED_ORDER_REMOVAL_CONFIRM_HOURS: "0" }).removalConfirmMs, 0);
  assert.equal(defaultDeps({}, { PLANNED_ORDER_REMOVAL_CONFIRM_HOURS: "2" }).removalConfirmMs, 2 * 3600000);
  assert.equal(defaultDeps({}, { PLANNED_ORDER_REMOVAL_CONFIRM_HOURS: "abc" }).removalConfirmMs, REMOVAL_CONFIRM_MS);
  assert.equal(defaultDeps({}, { PLANNED_ORDER_REMOVAL_CONFIRM_HOURS: "-1" }).removalConfirmMs, REMOVAL_CONFIRM_MS);

  // With 0 hours, two checks in a row remove a hidden product.
  const { repo, deps } = setup({ shopify: { variants: { 11: product() }, ...b2b } });
  deps.removalConfirmMs = 0;
  seed(repo, "2", "11");
  await runNightlyCheck({ repo, shop: SHOP, admin: {}, deps, now: NOW });
  await runNightlyCheck({ repo, shop: SHOP, admin: {}, deps, now: NOW });
  assert.equal(repo.items.length, 0);
});
