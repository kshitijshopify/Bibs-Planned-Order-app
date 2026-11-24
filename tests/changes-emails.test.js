import { test } from "node:test";
import assert from "node:assert/strict";
import { isVisibleToCustomer, noticeFor, planChanges, REMOVAL_CONFIRM_MS } from "../app/planned/changes.js";
import { buildEmailRows, propertiesFor, uniqueIdFor } from "../app/planned/emails.js";
import { METRICS } from "../app/planned/klaviyo.js";

const NOW = new Date("2026-11-18T01:00:00Z");
const TODAY = "2026-11-18";

let nextId = 1;
const item = (customerId, variantId, extra = {}) => ({
  id: nextId++,
  shop: "s",
  customerId,
  variantId,
  productId: "900",
  handle: "pacifier",
  title: "Pacifier",
  quantity: 6,
  releaseDate: "2027-02-15",
  state: "p",
  missingSince: null,
  addedAt: new Date("2026-11-01T10:00:00Z"),
  ...extra,
});

const state = (extra = {}) => ({
  productId: "900",
  handle: "pacifier",
  title: "Pacifier",
  status: "ACTIVE",
  onlineStoreUrl: "https://shop/products/pacifier",
  imageUrl: "https://cdn/p.jpg",
  releaseDate: "2027-02-15",
  ...extra,
});

const run = (items, variants, options = {}) =>
  planChanges({ items, variants: new Map(Object.entries(variants)), now: NOW, today: TODAY, source: "webhook", ...options });

// ---- planChanges -------------------------------------------------------------------

test("a new ordering date updates every variant and gives one event per customer and product", () => {
  const a1 = item("1", "11");
  const a2 = item("1", "12", { quantity: 4, state: "d", releaseDate: "2026-11-01" });
  const b1 = item("2", "11", { quantity: 3 });
  const result = run([a1, a2, b1], { 11: state({ releaseDate: "2027-03-01" }), 12: state({ releaseDate: "2027-03-01" }) });

  assert.deepEqual(
    result.updates.map((u) => [u.id, u.data]),
    [
      [a1.id, { releaseDate: "2027-03-01" }],
      [a2.id, { releaseDate: "2027-03-01", state: "p" }], // kept for later -> planned again
      [b1.id, { releaseDate: "2027-03-01" }],
    ],
  );
  assert.deepEqual(
    result.events.map((e) => [e.customerId, e.type, e.from, e.to, e.quantity, e.variantIds]),
    [
      ["1", "date_changed", "2027-02-15", "2027-03-01", 10, ["11", "12"]],
      ["2", "date_changed", "2027-02-15", "2027-03-01", 3, ["11"]],
    ],
  );
  assert.deepEqual(result.deletes, []);
});

test("no change, no event; renamed products are updated quietly", () => {
  const a = item("1", "11");
  assert.deepEqual(run([a], { 11: state() }), { updates: [], deletes: [], events: [] });
  const renamed = run([a], { 11: state({ handle: "pacifier-2", title: "Pacifier 2" }) });
  assert.deepEqual(renamed.updates[0].data, { handle: "pacifier-2", title: "Pacifier 2" });
  assert.equal(renamed.events.length, 0);
});

test("deleted variants or products are removed; unknown ones are left alone", () => {
  const a = item("1", "11");
  const b = item("1", "12");
  const result = run([a, b], { 11: null });
  assert.deepEqual(result.deletes, [a.id]);
  assert.equal(result.events[0].type, "removed");
  assert.equal(result.events[0].reason, "deleted");
});

test("a catalogue removal needs two checks in a row", () => {
  const hidden = () => false;
  const a = item("1", "11");

  const first = run([a], { 11: state() }, { visible: hidden, source: "nightly" });
  assert.deepEqual(first.updates[0].data, { missingSince: NOW });
  assert.deepEqual(first.events, []);

  const marked = { ...a, missingSince: NOW };
  const soon = run([marked], { 11: state() }, { visible: hidden, now: new Date(NOW.getTime() + 60 * 60 * 1000) });
  assert.deepEqual(soon, { updates: [], deletes: [], events: [] });

  const nextNight = run([marked], { 11: state() }, { visible: hidden, now: new Date(NOW.getTime() + REMOVAL_CONFIRM_MS) });
  assert.deepEqual(nextNight.deletes, [a.id]);
  assert.equal(nextNight.events[0].reason, "catalogue");

  const back = run([marked], { 11: state() }, { visible: () => true });
  assert.deepEqual(back.updates[0].data, { missingSince: null });

  const unsure = run([marked], { 11: state() }, { visible: () => null, now: new Date(NOW.getTime() + REMOVAL_CONFIRM_MS) });
  assert.deepEqual(unsure, { updates: [], deletes: [], events: [] });
});

test("a draft product counts as hidden (reason not_active)", () => {
  const marked = item("1", "11", { missingSince: new Date(NOW.getTime() - REMOVAL_CONFIRM_MS) });
  const result = run([marked], { 11: state({ status: "DRAFT" }) }, { visible: () => true });
  assert.equal(result.events[0].reason, "not_active");
});

