// Event (shopify.app.toml [events] "release-date-changed"): a product's
// custom.distributor_order_release_date value changed. Every plan with the
// product gets the new date, a cart message and (if switched on) an email.
//
// The work runs before the response: if it fails, Shopify delivers again.

import { authenticate } from "../shopify.server";
import { toLegacyId } from "../planned/ids";
import { onProductChanged } from "../planned/jobs.server";

export const action = async ({ request }) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  const productId = toLegacyId(payload?.query_variables?.productId || payload?.data?.product?.id || "");
  if (!productId || !admin) return new Response();

  const result = await onProductChanged({ shop, productId, admin });
  if (result.events.length) {
    console.log(`[plan] ${shop}: ordering date of product ${productId} changed for ${result.events.length} plan(s)`);
  }
  return new Response();
};
