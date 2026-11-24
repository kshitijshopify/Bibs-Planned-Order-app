// Webhook customers/delete: the customer's plan, cart messages and email rows
// are deleted. Activity entries keep only the customer ID.

import { authenticate } from "../shopify.server";
import { toLegacyId } from "../planned/ids";
import { repo } from "../planned/jobs.server";

export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  const customerId = toLegacyId(payload?.id ?? "");
  if (customerId) await repo.deleteCustomerData(shop, customerId);
  return new Response();
};
