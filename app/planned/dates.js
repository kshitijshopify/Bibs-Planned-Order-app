// Distributor ordering dates are calendar dates (YYYY-MM-DD) in the shop's
// timezone, Europe/Copenhagen for BIBS.

export const SHOP_TIMEZONE = "Europe/Copenhagen";

/** "2027-02-15" from a date or date_time metafield value, else "" (orderable). */
export function normalizeReleaseDate(value) {
  if (value == null) return "";
  const text = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? text : "";
}

/** "15/02/2027", the same format as the theme. */
export function displayDate(iso) {
  const date = normalizeReleaseDate(iso);
  if (!date) return "";
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

/** Today's date (YYYY-MM-DD) in the shop timezone; DST is handled by Intl. */
export function shopToday(now = new Date(), timeZone = SHOP_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** True when the product can't be ordered yet on `today`. */
export function isFutureRelease(releaseDate, today) {
  const date = normalizeReleaseDate(releaseDate);
  return Boolean(date) && date > today;
}
