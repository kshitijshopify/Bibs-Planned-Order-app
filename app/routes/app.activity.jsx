import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ACTIVITY_GROUPS, ACTIVITY_KINDS, activityEntries, formatTime } from "../planned/admin-views";
import { IndexTable, PageBody, ToneBadge } from "../components/kit";

const LIMIT = 500;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [logs, emails, customers] = await Promise.all([
    prisma.activityLog.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: LIMIT }),
    prisma.emailEvent.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: LIMIT }),
    prisma.planCustomer.findMany({ where: { shop }, select: { customerId: true, name: true, email: true } }),
  ]);
  return {
    entries: activityEntries({ logs, emails, customers })
      .slice(0, LIMIT)
      .map((entry) => ({ ...entry, time: formatTime(entry.at) })),
  };
};

const columns = [
  { key: "time", label: "Time" },
  { key: "kind", label: "What happened", listSlot: "primary", render: (row) => <ToneBadge entry={ACTIVITY_KINDS[row.kind]} /> },
  {
    key: "customer",
    label: "Customer",
    render: (row) => (row.customerId ? <s-link href={`/app/customers/${row.customerId}`}>{row.customer}</s-link> : "—"),
  },
  {
    key: "product",
    label: "Product",
    render: (row) => (row.productId ? <s-link href={`shopify://admin/products/${row.productId}`}>{row.product}</s-link> : row.product || "—"),
  },
  { key: "text", label: "Details" },
  { key: "source", label: "Source", render: (row) => row.source || "—" },
];

const filters = [
  {
    key: "group",
    label: "Type",
    options: ACTIVITY_GROUPS.map(({ value, label }) => ({ value, label })),
    match: (row, value) => value === "all" || ACTIVITY_GROUPS.find((g) => g.value === value)?.kinds?.includes(row.kind),
  },
];

export default function Activity() {
  const { entries } = useLoaderData();
  return (
    <s-page heading="Activity" inlineSize="large">
      <PageBody>
        <s-paragraph>
          {`Everything the app did, newest first (last ${LIMIT}): ordering date changes, removals, emails and nightly checks. ` +
            "Customers' own changes to their plans (adding, quantities) are not listed."}
        </s-paragraph>
        <IndexTable
          columns={columns}
          rows={entries}
          rowKey={(row) => row.key}
          filters={filters}
          search={{ placeholder: "Customer, product or details", text: (row) => `${row.customer} ${row.product} ${row.text}` }}
          emptyText="Nothing yet."
        />
      </PageBody>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
