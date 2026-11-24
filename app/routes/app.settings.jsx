/* eslint-disable react/prop-types -- small page-local components, plain JS app */
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, setupStatus } from "../planned/admin-data.server";
import { describeCheckRun, formatTime } from "../planned/admin-views";
import { checkKlaviyoKey, klaviyoConfig, klaviyoRevision, sendKlaviyoEvent } from "../planned/klaviyo";
import { METRICS } from "../planned/metrics";
import { deliverEmails, defaultDeps } from "../planned/jobs";
import { repo, runNightlyForShop } from "../planned/jobs.server";
import { propertiesFor } from "../planned/emails";
import { shopToday } from "../planned/dates";
import { ChoiceField, DataTable, DetailList, PageBody, Section, SwitchField, TextField } from "../components/kit";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [settings, setup] = await Promise.all([getSettings(session.shop), setupStatus(session.shop, session.scope)]);
  return {
    emailsEnabled: settings.emailsEnabled,
    updatedLabel: settings.updatedAt ? formatTime(settings.updatedAt) : null,
    updatedBy: settings.updatedBy,
    storefrontUrl: settings.storefrontUrl,
    revision: klaviyoRevision(),
    setup: { ...setup, lastCheckText: setup.lastCheck ? describeCheckRun(setup.lastCheck.details) : null },
  };
};

const SAMPLE_EVENT = {
  date_changed: {
    type: "date_changed",
    productId: "test",
    title: "Test product (planned order)",
    handle: "test-product",
    imageUrl: null,
    quantity: 12,
    from: "2027-02-15",
    to: "2027-03-01",
  },
  removed: { type: "removed", productId: "test", title: "Test product (planned order)", quantity: 12 },
};

async function sendTestEmail(shop, email, kind) {
  const klaviyo = klaviyoConfig();
  if (!klaviyo.configured) return { ok: false, error: "The Klaviyo key is not set on the server (KLAVIYO_PRIVATE_KEY)." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
  const settings = await getSettings(shop);
  const now = new Date();
  const properties = { ...propertiesFor(SAMPLE_EVENT[kind], { storefrontUrl: settings.storefrontUrl, today: shopToday(now) }), Test: true };
  const uniqueId = `planned-order:test:${now.getTime()}`;
  const result = await sendKlaviyoEvent({ key: klaviyo.key, metric: METRICS[kind], email, properties, uniqueId, time: now });
  await prisma.emailEvent.create({
    data: {
      shop,
      customerId: "test",
      email,
      kind: "test",
      metric: METRICS[kind],
      uniqueId,
      title: "Test email",
      properties: JSON.stringify(properties),
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : result.error,
      attempts: 5,
      lastAttemptAt: now,
      sentAt: result.ok ? now : null,
    },
  });
  return result.ok
    ? { ok: true, message: `"${METRICS[kind]}" sent to Klaviyo for ${email}. A live flow on this metric sends the email.` }
    : { ok: false, error: `Klaviyo answered: ${result.error}` };
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "emails") {
      const enabled = form.get("value") === "on";
      const user = session.onlineAccessInfo?.associated_user?.email || "admin";
      await repo.saveSettings(shop, { emailsEnabled: enabled, updatedBy: user });
      return { ok: true, intent, message: enabled ? "Customer emails switched on" : "Customer emails switched off" };
    }
    if (intent === "check-klaviyo") {
      const klaviyo = klaviyoConfig();
      if (!klaviyo.configured) return { ok: false, intent, error: "The Klaviyo key is not set on the server (KLAVIYO_PRIVATE_KEY)." };
      const result = await checkKlaviyoKey({ key: klaviyo.key });
      if (!result.ok) return { ok: false, intent, error: `Klaviyo refused the key: ${result.error}` };
      return {
        ok: true,
        intent,
        message:
          result.status === 403
            ? "The key works. (It can't read account details, which is fine; it needs events:write.)"
            : `Connected${result.account ? ` to ${result.account}` : ""}.`,
      };
    }
    if (intent === "test-email") {
      const kind = form.get("kind") === "removed" ? "removed" : "date_changed";
      return { intent, ...(await sendTestEmail(shop, String(form.get("email") || "").trim(), kind)) };
    }
    if (intent === "run-check") {
      const summary = await runNightlyForShop(shop, admin);
      return { ok: true, intent, message: `Check finished: ${describeCheckRun(summary)}` };
    }
    if (intent === "retry-emails") {
      const summary = await deliverEmails({ repo, shop, deps: defaultDeps() });
      return { ok: true, intent, message: `Emails: ${summary.sent} sent, ${summary.failed} failed, ${summary.skipped} not sent.` };
    }
    return { ok: false, intent, error: "Unknown action." };
  } catch (error) {
    return { ok: false, intent, error: error.message };
  }
};

