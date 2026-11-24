import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { shopToday } from "../planned/dates";
import {
  ACTIVITY_KINDS,
  activityEntries,
  compareCustomers,
  customerLabel,
  customerPlans,
  formatTime,
  inDaysLabel,
  overviewMetrics,
  upcomingReleases,
} from "../planned/admin-views";
import { setupStatus } from "../planned/admin-data.server";
import {
  DataTable,
  IndexTable,
  MetricCard,
  MetricGrid,
  PageBody,
  Section,
  ToneBadge,
  formatNumber,
} from "../components/kit";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const now = new Date();
  const today = shopToday(now);
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [items, customers, emails, logs, setup] = await Promise.all([
    prisma.planItem.findMany({ where: { shop } }),
    prisma.planCustomer.findMany({ where: { shop } }),
    prisma.emailEvent.findMany({ where: { shop, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } }),
    prisma.activityLog.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 20 }),
    setupStatus(shop, session.scope),
  ]);

  return {
    metrics: overviewMetrics({ items, emails, today, now }),
    releases: upcomingReleases(items, today),
    customers: customerPlans(items, customers, today).map((row) => ({
      ...row,
      label: customerLabel(row, row.customerId),
      updatedLabel: formatTime(row.updatedAt),
    })),
    recent: activityEntries({ logs, emails: emails.slice(0, 20), customers })
      .slice(0, 8)
      .map((entry) => ({ ...entry, time: formatTime(entry.at) })),
    setup,
  };
};

function SetupBanners({ setup }) {
  const banners = [];
  if (setup.missingScopes.length) {
    banners.push(
      <s-banner key="scopes" tone="warning" heading="New permissions need approval">
        <s-paragraph>{`Open the app from Shopify admin → Apps and approve: ${setup.missingScopes.join(", ")}.`}</s-paragraph>
      </s-banner>,
    );
  }
  if (!setup.emailsEnabled || !setup.klaviyoConfigured) {
    banners.push(
      <s-banner key="emails" tone="info" heading="Customer emails are not being sent">
        <s-paragraph>
          {!setup.klaviyoConfigured
            ? "The Klaviyo key is not set on the server. Date changes and removals still update the plans and show a message in the cart."
            : "Emails are switched off. Date changes and removals still update the plans and show a message in the cart."}
        </s-paragraph>
        <s-button slot="secondary-actions" href="/app/settings">
          Open settings
        </s-button>
      </s-banner>,
    );
  }
  if (setup.checkStale) {
    banners.push(
      <s-banner key="check" tone={setup.lastCheck ? "warning" : "info"} heading="Nightly check">
        <s-paragraph>
          {setup.lastCheck
            ? `The last nightly check ran ${setup.lastCheck.label}. It should run every night.`
            : "The nightly check hasn't run yet. Run it once from Settings to see the result."}
        </s-paragraph>
      </s-banner>,
    );
  }
  return banners;
}

const customerColumns = [
  {
    key: "label",
    label: "Customer",
    listSlot: "primary",
    render: (row) => (
      <s-stack gap="small-500">
        <s-link href={`/app/customers/${row.customerId}`}>{row.label}</s-link>
        {row.email && row.name ? <s-text color="subdued">{row.email}</s-text> : null}
      </s-stack>
    ),
  },
  { key: "companyName", label: "Company", render: (row) => row.companyName || "—" },
  {
    key: "planned",
    label: "Planned",
    render: (row) => (row.planned ? `${row.planned} products · ${formatNumber(row.plannedQuantity)} pcs` : "—"),
  },
  {
    key: "orderable",
    label: "Now orderable",
    render: (row) => (row.orderable ? <s-badge tone="success">{`${row.orderable} waiting`}</s-badge> : "—"),
  },
  { key: "nextDateDisplay", label: "Next ordering date", render: (row) => row.nextDateDisplay || "—" },
  { key: "updatedLabel", label: "Last change" },
];

const customerFilters = [
  {
    key: "has",
    label: "Show",
    options: [
      { value: "all", label: "All customers" },
      { value: "planned", label: "With planned products" },
      { value: "orderable", label: "With orderable products waiting" },
    ],
    match: (row, value) => value === "all" || (value === "planned" ? row.planned > 0 : row.orderable > 0),
  },
];

