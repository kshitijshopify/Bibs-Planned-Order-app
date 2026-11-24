// Shopify ids: the plan stores numeric ids as strings ("44012345678901").

const DIGITS = /^[1-9]\d{0,19}$/;
const GID = /^gid:\/\/shopify\/[A-Za-z]+\/([1-9]\d{0,19})(?:\?.*)?$/;

/** Numeric id from a number, "123" or a gid, else null. */
export function toLegacyId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (DIGITS.test(text)) return text;
  const match = GID.exec(text);
  return match ? match[1] : null;
}

export const variantGid = (id) => `gid://shopify/ProductVariant/${id}`;
export const customerGid = (id) => `gid://shopify/Customer/${id}`;
export const productGid = (id) => `gid://shopify/Product/${id}`;
