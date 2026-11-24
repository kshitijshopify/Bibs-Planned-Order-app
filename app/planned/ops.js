// Validates the operations the theme sends to POST /apps/planned-order/plan.
//
// The theme keeps its item format ({ v, h, q, r, ti, s }) and sends only what
// changed, so a stale tab can't overwrite fields it didn't touch:
//   { op: "add",    v, q, h, r, ti }        add q to the variant (new or existing)
//   { op: "patch",  v, q?, s?, r?, ti?, h?, reason? }
//   { op: "remove", v, reason? }             reason: customer | included | missing
//   { op: "import", items: [...] }           one-time copy of the browser-only plan
//   { op: "ack",    ids: [...] }             cart messages the customer has seen
// Invalid operations are skipped and reported; the rest still apply.

import { toLegacyId } from "./ids.js";
import { normalizeReleaseDate } from "./dates.js";

export const LIMITS = {
  maxItems: 300,
  maxQuantity: 100000,
  maxOps: 200,
  maxText: 255,
  maxBodyBytes: 256 * 1024,
};

export const REMOVE_REASONS = ["customer", "included", "missing"];
const PATCH_REASONS = ["reconcile"];

export class PlanRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function cleanText(value) {
  if (value == null) return "";
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, LIMITS.maxText);
}

function quantity(value) {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1) return null;
  return Math.min(number, LIMITS.maxQuantity);
}

function releaseDate(value) {
  if (value == null || value === "") return "";
  return normalizeReleaseDate(value) || null;
}

function itemFields(raw) {
  const v = toLegacyId(raw.v);
  const q = quantity(raw.q);
  const r = releaseDate(raw.r);
  if (!v) return { error: "invalid variant id" };
  if (q == null) return { error: "invalid quantity" };
  if (r == null) return { error: "invalid ordering date" };
  return { v, q, r, h: cleanText(raw.h), ti: cleanText(raw.ti) };
}

function parseOp(raw) {
  if (!raw || typeof raw !== "object") return { error: "not an object" };

  switch (raw.op) {
    case "add": {
      const fields = itemFields(raw);
      return fields.error ? fields : { op: "add", ...fields };
    }

    case "patch": {
      const v = toLegacyId(raw.v);
      if (!v) return { error: "invalid variant id" };
      const op = { op: "patch", v };
      if (raw.q !== undefined) {
        op.q = quantity(raw.q);
        if (op.q == null) return { error: "invalid quantity" };
      }
      if (raw.s !== undefined) {
        if (raw.s !== "p" && raw.s !== "d") return { error: "invalid state" };
        op.s = raw.s;
      }
      if (raw.r !== undefined) {
        op.r = releaseDate(raw.r);
        if (op.r == null) return { error: "invalid ordering date" };
      }
      if (raw.ti !== undefined) op.ti = cleanText(raw.ti);
      if (raw.h !== undefined) {
        op.h = cleanText(raw.h);
        if (!op.h) delete op.h;
      }
      if (raw.reason !== undefined && PATCH_REASONS.includes(raw.reason)) op.reason = raw.reason;
      return op;
    }

    case "remove": {
      const v = toLegacyId(raw.v);
      if (!v) return { error: "invalid variant id" };
      const reason = REMOVE_REASONS.includes(raw.reason) ? raw.reason : "customer";
      return { op: "remove", v, reason };
    }

    case "import": {
      if (!Array.isArray(raw.items)) return { error: "items must be an array" };
      const items = [];
      raw.items.slice(0, LIMITS.maxItems).forEach((item) => {
        if (!item || typeof item !== "object") return;
        const fields = itemFields(item);
        if (fields.error) return;
        const addedAt = Number(item.a);
        items.push({
          ...fields,
          s: item.s === "d" ? "d" : "p",
          a: Number.isFinite(addedAt) && addedAt > 0 ? addedAt : null,
        });
      });
      return { op: "import", items };
    }

    case "ack": {
      if (!Array.isArray(raw.ids)) return { error: "ids must be an array" };
      return { op: "ack", ids: raw.ids.filter((id) => typeof id === "string").slice(0, 100) };
    }

    default:
      return { error: "unknown op" };
  }
}

/** { ops, rejected } from a request body; throws PlanRequestError for a bad body. */
export function parseOps(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.ops)) {
    throw new PlanRequestError("Expected a JSON body { ops: [...] }");
  }
  if (body.ops.length > LIMITS.maxOps) {
    throw new PlanRequestError(`At most ${LIMITS.maxOps} operations per request`);
  }

  const ops = [];
  const rejected = [];
  body.ops.forEach((raw, index) => {
    const parsed = parseOp(raw);
    if (parsed.error) rejected.push({ index, error: parsed.error });
    else ops.push(parsed);
  });
  return { ops, rejected };
}
