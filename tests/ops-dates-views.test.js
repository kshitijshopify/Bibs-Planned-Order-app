import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, parseOps, PlanRequestError } from "../app/planned/ops.js";
import { displayDate, isFutureRelease, normalizeReleaseDate, shopToday } from "../app/planned/dates.js";
import { toLegacyId } from "../app/planned/ids.js";
import { customerPlans, itemStatus, upcomingReleases } from "../app/planned/admin-views.js";

// ---- ids and dates -------------------------------------------------------------

test("ids accept numbers, numeric strings and gids only", () => {
  assert.equal(toLegacyId(44012345678901), "44012345678901");
  assert.equal(toLegacyId("44012345678901"), "44012345678901");
  assert.equal(toLegacyId("gid://shopify/ProductVariant/44012345678901"), "44012345678901");
  for (const bad of [0, -1, 1.5, "", "abc", "0", "12a", null, undefined, {}, "gid://shopify/ProductVariant/x"]) {
    assert.equal(toLegacyId(bad), null, String(bad));
  }
});

test("ordering dates: date and date_time values, invalid dates are empty", () => {
  assert.equal(normalizeReleaseDate("2027-02-15"), "2027-02-15");
  assert.equal(normalizeReleaseDate("2027-02-15T00:00:00+01:00"), "2027-02-15");
  assert.equal(normalizeReleaseDate("2027-02-30"), "");
  assert.equal(normalizeReleaseDate("15/02/2027"), "");
  assert.equal(normalizeReleaseDate(null), "");
  assert.equal(displayDate("2027-02-15"), "15/02/2027");
  assert.equal(displayDate(""), "");
});

test("today switches at midnight Copenhagen time, also across daylight saving", () => {
  // Winter (UTC+1)
  assert.equal(shopToday(new Date("2026-11-17T22:59:59Z")), "2026-11-17");
  assert.equal(shopToday(new Date("2026-11-17T23:00:00Z")), "2026-11-18");
  // Summer (UTC+2)
  assert.equal(shopToday(new Date("2027-06-14T21:59:59Z")), "2027-06-14");
  assert.equal(shopToday(new Date("2027-06-14T22:00:00Z")), "2027-06-15");
  // DST change nights
  assert.equal(shopToday(new Date("2027-03-27T23:30:00Z")), "2027-03-28");
  assert.equal(shopToday(new Date("2027-10-30T22:30:00Z")), "2027-10-31");
});

test("a product is planned only while its date is after today", () => {
  assert.equal(isFutureRelease("2027-02-15", "2027-02-14"), true);
  assert.equal(isFutureRelease("2027-02-15", "2027-02-15"), false);
  assert.equal(isFutureRelease("", "2027-02-15"), false);
});

// ---- request validation -----------------------------------------------------------

test("valid operations are normalised", () => {
  const { ops, rejected } = parseOps({
    ops: [
      { op: "add", v: 111, q: 6, h: "  pacifier ", r: "2027-02-15", ti: "Pacifier\u0000 Supreme" },
      { op: "patch", v: "111", q: "12", s: "d", r: "", reason: "reconcile" },
      { op: "remove", v: "gid://shopify/ProductVariant/111", reason: "nonsense" },
      { op: "ack", ids: ["a", 5, "b"] },
    ],
  });
  assert.deepEqual(rejected, []);
  assert.deepEqual(ops, [
    { op: "add", v: "111", q: 6, r: "2027-02-15", h: "pacifier", ti: "Pacifier Supreme" },
    { op: "patch", v: "111", q: 12, s: "d", r: "", reason: "reconcile" },
    { op: "remove", v: "111", reason: "customer" },
    { op: "ack", ids: ["a", "b"] },
  ]);
});

test("invalid operations are skipped and reported, the rest still apply", () => {
  const { ops, rejected } = parseOps({
    ops: [
      { op: "add", v: "abc", q: 1 },
      { op: "add", v: 111, q: 0 },
      { op: "add", v: 111, q: 2.5 },
      { op: "add", v: 111, q: 1, r: "2027-13-01" },
      { op: "patch", v: 111, s: "x" },
      { op: "drop_table" },
      null,
      { op: "add", v: 222, q: 3, h: "bottle" },
    ],
  });
  assert.deepEqual(ops.map((op) => op.v), ["222"]);
  assert.deepEqual(
    rejected.map((r) => r.index),
    [0, 1, 2, 3, 4, 5, 6],
  );
});