test("cart messages say 'now available' when the new date has passed", () => {
  const later = noticeFor({ type: "date_changed", productId: "9", title: "P", to: "2027-01-01" }, TODAY, NOW);
  const earlier = noticeFor({ type: "date_changed", productId: "9", title: "P", to: "2026-11-18" }, TODAY, NOW);
  const removed = noticeFor({ type: "removed", productId: "9", title: "P" }, TODAY, NOW);
  assert.deepEqual([later.type, later.date], ["date_changed", "2027-01-01"]);
  assert.deepEqual([earlier.type, earlier.date], ["now_available", "2026-11-18"]);
  assert.deepEqual([removed.type, removed.date], ["removed", ""]);
});

// ---- catalogue visibility ------------------------------------------------------------------

test("catalogue visibility follows the customer's company location catalogs", () => {
  const catalogsByLocation = new Map([
    ["L1", [{ status: "ACTIVE", publicationId: "P1" }]],
    ["L2", [{ status: "ACTIVE", publicationId: null }]],
    ["L3", [{ status: "ARCHIVED", publicationId: "P1" }]],
    ["L4", [{ status: "ACTIVE", publicationId: "P9" }]],
  ]);
  const check = (locations, published, extra = {}) =>
    isVisibleToCustomer({ locations, catalogsByLocation, publishedOn: new Map(Object.entries(published)), state: state(extra) });

  assert.equal(check(["L1"], { P1: true }), true);
  assert.equal(check(["L1"], { P1: false }), false);
  assert.equal(check(["L1", "L2"], { P1: false }), true, "catalog without publication: Online Store");
  assert.equal(check(["L2"], {}, { onlineStoreUrl: null }), false);
  assert.equal(check(["L1"], { P1: true }, { status: "DRAFT" }), false);
  assert.equal(check(["L1"], { P1: true }, { status: "UNLISTED" }), true);
  // Not decided (nothing is removed):
  assert.equal(check([], {}), null, "not a B2B contact");
  assert.equal(check(null, {}), null, "customer not loaded");
  assert.equal(check(["L3"], { P1: true }), null, "no active catalog");
  assert.equal(check(["L4"], {}), null, "publication not loaded");
  assert.equal(check(["L1", "L4"], { P1: false }), null);
});

// ---- emails -------------------------------------------------------------------------------

const dateEvent = {
  type: "date_changed",
  customerId: "1",
  productId: "900",
  title: "Pacifier",
  handle: "pacifier",
  imageUrl: "https://cdn/p.jpg",
  quantity: 10,
  from: "2027-02-15",
  to: "2027-03-01",
  addedAt: new Date("2026-11-01T10:00:00Z"),
};
const removedEvent = { ...dateEvent, type: "removed", reason: "catalogue", from: undefined, to: undefined };

test("email properties: full details for a new date, only the name for a removal", () => {
  assert.deepEqual(propertiesFor(dateEvent, { storefrontUrl: "https://dist.bibs.com", today: TODAY }), {
    ProductTitle: "Pacifier",
    ProductHandle: "pacifier",
    ProductURL: "https://dist.bibs.com/products/pacifier",
    ProductImageURL: "https://cdn/p.jpg",
    Quantity: 10,
    PreviousDate: "2027-02-15",
    PreviousDateFormatted: "15/02/2027",
    NewDate: "2027-03-01",
    NewDateFormatted: "01/03/2027",
    OrderableNow: false,
    CartURL: "https://dist.bibs.com/cart",
  });
  assert.deepEqual(propertiesFor(removedEvent, { storefrontUrl: "https://dist.bibs.com", today: TODAY }), {
    ProductTitle: "Pacifier",
    Quantity: 10,
    CartURL: "https://dist.bibs.com/cart",
  });
});

test("the same change always has the same unique id; a later removal gets a new one", () => {
  assert.equal(uniqueIdFor(dateEvent, "1"), "planned-order:date:1:900:2027-02-15>2027-03-01");
  assert.equal(uniqueIdFor(removedEvent, "1"), `planned-order:removed:1:900:${dateEvent.addedAt.getTime()}`);
  assert.notEqual(
    uniqueIdFor({ ...removedEvent, addedAt: new Date("2026-12-01") }, "1"),
    uniqueIdFor(removedEvent, "1"),
  );
});

test("email rows are pending only when emails are on, Klaviyo is set and the email is known", () => {
  const customers = new Map([["1", { email: "mette@example.com" }]]);
  const rows = (options) =>
    buildEmailRows({
      shop: "s",
      events: [dateEvent, { ...removedEvent, customerId: "2" }, { type: "handle_changed", customerId: "1" }],
      customers,
      emailsEnabled: true,
      klaviyoReady: true,
      storefrontUrl: null,
      today: TODAY,
      ...options,
    }).map((r) => [r.customerId, r.kind, r.metric, r.status, r.error]);

  assert.deepEqual(rows({}), [
    ["1", "date_changed", METRICS.date_changed, "pending", null],
    ["2", "removed", METRICS.removed, "skipped", "No email address for this customer"],
  ]);
  assert.equal(rows({ emailsEnabled: false })[0][4], "Emails are switched off in Settings");
  assert.equal(rows({ klaviyoReady: false })[0][4], "Klaviyo key is not set (KLAVIYO_PRIVATE_KEY)");
});
