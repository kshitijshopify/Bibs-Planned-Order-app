// Storefront: GET/POST /apps/planned-order/plan (app proxy -> /proxy/plan).
//
// Shopify signs every proxied request; authenticate.public.appProxy checks the
// signature, so logged_in_customer_id can be trusted. A customer only ever
// reads and changes their own plan.

import { authenticate } from "../shopify.server";
import { prismaRepo } from "../planned/repo.server";
import { getPlan, toClientPlan, updatePlan } from "../planned/plan";
import { LIMITS, parseOps, PlanRequestError } from "../planned/ops";
import { fetchCustomerProfile, lookupVariants } from "../planned/shopify";
import { refreshProfileIfStale } from "../planned/profile";
import { toLegacyId } from "../planned/ids";
import { onCartEvents } from "../planned/jobs.server";

const repo = prismaRepo();

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function proxyContext(request) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) throw json({ ok: false, error: "The planned-order app is not installed." }, 401);
  const customerId = toLegacyId(new URL(request.url).searchParams.get("logged_in_customer_id") || "");
  if (!customerId) throw json({ ok: false, error: "Log in to use the planned order." }, 401);
  return { shop: session.shop, admin, customerId };
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > LIMITS.maxBodyBytes) throw new PlanRequestError("Request too large", 413);
  const text = await request.text();
  if (text.length > LIMITS.maxBodyBytes) throw new PlanRequestError("Request too large", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new PlanRequestError("Invalid JSON");
  }
}

export const loader = async ({ request }) => {
  const { shop, customerId } = await proxyContext(request);
  const plan = await getPlan({ repo, shop, customerId });
  return json({ ok: true, ...toClientPlan(plan) });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const { shop, admin, customerId } = await proxyContext(request);

  let parsed;
  try {
    parsed = parseOps(await readBody(request));
  } catch (error) {
    if (error instanceof PlanRequestError) return json({ ok: false, error: error.message }, error.status);
    throw error;
  }

  const result = await updatePlan({
    repo,
    shop,
    customerId,
    ops: parsed.ops,
    lookupVariants: admin ? (ids) => lookupVariants(admin, ids) : null,
  });

  if (admin && result.changed) {
    // Name/email/company for the admin and emails, then emails for changes the
    // cart found (date changed, product gone). Never delays the response.
    refreshProfileIfStale({
      repo,
      shop,
      customerId,
      fetchProfile: (id) => fetchCustomerProfile(admin, id),
    })
      .catch((error) => console.warn(`[plan] Profile refresh failed: ${error.message}`))
      .then(() => onCartEvents({ shop, customerId, events: result.events, admin }))
      .catch((error) => console.error(`[plan] Emails for cart changes failed: ${error.message}`));
  }

  return json({
    ok: true,
    ...toClientPlan(result),
    rejected: [...parsed.rejected, ...result.rejected],
  });
};