test("quantities are capped and long text is cut", () => {
  const { ops } = parseOps({ ops: [{ op: "add", v: 1, q: 10 ** 9, h: "x".repeat(1000) }] });
  assert.equal(ops[0].q, LIMITS.maxQuantity);
  assert.equal(ops[0].h.length, LIMITS.maxText);
});

test("a body without ops or with too many ops is refused", () => {
  assert.throws(() => parseOps(null), PlanRequestError);
  assert.throws(() => parseOps({ items: [] }), PlanRequestError);
  assert.throws(() => parseOps({ ops: new Array(LIMITS.maxOps + 1).fill({ op: "ack", ids: [] }) }), PlanRequestError);
});

test("import keeps valid browser items with their state and time", () => {
  const { ops } = parseOps({
    ops: [
      {
        op: "import",
        items: [
          { v: 1, q: 2, h: "a", r: "2027-01-01", s: "d", a: 1700000000000 },
          { v: "bad", q: 2, h: "b" },
          { v: 3, q: 1, h: "c", s: "?" },
        ],
      },
    ],
  });
  assert.deepEqual(ops[0].items, [
    { v: "1", q: 2, r: "2027-01-01", h: "a", ti: "", s: "d", a: 1700000000000 },
    { v: "3", q: 1, r: "", h: "c", ti: "", s: "p", a: null },
  ]);
});

// ---- admin lists ----------------------------------------------------------------------

const item = (customerId, variantId, productId, quantity, releaseDate, extra = {}) => ({
  customerId,
  variantId,
  productId,
  handle: `product-${productId}`,
  title: `Product ${productId}`,
  quantity,
  releaseDate,
  state: "p",
  updatedAt: new Date("2026-11-10T10:00:00Z"),
  ...extra,
});

test("upcoming ordering dates group future products with total quantity and customers", () => {
  const items = [
    item("1", "11", "100", 6, "2027-03-01"),
    item("2", "12", "100", 4, "2027-03-01"), // other variant, other customer
    item("1", "21", "200", 2, "2027-02-01"),
    item("3", "31", "300", 9, "2026-11-01"), // released: not upcoming
    item("3", "41", "400", 1, ""),
  ];
  const releases = upcomingReleases(items, "2026-11-18");
  assert.deepEqual(
    releases.map((r) => [r.dateDisplay, r.quantity, r.customers]),
    [
      ["01/02/2027", 2, 1],
      ["01/03/2027", 10, 2],
    ],
  );
  assert.deepEqual(releases[1].products, [
    { productId: "100", handle: "product-100", title: "Product 100", quantity: 10, customers: 2 },
  ]);
});

test("customer rows show counts, next date and profile, newest change first", () => {
  const items = [
    item("1", "11", "100", 6, "2027-03-01"),
    item("1", "21", "200", 2, "2027-02-01"),
    item("2", "31", "300", 9, "", { state: "d" }),
  ];
  const customers = [
    { customerId: "1", name: "Mette", email: "m@example.com", companyName: "Baby ApS", planUpdatedAt: new Date("2026-11-01") },
    { customerId: "2", name: null, email: null, companyName: null, planUpdatedAt: new Date("2026-11-15") },
  ];
  const rows = customerPlans(items, customers, "2026-11-18");
  assert.deepEqual(
    rows.map((r) => [r.customerId, r.name, r.companyName, r.products, r.quantity, r.planned, r.nextDateDisplay]),
    [
      ["2", null, null, 1, 9, 0, ""],
      ["1", "Mette", "Baby ApS", 2, 8, 2, "01/02/2027"],
    ],
  );
  assert.equal(itemStatus(items[2], "2026-11-18"), "kept");
  assert.equal(itemStatus(items[0], "2026-11-18"), "planned");
  assert.equal(itemStatus(items[0], "2027-03-01"), "available");
});
