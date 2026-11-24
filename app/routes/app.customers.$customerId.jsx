import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { displayDate, shopToday } from "../planned/dates";
import {
  ACTIVITY_KINDS,
  activityEntries,
  customerItemGroups,
  customerLabel,
  formatTime,
  inDaysLabel,
} from "../planned/admin-views";
import { toLegacyId, variantGid } from "../planned/ids";
import { DataTable, DetailList, MetricCard, MetricGrid, PageBody, Section, ToneBadge, formatNumber } from "../components/kit";

const VARIANT_TITLES = `#graphql
  query PlannedOrderVariantTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
      }
    }
  }`;

async function variantDetails(admin, variantIds) {
  if (!variantIds.length) return {};
  try {
    const response = await admin.graphql(VARIANT_TITLES, { variables: { ids: variantIds.map(variantGid) } });
    const json = await response.json();
    return Object.fromEntries((json.data?.nodes || []).filter(Boolean).map((node) => [toLegacyId(node.id), node]));
  } catch {
    return {};
  }
}

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const customerId = toLegacyId(params.customerId || "");
  if (!customerId) throw new Response("Not found", { status: 404 });

  const [items, customer, logs, emails] = await Promise.all([
    prisma.planItem.findMany({ where: { shop, customerId }, orderBy: [{ releaseDate: "asc" }, { addedAt: "asc" }] }),
    prisma.planCustomer.findUnique({ where: { shop_customerId: { shop, customerId } } }),
    prisma.activityLog.findMany({ where: { shop, customerId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.emailEvent.findMany({ where: { shop, customerId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const variants = await variantDetails(admin, items.slice(0, 100).map((item) => item.variantId));
  const today = shopToday();

  const toRow = (item) => ({
    id: item.id,
    productId: item.productId,
    title: item.title || item.handle,
    variant: [variants[item.variantId]?.title, variants[item.variantId]?.sku].filter((v) => v && v !== "Default Title").join(" · "),
    quantity: item.quantity,
    dateDisplay: displayDate(item.releaseDate),
    addedLabel: formatTime(item.addedAt),
    hiddenSince: item.missingSince ? formatTime(item.missingSince) : null,
  });
  const groups = customerItemGroups(items, today);

  return {
    customerId,
    label: customerLabel(customer, customerId),
    email: customer?.email || null,
    companyName: customer?.companyName || null,
    hasProfile: Boolean(customer?.profileAt && (customer?.name || customer?.email)),
    updatedLabel: formatTime(customer?.planUpdatedAt),
    migratedLabel: formatTime(customer?.migratedAt),
    planned: groups.planned.map((group) => ({ ...group, items: group.items.map(toRow) })),
    available: groups.available.map(toRow),
    kept: groups.kept.map(toRow),
    totals: {
      planned: groups.planned.reduce((n, g) => n + g.items.reduce((s, i) => s + i.quantity, 0), 0),
      plannedProducts: groups.planned.reduce((n, g) => n + g.items.length, 0),
      available: groups.available.length,
      kept: groups.kept.length,
    },
    activity: activityEntries({ logs, emails, customers: customer ? [customer] : [] }).map((entry) => ({
      ...entry,
      time: formatTime(entry.at),
    })),
  };
};

function productCell(row) {
  return (
    <s-stack key="product" gap="small-500">
      {row.productId ? <s-link href={`shopify://admin/products/${row.productId}`}>{row.title}</s-link> : <s-text>{row.title}</s-text>}
      {row.variant ? <s-text color="subdued">{row.variant}</s-text> : null}
      {row.hiddenSince ? <s-badge tone="warning">{`Hidden from customer since ${row.hiddenSince}`}</s-badge> : null}
    </s-stack>
  );
}

const itemRows = (rows, withDate) =>
  rows.map((row) => [productCell(row), formatNumber(row.quantity), ...(withDate ? [row.dateDisplay || "—"] : []), row.addedLabel]);

export default function CustomerPlan() {
  const data = useLoaderData();
  const empty = !data.planned.length && !data.available.length && !data.kept.length;

  return (
    <s-page heading={data.label} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Planned orders
      </s-link>
      <s-button slot="secondary-actions" href={`shopify://admin/customers/${data.customerId}`}>
        Open customer in Shopify
      </s-button>
      <PageBody>
        {!data.hasProfile ? (
          <s-banner tone="info" heading="Name and email not loaded yet">
            <s-paragraph>
              {"They load after the customer's next change, or at the nightly check. If they never appear, check " +
                "Protected customer data access in the Dev Dashboard."}
            </s-paragraph>
          </s-banner>
        ) : null}

        <MetricGrid>
          <MetricCard
            label="Planned, not orderable yet"
            value={`${formatNumber(data.totals.planned)} pcs`}
            caption={`${data.totals.plannedProducts} products`}
          />
          <MetricCard label="Now orderable, waiting" value={formatNumber(data.totals.available)} caption="Released, not added to an order yet" />
          <MetricCard label="Kept for later" value={formatNumber(data.totals.kept)} caption="Released, excluded from a checkout by the customer" />
        </MetricGrid>

        <Section heading="Customer">
          <DetailList
            items={[
              ["Email", data.email || "—"],
              ["Company", data.companyName || "—"],
              ["Customer ID", data.customerId],
              ["Last change to the plan", data.updatedLabel || "—"],
              data.migratedLabel ? ["Browser plan copied", data.migratedLabel] : null,
            ]}
          />
        </Section>

        {empty ? (
          <Section heading="Planned order">
            <s-text color="subdued">{"This customer's planned order is empty."}</s-text>
          </Section>
        ) : null}

        {data.planned.map((group) => (
          <Section
            key={group.date}
            heading={`Ordering opens ${group.dateDisplay}`}
            actions={<s-badge tone="info">{inDaysLabel(group.days)}</s-badge>}
          >
            <DataTable headers={["Product", "Pieces", "Added"]} rows={itemRows(group.items, false)} />
          </Section>
        ))}

        {data.available.length ? (
          <Section
            heading="Now orderable, waiting in the cart"
            info="The ordering date has passed. The customer sees these at the top of the cart and is asked before checkout whether to include them."
          >
            <DataTable headers={["Product", "Pieces", "Ordering date", "Added"]} rows={itemRows(data.available, true)} />
          </Section>
        ) : null}

        {data.kept.length ? (
          <Section heading="Kept for later" info="Released products the customer chose not to include in a checkout. They stay until added or removed.">
            <DataTable headers={["Product", "Pieces", "Ordering date", "Added"]} rows={itemRows(data.kept, true)} />
          </Section>
        ) : null}

        <Section heading="Activity and emails">
          <DataTable
            headers={["Time", "What happened", "Product", "Details"]}
            empty="Nothing yet."
            rows={data.activity.map((entry) => [
              entry.time,
              <ToneBadge key="kind" entry={ACTIVITY_KINDS[entry.kind]} />,
              entry.product || "—",
              entry.text,
            ])}
          />
        </Section>
      </PageBody>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
