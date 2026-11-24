import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, parseOps } from "../app/planned/ops.js";
import { getPlan, pushNotice, toClientPlan, updatePlan, variantsToLookUp } from "../app/planned/plan.js";
import { createMemoryRepo } from "./helpers/memory-repo.js";

const SHOP = "bibs-dev.myshopify.com";
const ALICE = "7001";
const BOB = "7002";
const NOW = new Date("2026-11-18T10:00:00Z");
const silent = { warn() {} };

const product = (overrides = {}) => ({
  productId: "9001",
  handle: "pacifier-supreme",
  title: "Pacifier Supreme",
  status: "ACTIVE",
  releaseDate: "2027-02-15",
  ...overrides,
});

function lookupFrom(map) {
  const calls = [];
  const fn = async (ids) => {
    calls.push(ids);
    return new Map(ids.filter((id) => id in map).map((id) => [id, map[id]]));
  };
  fn.calls = calls;
  return fn;
}

async function run(repo, ops, { customerId = ALICE, shop = SHOP, lookup = null, now = NOW } = {}) {
  const parsed = parseOps({ ops });
  assert.deepEqual(parsed.rejected, [], "test ops should be valid");
  return updatePlan({ repo, shop, customerId, ops: parsed.ops, lookupVariants: lookup, now, logger: silent });
}

const add = (v, q, extra = {}) => ({ op: "add", v, q, h: "pacifier-supreme", r: "2027-02-15", ti: "Pacifier", ...extra });

test("add stores a new item with Shopify's product details and returns the theme format", async () => {
  const repo = createMemoryRepo();
  const lookup = lookupFrom({ 111: product({ handle: "pacifier-supreme-v2", releaseDate: "2027-03-01" }) });
  const result = await run(repo, [add(111, 6)], { lookup });

  assert.equal(repo.items.length, 1);
  assert.equal(repo.items[0].productId, "9001");
  assert.equal(repo.items[0].handle, "pacifier-supreme-v2");
  assert.equal(repo.items[0].releaseDate, "2027-03-01");
  assert.deepEqual(toClientPlan(result).items, [
    { v: 111, h: "pacifier-supreme-v2", q: 6, r: "2027-03-01", ti: "Pacifier Supreme", s: "p", a: NOW.getTime() },
  ]);
  assert.ok(result.changed);
  assert.equal(repo.customers.get(`${SHOP}|${ALICE}`).planUpdatedAt, NOW);
});

test("adding a planned variant again adds the quantity and moves it back to planned", async () => {
  const repo = createMemoryRepo();
  const lookup = lookupFrom({ 111: product() });
  await run(repo, [add(111, 6)], { lookup });
  await run(repo, [{ op: "patch", v: 111, s: "d" }]);
  await run(repo, [add(111, 4)], { lookup });

  assert.equal(repo.items[0].quantity, 10);
  assert.equal(repo.items[0].state, "p");
  // productId is known now, so Shopify is not asked again.
  assert.equal(lookup.calls.length, 1);
});

test("a variant Shopify doesn't know is rejected", async () => {
  const repo = createMemoryRepo();
  const lookup = async (ids) => new Map(ids.map((id) => [id, null]));
  const result = await run(repo, [add(999, 2)], { lookup });
  assert.equal(repo.items.length, 0);
  assert.deepEqual(result.rejected, [{ op: "add", v: "999", error: "variant not found" }]);
});

test("if Shopify can't be reached the theme's data is used", async () => {
  const repo = createMemoryRepo();
  const lookup = async () => {
    throw new Error("network down");
  };
  await run(repo, [add(111, 6)], { lookup });
  assert.equal(repo.items[0].handle, "pacifier-supreme");
  assert.equal(repo.items[0].releaseDate, "2027-02-15");
  assert.equal(repo.items[0].productId, null);
});

test("a quantity change from a stale tab doesn't overwrite the ordering date", async () => {
  const repo = createMemoryRepo();
  await run(repo, [add(111, 6)]);
  repo.items[0].releaseDate = "2027-04-01"; // updated by Shopify meanwhile
  await run(repo, [{ op: "patch", v: 111, q: 12 }]);
  assert.equal(repo.items[0].quantity, 12);
  assert.equal(repo.items[0].releaseDate, "2027-04-01");
});

test("only the cart's check against Shopify logs an ordering date change", async () => {
  const repo = createMemoryRepo();
  await run(repo, [add(111, 6)]);
  await run(repo, [{ op: "patch", v: 111, r: "2027-03-01" }]);
  assert.equal(repo.logs.length, 0);

  await run(repo, [{ op: "patch", v: 111, r: "2027-05-01", reason: "reconcile" }]);
  assert.equal(repo.items[0].releaseDate, "2027-05-01");
  assert.equal(repo.logs.length, 1);
  assert.equal(repo.logs[0].type, "date_changed");
  assert.equal(repo.logs[0].source, "cart");
  assert.deepEqual(JSON.parse(repo.logs[0].details), { from: "2027-03-01", to: "2027-05-01" });
});

test("a product the cart couldn't load is kept when only its handle changed", async () => {
  const repo = createMemoryRepo();
  await run(repo, [add(111, 6)], { lookup: lookupFrom({ 111: product() }) });
  const lookup = lookupFrom({ 111: product({ handle: "pacifier-supreme-2027", title: "Pacifier Supreme 2027" }) });
  const result = await run(repo, [{ op: "remove", v: 111, reason: "missing" }], { lookup });

  assert.equal(repo.items.length, 1);
  assert.equal(result.items[0].handle, "pacifier-supreme-2027");
  assert.equal(repo.logs.at(-1).type, "handle_changed");
});

