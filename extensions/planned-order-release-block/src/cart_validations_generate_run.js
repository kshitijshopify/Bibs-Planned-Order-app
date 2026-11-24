// @ts-check

/**
 * Planned orders: blocks checkout while the cart has a product whose
 * custom.distributor_order_release_date is still in the future.
 *
 * - "Today" is shop.localTime.date, the date in the shop's timezone
 *   (Europe/Copenhagen for BIBS), so products open at local midnight and
 *   daylight saving is handled by Shopify.
 * - Empty metafield, today or an earlier date = orderable.
 * - Runs for every checkout: cart page, quick add, reorder, CSV upload,
 *   accelerated checkout and checkouts from draft orders.
 * - Cart interactions are not blocked: the theme moves such lines from the
 *   cart into the planned order, and checkout is still checked here.
 */

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

const MESSAGES = {
  EN: (title, date) => `“${title}” can't be ordered before ${date}. Remove it from this order to continue.`,
  DA: (title, date) => `“${title}” kan ikke bestilles før ${date}. Fjern produktet fra ordren for at fortsætte.`,
};

/** "2027-02-15" from a date or date_time value, else "" (orderable). */
function releaseDate(value) {
  if (!value) return "";
  const date = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

/** 15/02/2027, the format the theme shows. */
function displayDate(date) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  if (input.buyerJourney.step === "CART_INTERACTION") {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const today = input.shop.localTime.date;
  const message = MESSAGES[input.localization.language.isoCode] || MESSAGES.EN;

  /** @type {Map<string, { title: string, date: string }>} */
  const blocked = new Map();
  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (merchandise.__typename !== "ProductVariant") continue;
    const { product } = merchandise;
    const date = releaseDate(product.releaseDate?.value);
    if (date && date > today && !blocked.has(product.id)) {
      blocked.set(product.id, { title: product.title, date });
    }
  }

  const errors = [...blocked.values()].map(({ title, date }) => ({
    message: message(title, displayDate(date)),
    target: "$.cart",
  }));

  return { operations: [{ validationAdd: { errors } }] };
}
