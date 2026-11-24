// Admin API reads used by the planned order. `admin` is the client from
// authenticate.public.appProxy / authenticate.admin / unauthenticated.admin.

import { customerGid, productGid, toLegacyId, variantGid } from "./ids.js";
import { normalizeReleaseDate } from "./dates.js";

export const RELEASE_METAFIELD = { namespace: "custom", key: "distributor_order_release_date" };

/** Products customers can see: ACTIVE, and UNLISTED (hidden from search, still reachable). */
export const LIVE_STATUSES = ["ACTIVE", "UNLISTED"];
export const isLiveStatus = (status) => LIVE_STATUSES.includes(status);

const VARIANT_CHUNK = 50;
const PRODUCT_CHUNK = 25;
const PUBLICATION_CHUNK = 20;
const CUSTOMER_CHUNK = 20;
const LOCATION_CHUNK = 25;

const VARIANTS_QUERY = `#graphql
  query PlannedOrderVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        product {
          id
          handle
          title
          status
          onlineStoreUrl
          featuredMedia {
            preview {
              image {
                url
              }
            }
          }
          releaseDate: metafield(namespace: "${RELEASE_METAFIELD.namespace}", key: "${RELEASE_METAFIELD.key}") {
            value
          }
        }
      }
    }
  }`;

const CUSTOMER_QUERY = `#graphql
  query PlannedOrderCustomer($id: ID!) {
    customer(id: $id) {
      displayName
      defaultEmailAddress {
        emailAddress
      }
      companyContactProfiles {
        company {
          name
        }
      }
    }
  }`;

const CUSTOMER_LOCATIONS_QUERY = `#graphql
  query PlannedOrderCustomerLocations($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer {
        id
        companyContactProfiles {
          roleAssignments(first: 20) {
            nodes {
              companyLocation {
                id
              }
            }
          }
        }
      }
    }
  }`;

const LOCATION_CATALOGS_QUERY = `#graphql
  query PlannedOrderLocationCatalogs($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on CompanyLocation {
        id
        catalogs(first: 10) {
          nodes {
            status
            publication {
              id
            }
          }
        }
      }
    }
  }`;

const SHOP_QUERY = `#graphql
  query PlannedOrderShop {
    shop {
      primaryDomain {
        url
      }
    }
  }`;

async function graphql(admin, query, variables) {
  const response = await admin.graphql(query, { variables, tries: 3 });
  const json = await response.json();
  if (json.errors?.length) {
    const messages = Array.isArray(json.errors) ? json.errors.map((error) => error.message) : [String(json.errors)];
    throw new Error(messages.join("; "));
  }
  return json.data;
}

function chunks(list, size) {
  const result = [];
  for (let start = 0; start < list.length; start += size) result.push(list.slice(start, start + size));
  return result;
}

function productState(product) {
  return {
    productId: toLegacyId(product.id),
    handle: product.handle,
    title: product.title,
    status: product.status,
    onlineStoreUrl: product.onlineStoreUrl || null,
    imageUrl: product.featuredMedia?.preview?.image?.url || null,
    releaseDate: normalizeReleaseDate(product.releaseDate?.value),
  };
}

/**
 * Map variantId -> product state, or null when Shopify has no such variant
 * (deleted variant or product). With `skipFailedChunks`, a failed request
 * leaves its ids out of the map (unknown) instead of throwing.
 */
export async function lookupVariants(admin, variantIds, { skipFailedChunks = false, logger = console } = {}) {
  const result = new Map();
  for (const chunk of chunks(variantIds, VARIANT_CHUNK)) {
    let data;
    try {
      data = await graphql(admin, VARIANTS_QUERY, { ids: chunk.map(variantGid) });
    } catch (error) {
      if (!skipFailedChunks) throw error;
      logger.warn(`[plan] Variant lookup failed for ${chunk.length} variants: ${error.message}`);
      continue;
    }
    chunk.forEach((id, index) => {
      const product = data?.nodes?.[index]?.product;
      result.set(id, product ? productState(product) : null);
    });
  }
  return result;
}

/**
 * Name, email and company for the admin lists and emails. Needs read_customers
 * and protected customer data access; without it Shopify returns an error.
 */
export async function fetchCustomerProfile(admin, customerId) {
  const data = await graphql(admin, CUSTOMER_QUERY, { id: customerGid(customerId) });
  const customer = data?.customer;
  if (!customer) return null;
  const companies = (customer.companyContactProfiles || [])
    .map((profile) => profile?.company?.name)
    .filter(Boolean);
  return {
    name: customer.displayName || null,
    email: customer.defaultEmailAddress?.emailAddress || null,
    companyName: companies.length ? [...new Set(companies)].join(", ") : null,
  };
}

/** Map customerId -> company location ids the customer can buy for ([] = not a B2B contact). */
export async function fetchCustomerLocations(admin, customerIds) {
  const result = new Map();
  for (const chunk of chunks(customerIds, CUSTOMER_CHUNK)) {
    const data = await graphql(admin, CUSTOMER_LOCATIONS_QUERY, { ids: chunk.map(customerGid) });
    chunk.forEach((id, index) => {
      const node = data?.nodes?.[index];
      if (!node) return; // customer deleted: unknown
      const locations = (node.companyContactProfiles || []).flatMap((profile) =>
        (profile?.roleAssignments?.nodes || []).map((assignment) => assignment?.companyLocation?.id).filter(Boolean),
      );
      result.set(id, [...new Set(locations)]);
    });
  }
  return result;
}

/** Map locationGid -> [{ status, publicationId }] for the location's catalogs. */
export async function fetchLocationCatalogs(admin, locationIds) {
  const result = new Map();
  for (const chunk of chunks(locationIds, LOCATION_CHUNK)) {
    const data = await graphql(admin, LOCATION_CATALOGS_QUERY, { ids: chunk });
    chunk.forEach((id, index) => {
      const node = data?.nodes?.[index];
      if (!node) return;
      result.set(
        id,
        (node.catalogs?.nodes || []).map((catalog) => ({
          status: catalog.status,
          publicationId: catalog.publication?.id || null,
        })),
      );
    });
  }
  return result;
}

/** Map productId -> Map publicationGid -> published? (needs read_publications). */
export async function fetchProductPublications(admin, productIds, publicationIds) {
  const result = new Map(productIds.map((id) => [id, new Map()]));
  if (!publicationIds.length) return result;
  for (const productChunk of chunks(productIds, PRODUCT_CHUNK)) {
    for (const publicationChunk of chunks(publicationIds, PUBLICATION_CHUNK)) {
      const fields = publicationChunk
        .map((publicationId, index) => `p${index}: publishedOnPublication(publicationId: ${JSON.stringify(publicationId)})`)
        .join("\n");
      const query = `#graphql
        query PlannedOrderProductPublications($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              ${fields}
            }
          }
        }`;
      const data = await graphql(admin, query, { ids: productChunk.map(productGid) });
      productChunk.forEach((productId, index) => {
        const node = data?.nodes?.[index];
        if (!node) return;
        publicationChunk.forEach((publicationId, publicationIndex) => {
          const value = node[`p${publicationIndex}`];
          if (typeof value === "boolean") result.get(productId).set(publicationId, value);
        });
      });
    }
  }
  return result;
}

/** https://shop-domain (no trailing slash), for links in emails. */
export async function fetchStorefrontUrl(admin) {
  const data = await graphql(admin, SHOP_QUERY, {});
  return (data?.shop?.primaryDomain?.url || "").replace(/\/$/, "") || null;
}