const KIND_OPTIONS = [
  { value: "date_changed", label: METRICS.date_changed, details: "Ordering date changed (sample: 15/02/2027 → 01/03/2027)" },
  { value: "removed", label: METRICS.removed, details: "Product removed from the plan" },
];

const DATE_PROPERTIES = [
  ["ProductTitle", "Product name"],
  ["ProductURL", "Link to the product page"],
  ["ProductImageURL", "Product image"],
  ["Quantity", "Planned pieces (all variants)"],
  ["PreviousDateFormatted", "Old ordering date, e.g. 15/02/2027"],
  ["NewDateFormatted", "New ordering date, e.g. 01/03/2027 (empty if orderable now)"],
  ["OrderableNow", "true when the product can be ordered already"],
  ["CartURL", "Link to the cart"],
];
const REMOVED_PROPERTIES = [
  ["ProductTitle", "Product name (no link or image: the customer can't see the product any more)"],
  ["Quantity", "Pieces that were planned"],
  ["CartURL", "Link to the cart"],
];

function StatusBadge({ ok, okText = "Done", notText = "To do" }) {
  return <s-badge tone={ok ? "success" : "warning"}>{ok ? okText : notText}</s-badge>;
}

export default function Settings() {
  const data = useLoaderData();
  const { setup } = data;
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [testEmail, setTestEmail] = useState("");
  const [testKind, setTestKind] = useState("date_changed");
  const busy = (intent) => fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent;
  const result = (intent) => (fetcher.data?.intent === intent ? fetcher.data : null);

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.intent === "emails") shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);

  const submit = (intent, values = {}) => fetcher.submit({ intent, ...values }, { method: "POST" });
  const emailsOn = fetcher.formData?.get("intent") === "emails" ? fetcher.formData.get("value") === "on" : data.emailsEnabled;

  const Result = ({ intent }) => {
    const r = result(intent);
    if (!r) return null;
    return <s-banner tone={r.ok ? "success" : "critical"}>{r.ok ? r.message : r.error}</s-banner>;
  };

  return (
    <s-page heading="Settings">
      <PageBody>
        <Section
          heading="Customer emails"
          info="When a planned product's ordering date changes, or it is removed from a plan, the app sends a Klaviyo event. A Klaviyo flow turns it into the email."
        >
          <SwitchField
            label="Email customers about date changes and removals"
            details="Off: plans are still updated and the cart still shows a message; the emails are listed in Activity as not sent."
            checked={emailsOn}
            onChange={(next) => submit("emails", { value: next ? "on" : "off" })}
            disabled={busy("emails")}
          />
          {emailsOn && !setup.klaviyoConfigured ? (
            <s-banner tone="warning">Emails are on, but the Klaviyo key is not set on the server, so nothing is sent yet.</s-banner>
          ) : null}
          {data.updatedLabel ? <s-text color="subdued">{`Last changed ${data.updatedLabel}${data.updatedBy ? ` by ${data.updatedBy}` : ""}`}</s-text> : null}
          <Result intent="emails" />
        </Section>

        <Section heading="Klaviyo" info="The private API key is a server setting (KLAVIYO_PRIVATE_KEY), never stored in the app's database. It needs the events:write scope.">
          <DetailList
            items={[
              ["Private API key", setup.klaviyoConfigured ? `Set (${setup.klaviyoMasked})` : "Not set"],
              ["API revision", data.revision],
              ["Store link in emails", data.storefrontUrl || "Loaded with the first email"],
            ]}
          />
          <s-stack direction="inline" gap="small">
            <s-button onClick={() => submit("check-klaviyo")} {...(busy("check-klaviyo") ? { loading: true } : {})} {...(!setup.klaviyoConfigured ? { disabled: true } : {})}>
              Check connection
            </s-button>
            <s-button onClick={() => submit("retry-emails")} {...(busy("retry-emails") ? { loading: true } : {})}>
              Send waiting emails now
            </s-button>
          </s-stack>
          <Result intent="check-klaviyo" />
          <Result intent="retry-emails" />
        </Section>

        <Section heading="Send a test event" info="Sends one sample event to Klaviyo with Test = true, so the flow and the email template can be checked. It is sent even while customer emails are off.">
          <TextField label="Email address" value={testEmail} onChange={setTestEmail} placeholder="you@bibsworld.com" />
          <ChoiceField label="Event" name="kind" value={testKind} options={KIND_OPTIONS} onChange={setTestKind} />
          <s-stack direction="inline">
            <s-button
              variant="primary"
              onClick={() => submit("test-email", { email: testEmail, kind: testKind })}
              {...(busy("test-email") ? { loading: true } : {})}
              {...(!setup.klaviyoConfigured || !testEmail.trim() ? { disabled: true } : {})}
            >
              Send test event
            </s-button>
          </s-stack>
          <Result intent="test-email" />
        </Section>

        <Section heading="Klaviyo flows to create" info="One flow per metric, each with the trigger 'Metric' and one email. Use the event properties below in the email template, e.g. {{ event.ProductTitle }}.">
          <s-stack gap="base">
            <s-stack gap="small">
              <s-heading>{METRICS.date_changed}</s-heading>
              <DataTable headers={["Property", "Meaning"]} rows={DATE_PROPERTIES.map(([name, meaning]) => [`event.${name}`, meaning])} />
            </s-stack>
            <s-stack gap="small">
              <s-heading>{METRICS.removed}</s-heading>
              <DataTable headers={["Property", "Meaning"]} rows={REMOVED_PROPERTIES.map(([name, meaning]) => [`event.${name}`, meaning])} />
            </s-stack>
            <s-text color="subdued">Test events have the property Test = true; add a flow filter to skip them once the flows are live.</s-text>
          </s-stack>
        </Section>

        <Section
          heading="Nightly check"
          info="Catches date changes that weren't reported, deleted products and products no longer in a customer's B2B catalogue, refreshes customer names and emails, and retries failed emails."
        >
          <DetailList
            items={[
              ["Last run", setup.lastCheck ? setup.lastCheck.label : "Never"],
              ["Result", setup.lastCheckText || "—"],
              ["Scheduler secret (PLANNED_ORDER_CRON_SECRET)", setup.cronConfigured ? "Set" : "Not set"],
            ]}
          />
          <s-text color="subdued">
            {"A product hidden from a customer's catalogue is removed only when two checks in a row (a day apart) can't find it, " +
              "so a product unpublished by mistake for a few hours stays in the plans."}
          </s-text>
          <s-stack direction="inline">
            <s-button onClick={() => submit("run-check")} {...(busy("run-check") ? { loading: true } : {})}>
              Run check now
            </s-button>
          </s-stack>
          <Result intent="run-check" />
        </Section>

        <Section heading="Setup checklist">
          <DataTable
            headers={["Step", "Status"]}
            rows={[
              ["App permissions approved", <StatusBadge key="s" ok={!setup.missingScopes.length} notText={`Missing ${setup.missingScopes.join(", ")}`} />],
              ["Klaviyo key on the server", <StatusBadge key="k" ok={setup.klaviyoConfigured} />],
              ["Customer emails switched on", <StatusBadge key="e" ok={setup.emailsEnabled} okText="On" notText="Off" />],
              ["Nightly check ran in the last 36 hours", <StatusBadge key="c" ok={!setup.checkStale} />],
              ["Checkout rule active (Settings → Checkout → Checkout rules)", <s-badge key="r">Check in Shopify</s-badge>],
              ["Theme setting: Save planned orders in the app (Theme settings → Cart)", <s-badge key="t">Check in the theme</s-badge>],
              ["Protected customer data access (name, email) in the Dev Dashboard", <s-badge key="p">Check in the Dev Dashboard</s-badge>],
            ]}
          />
        </Section>
      </PageBody>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
