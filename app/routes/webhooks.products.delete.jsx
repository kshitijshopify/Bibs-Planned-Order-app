// Webhook products/delete: the product leaves every plan; each customer gets a
// cart message and (if switched on) an email naming the product.

import { authenticate } from "../shopify.server";
import { toLegacyId } from "../planned/ids";
import { onProductChanged } from "../planned/jobs.server";

export const action = async ({ request }) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  const productId = toLegacyId(payload?.id ?? "");
  if (!productId) return new Response();

  const result = await onProductChanged({ shop, productId, deleted: true, admin });
  if (result.events.length) {
    console.log(`[plan] ${shop}: deleted product ${productId} removed from ${result.events.length} plan(s)`);
  }
  return new Response();
};
