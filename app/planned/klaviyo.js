/* eslint-env node */
// Klaviyo server-side events (https://developers.klaviyo.com/en/reference/create_event).
// A Klaviyo flow triggered by the metric sends the actual email.
// Key: KLAVIYO_PRIVATE_KEY (private API key with the events:write scope).
// Server only: environment variables are read inside the functions.

export { METRICS } from "./metrics.js";

const API = "https://a.klaviyo.com/api";
const DEFAULT_REVISION = "2026-10-15";

export function klaviyoRevision(env = process.env) {
  return env.KLAVIYO_REVISION || DEFAULT_REVISION;
}

export function klaviyoConfig(env = process.env) {
  const key = String(env.KLAVIYO_PRIVATE_KEY || "").trim();
  return {
    key,
    configured: key.length >= 10,
    masked: key ? `${key.slice(0, 3)}…${key.slice(-4)}` : null,
  };
}

function headers(key) {
  return {
    Authorization: `Klaviyo-API-Key ${key}`,
    revision: klaviyoRevision(),
    accept: "application/vnd.api+json",
    "content-type": "application/vnd.api+json",
  };
}

async function errorText(response) {
  try {
    const json = await response.json();
    const first = json?.errors?.[0];
    return first ? `${first.title || ""}${first.detail ? `: ${first.detail}` : ""}`.trim() : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * Sends one event. Returns { ok, status, error, retryable }.
 * uniqueId makes Klaviyo ignore a repeated send of the same change.
 */
export async function sendKlaviyoEvent({ key, metric, email, properties, uniqueId, time, fetchImpl = fetch }) {
  const body = {
    data: {
      type: "event",
      attributes: {
        properties,
        metric: { data: { type: "metric", attributes: { name: metric } } },
        profile: { data: { type: "profile", attributes: { email } } },
        unique_id: uniqueId,
        ...(time ? { time: new Date(time).toISOString() } : {}),
      },
    },
  };
  try {
    const response = await fetchImpl(`${API}/events`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify(body),
    });
    if (response.status === 202 || response.ok) return { ok: true, status: response.status };
    return {
      ok: false,
      status: response.status,
      error: await errorText(response),
      retryable: response.status === 429 || response.status >= 500,
    };
  } catch (error) {
    return { ok: false, status: 0, error: error.message, retryable: true };
  }
}

/** Checks the key: { ok, status, account?, error? }. A 403 means the key works but can't read the account. */
export async function checkKlaviyoKey({ key, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(`${API}/accounts`, { headers: headers(key) });
    if (response.ok) {
      const json = await response.json();
      const info = json?.data?.[0]?.attributes?.contact_information;
      return { ok: true, status: response.status, account: info?.organization_name || info?.default_sender_name || null };
    }
    if (response.status === 403) return { ok: true, status: 403, account: null };
    return { ok: false, status: response.status, error: await errorText(response) };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}
