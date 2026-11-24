// Keeps the customer's name, email and company (for the admin lists and the
// emails) at most a day old. Failures never block the planned order.

export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PROFILE_RETRY_MS = 60 * 60 * 1000;

export async function refreshProfileIfStale({
  repo,
  shop,
  customerId,
  fetchProfile,
  now = new Date(),
  logger = console,
  force = false,
}) {
  const customer = await repo.getCustomer(shop, customerId);
  if (!customer) return null;
  const age = customer.profileAt ? now.getTime() - new Date(customer.profileAt).getTime() : Infinity;
  // force: an email is about to be sent and the address is missing.
  if (age < PROFILE_MAX_AGE_MS && !(force && !customer.email)) return customer;

  try {
    const profile = await fetchProfile(customerId);
    return await repo.upsertCustomer(shop, customerId, {
      name: profile?.name ?? null,
      email: profile?.email ?? null,
      companyName: profile?.companyName ?? null,
      profileAt: now,
    });
  } catch (error) {
    logger.warn(`[plan] Customer ${customerId} profile not loaded: ${error.message}`);
    // Try again in an hour instead of on every request.
    return repo.upsertCustomer(shop, customerId, {
      profileAt: new Date(now.getTime() - PROFILE_MAX_AGE_MS + PROFILE_RETRY_MS),
    });
  }
}