test("removals the cart reports are logged with the reason Shopify gives", async () => {
  const cases = [
    [null, "deleted"],
    [product({ status: "DRAFT" }), "not_active"],
    [product(), "catalogue"],
  ];
  for (const [info, reason] of cases) {
    const repo = createMemoryRepo();
    await run(repo, [add(111, 6)], { lookup: lookupFrom({ 111: product() }) });
    await run(repo, [{ op: "remove", v: 111, reason: "missing" }], { lookup: lookupFrom({ 111: info }) });
    assert.equal(repo.items.length, 0);
    assert.equal(repo.logs.at(-1).type, "removed");
    assert.deepEqual(JSON.parse(repo.logs.at(-1).details), { reason, quantity: 6 });
  }
});

test("customer removals and moves to the cart are not logged", async () => {
  const repo = createMemoryRepo();
  await run(repo, [add(111, 6), add(222, 4)]);
  await run(repo, [
    { op: "remove", v: 111 },
    { op: "remove", v: 222, reason: "included" },
    { op: "remove", v: 333 },
  ]);
  assert.equal(repo.items.length, 0);
  assert.equal(repo.logs.length, 0);
});

test("import copies the browser plan once, without touching what the server already has", async () => {
  const repo = createMemoryRepo();
  await run(repo, [add(111, 6)]);
  const browserItems = [
    { v: 111, q: 99, h: "pacifier-supreme", r: "2027-02-15", s: "p", a: 1700000000000 },
    { v: 222, q: 4, h: "bottle", r: "2027-01-10", ti: "Bottle", s: "d", a: 1700000000000 },
  ];
  await run(repo, [{ op: "import", items: browserItems }]);
  await run(repo, [{ op: "import", items: browserItems }]);

  const plan = await getPlan({ repo, shop: SHOP, customerId: ALICE });
  assert.deepEqual(
    plan.items.map((item) => [item.variantId, item.quantity, item.state, item.releaseDate]),
    [
      ["222", 4, "d", "2027-01-10"],
      ["111", 6, "p", "2027-02-15"],
    ],
  );
  assert.ok(repo.customers.get(`${SHOP}|${ALICE}`).migratedAt);
  assert.deepEqual(
    repo.logs.filter((log) => log.type === "imported").map((log) => JSON.parse(log.details)),
    [
      { added: 1, received: 2 },
      { added: 0, received: 2 },
    ],
  );
});

test("each customer only sees and changes their own plan, per shop", async () => {
  const repo = createMemoryRepo();
  await run(repo, [add(111, 6)], { customerId: ALICE });
  await run(repo, [add(111, 2), { op: "remove", v: 222 }], { customerId: BOB });
  await run(repo, [add(111, 3)], { customerId: ALICE, shop: "other.myshopify.com" });

  const alice = await getPlan({ repo, shop: SHOP, customerId: ALICE });
  const bob = await getPlan({ repo, shop: SHOP, customerId: BOB });
  assert.deepEqual(alice.items.map((item) => item.quantity), [6]);
  assert.deepEqual(bob.items.map((item) => item.quantity), [2]);
});

test("the plan is capped at the item limit", async () => {
  const repo = createMemoryRepo();
  const ops = Array.from({ length: LIMITS.maxItems }, (_, i) => add(1000 + i, 1));
  for (let i = 0; i < ops.length; i += LIMITS.maxOps) await run(repo, ops.slice(i, i + LIMITS.maxOps));
  const result = await run(repo, [add(5000, 1)]);
  assert.equal(repo.items.length, LIMITS.maxItems);
  assert.equal(result.rejected[0].error, "planned order is full");
});

test("seen cart messages are removed without counting as a plan change", async () => {
  const repo = createMemoryRepo();
  await run(repo, [add(111, 6)]);
  let notices = [];
  notices = pushNotice(notices, { id: "n1", type: "date_changed", title: "Pacifier", date: "2027-03-01" });
  notices = pushNotice(notices, { id: "n2", type: "removed", title: "Bottle" });
  await repo.upsertCustomer(SHOP, ALICE, { notices: JSON.stringify(notices), planUpdatedAt: new Date("2026-11-01") });

  const before = await getPlan({ repo, shop: SHOP, customerId: ALICE });
  assert.deepEqual(toClientPlan(before).notices[0], {
    id: "n1",
    type: "date_changed",
    title: "Pacifier",
    date: "2027-03-01",
    dateDisplay: "01/03/2027",
  });

  const result = await run(repo, [{ op: "ack", ids: ["n1"] }]);
  assert.deepEqual(result.notices.map((n) => n.id), ["n2"]);
  assert.equal(result.changed, false);
  assert.deepEqual(repo.customers.get(`${SHOP}|${ALICE}`).planUpdatedAt, new Date("2026-11-01"));
});

test("Shopify is only asked about variants that need it", () => {
  const ops = parseOps({
    ops: [
      add(111, 1),
      add(222, 1),
      { op: "patch", v: 333, q: 2 },
      { op: "remove", v: 444, reason: "missing" },
      { op: "remove", v: 555 },
      { op: "import", items: [{ v: 666, q: 1, h: "x" }, { v: 222, q: 1, h: "x" }] },
    ],
  }).ops;
  const current = [
    { variantId: "222", productId: "9" },
    { variantId: "444", productId: "9" },
  ];
  assert.deepEqual(variantsToLookUp(ops, current).sort(), ["111", "444", "666"]);
});