export default function Overview() {
  const { metrics, releases, customers, recent, setup } = useLoaderData();
  const emailCaption = `${metrics.emails.failed} failed · ${metrics.emails.skipped} not sent`;

  return (
    <s-page heading="Planned orders" inlineSize="large">
      <s-button slot="secondary-actions" href="/app/settings">
        Settings
      </s-button>
      <PageBody>
        <SetupBanners setup={setup} />

        <MetricGrid>
          <MetricCard
            label="Customers with a plan"
            value={formatNumber(metrics.customers)}
            info="Each customer login has its own plan, also when several people work for the same company."
          />
          <MetricCard
            label="Planned, not orderable yet"
            value={`${formatNumber(metrics.plannedQuantity)} pcs`}
            caption={`${metrics.plannedProducts} products · ${metrics.dates} ordering dates`}
            info="Intent only: these are not orders and nothing is reserved."
          />
          <MetricCard
            label="Next ordering date"
            value={metrics.next ? metrics.next.dateDisplay : "—"}
            caption={metrics.next ? `${inDaysLabel(metrics.next.days)} · ${metrics.next.products} products` : "No future dates planned"}
          />
          <MetricCard
            label="Orderable, still in plans"
            value={formatNumber(metrics.waitingItems)}
            caption={`${formatNumber(metrics.waitingQuantity)} pcs · ${metrics.waitingCustomers} customers`}
            info="Products whose ordering date has passed but the customer hasn't added to an order yet."
          />
          <MetricCard
            label="Emails sent (30 days)"
            value={formatNumber(metrics.emails.sent)}
            caption={emailCaption}
            badge={<s-badge tone={setup.emailsEnabled && setup.klaviyoConfigured ? "success" : "neutral"}>{setup.emailsEnabled && setup.klaviyoConfigured ? "On" : "Off"}</s-badge>}
          />
        </MetricGrid>

        <Section
          heading="Upcoming ordering dates"
          info="Products customers planned, grouped by the distributor ordering date (custom.distributor_order_release_date). They become orderable at midnight Copenhagen time."
        >
          {releases.length ? (
            <s-stack gap="base">
              {releases.map((release) => (
                <s-box key={release.date} padding="base" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-heading>{`Ordering opens ${release.dateDisplay}`}</s-heading>
                        <s-badge tone="info">{inDaysLabel(release.days)}</s-badge>
                      </s-stack>
                      <s-text color="subdued">
                        {`${release.products.length} products · ${formatNumber(release.quantity)} pcs · ${release.customers} customers`}
                      </s-text>
                    </s-stack>
                    <DataTable
                      headers={["Product", "Planned pieces", "Customers"]}
                      rows={release.products.map((product) => [
                        product.productId ? (
                          <s-link key="p" href={`shopify://admin/products/${product.productId}`}>
                            {product.title}
                          </s-link>
                        ) : (
                          product.title
                        ),
                        formatNumber(product.quantity),
                        product.customers,
                      ])}
                    />
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          ) : (
            <s-text color="subdued">No planned products with a future ordering date.</s-text>
          )}
        </Section>

        <IndexTable
          heading="Customers"
          columns={customerColumns}
          rows={customers}
          rowKey={(row) => row.customerId}
          filters={customerFilters}
          search={{ placeholder: "Name, email or company", text: (row) => `${row.label} ${row.email || ""} ${row.companyName || ""}` }}
          sorts={[
            { value: "updated", label: "Last change", compare: (a, b) => b.updatedAt - a.updatedAt },
            { value: "pieces", label: "Planned pieces", compare: (a, b) => b.plannedQuantity - a.plannedQuantity },
            { value: "next", label: "Next ordering date", compare: compareCustomers.nextDate },
            { value: "name", label: "Name", compare: compareCustomers.name },
          ]}
          emptyText="No customer has a planned order yet."
        />

        <Section heading="Recent activity" actions={<s-link href="/app/activity">View all</s-link>}>
          <DataTable
            headers={["Time", "What happened", "Customer", "Product", "Details"]}
            empty="Nothing yet. Date changes, removals, emails and nightly checks appear here."
            rows={recent.map((entry) => [
              entry.time,
              <ToneBadge key="kind" entry={ACTIVITY_KINDS[entry.kind]} />,
              entry.customerId ? (
                <s-link key="c" href={`/app/customers/${entry.customerId}`}>
                  {entry.customer}
                </s-link>
              ) : (
                "—"
              ),
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
