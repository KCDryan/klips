/** Stripe checkout and webhook handling for Klips. */
import Stripe from "stripe";

import {
  type Interval,
  type Plan,
  formatUsd,
  normalizePackTokens,
  packCents,
  planById,
  planCents,
  planTokens,
} from "../shared/pricing";
import { type Env, type User, creditTokens, ensureUser, getUserById, getUserByStripeCustomer, id, linkStripeCustomer, now } from "./db";

/**
 * Stripe product tax code, required by Managed Payments (Stripe handles sales tax and VAT).
 * Klips is a downloaded app that works with an online service, sold to creators and businesses:
 * "Artificial Intelligence as a Service (AIaaS) - Cloud Based & Downloaded - Business Use".
 * https://docs.stripe.com/payments/managed-payments/eligibility
 */
const TAX_CODE = "txcd_10105004";

export function stripeClient(env: Env): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("Payments aren't switched on yet. Please try again soon.");
  }
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-08-27.basil",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Ties a checkout to the signed-in account, reusing its Stripe customer when it has one. */
function customerFields(user: User) {
  return user.stripe_customer_id
    ? { customer: user.stripe_customer_id }
    : { customer_email: user.email };
}

/** Checkout for a one-off token pack chosen on the slider. */
export async function createPackCheckout(env: Env, tokens: number, user: User): Promise<string> {
  const stripe = stripeClient(env);
  const amount = normalizePackTokens(tokens);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: `${env.SITE_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/#pricing`,
    ...customerFields(user),
    // Always create a Stripe customer, so receipts and the billing portal work for one-off packs too.
    ...(user.stripe_customer_id ? {} : { customer_creation: "always" as const }),
    client_reference_id: user.id,
    allow_promotion_codes: true,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: packCents(amount),
          product_data: {
            tax_code: TAX_CODE,
            name: `${amount} Klips tokens`,
            description: `${amount / 3 | 0} clips. Tokens never expire.`,
          },
        },
      },
    ],
    metadata: { kind: "pack", tokens: String(amount), user_id: user.id },
    payment_intent_data: { metadata: { kind: "pack", tokens: String(amount), user_id: user.id } },
  });
  return session.url!;
}

/** Checkout for a monthly or yearly plan. Yearly is billed once for the whole year. */
export async function createSubscriptionCheckout(env: Env, plan: Plan, interval: Interval, user: User): Promise<string> {
  const stripe = stripeClient(env);
  const tokens = planTokens(plan, interval);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    success_url: `${env.SITE_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/#pricing`,
    ...customerFields(user),
    client_reference_id: user.id,
    allow_promotion_codes: true,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: planCents(plan, interval),
          recurring: { interval },
          product_data: {
            tax_code: TAX_CODE,
            name: `Klips ${plan.name} (${interval === "year" ? "yearly" : "monthly"})`,
            description:
              interval === "year"
                ? `${plan.tokensPerMonth} tokens a month, ${tokens} granted upfront for the year.`
                : `${plan.tokensPerMonth} tokens a month.`,
          },
        },
      },
    ],
    metadata: { kind: "subscription", plan: plan.id, interval, tokens: String(tokens), user_id: user.id },
    subscription_data: { metadata: { kind: "subscription", plan: plan.id, interval, tokens: String(tokens), user_id: user.id } },
  });
  return session.url!;
}

/** Stripe's hosted page where customers manage cards, invoices and cancellation. */
export async function createBillingPortal(env: Env, customerId: string): Promise<string> {
  const stripe = stripeClient(env);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.SITE_URL}/account`,
  });
  return session.url;
}

async function recordPurchase(
  env: Env,
  userId: string,
  fields: {
    eventId: string;
    sessionId?: string | null;
    kind: "pack" | "subscription";
    plan?: string | null;
    interval?: string | null;
    tokens: number;
    amountCents: number;
    currency: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO purchases (id, user_id, stripe_event_id, stripe_session_id, kind, plan, interval, tokens, amount_cents, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id("pur"),
    userId,
    fields.eventId,
    fields.sessionId ?? null,
    fields.kind,
    fields.plan ?? null,
    fields.interval ?? null,
    fields.tokens,
    fields.amountCents,
    fields.currency,
    now(),
  ).run();
}

async function upsertSubscription(
  env: Env,
  userId: string,
  subscription: Stripe.Subscription,
  plan: string,
  interval: string,
  tokensPerPeriod: number,
): Promise<void> {
  const ts = now();
  const periodEnd = (subscription as unknown as { current_period_end?: number }).current_period_end
    ?? subscription.items.data[0]?.current_period_end
    ?? null;
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, tokens_per_period, current_period_end, cancel_at_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, plan = excluded.plan, interval = excluded.interval,
       tokens_per_period = excluded.tokens_per_period, updated_at = excluded.updated_at`,
  ).bind(
    subscription.id,
    userId,
    plan,
    interval,
    subscription.status,
    tokensPerPeriod,
    periodEnd,
    subscription.cancel_at_period_end ? 1 : 0,
    ts,
    ts,
  ).run();
}

/**
 * Apply one Stripe event. Every credit is tied to the event id, so a repeated delivery
 * (Stripe retries until it gets a 200) never grants tokens twice.
 */
export async function handleStripeEvent(env: Env, event: Stripe.Event): Promise<void> {
  const stripe = stripeClient(env);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
    const accountId = session.client_reference_id || session.metadata?.user_id || "";
    const account = accountId ? await getUserById(env, accountId) : null;
    let user: User;
    if (account) {
      user = await linkStripeCustomer(env, account, customerId);
    } else {
      // Checkouts started before accounts existed carry only an email address.
      const email = session.customer_details?.email || session.customer_email;
      if (!email) throw new Error("checkout session without an account or email");
      user = (await ensureUser(env, email, customerId)).user;
    }

    if (session.mode === "payment") {
      const tokens = Number(session.metadata?.tokens || 0);
      if (tokens > 0) {
        await creditTokens(env, user.id, tokens, "purchase", event.id);
        await recordPurchase(env, user.id, {
          eventId: event.id,
          sessionId: session.id,
          kind: "pack",
          tokens,
          amountCents: session.amount_total ?? 0,
          currency: session.currency ?? "usd",
        });
      }
      return;
    }

    if (session.mode === "subscription" && session.subscription) {
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const planId = String(session.metadata?.plan || subscription.metadata?.plan || "");
      const interval = String(session.metadata?.interval || subscription.metadata?.interval || "month") as Interval;
      const plan = planById(planId);
      if (!plan) throw new Error(`unknown plan on subscription: ${planId}`);
      const tokens = planTokens(plan, interval);
      await upsertSubscription(env, user.id, subscription, plan.id, interval, tokens);
      // The first period's tokens: later periods arrive through invoice.paid.
      await creditTokens(env, user.id, tokens, "subscription_grant", event.id);
      await recordPurchase(env, user.id, {
        eventId: event.id,
        sessionId: session.id,
        kind: "subscription",
        plan: plan.id,
        interval,
        tokens,
        amountCents: session.amount_total ?? planCents(plan, interval),
        currency: session.currency ?? "usd",
      });
    }
    return;
  }

  // Renewals. The first invoice is already handled by checkout.session.completed above.
  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionId =
      typeof (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription === "string"
        ? ((invoice as unknown as { subscription: string }).subscription)
        : (invoice as unknown as { subscription?: Stripe.Subscription }).subscription?.id
          ?? invoice.lines.data[0]?.parent?.subscription_item_details?.subscription
          ?? null;
    if (!subscriptionId || invoice.billing_reason === "subscription_create") return;

    const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(subscriptionId).first<{
      user_id: string;
      plan: string;
      interval: string;
      tokens_per_period: number;
    }>();
    if (!row) return;
    await creditTokens(env, row.user_id, row.tokens_per_period, "subscription_grant", event.id);
    await recordPurchase(env, row.user_id, {
      eventId: event.id,
      kind: "subscription",
      plan: row.plan,
      interval: row.interval,
      tokens: row.tokens_per_period,
      amountCents: invoice.amount_paid ?? 0,
      currency: invoice.currency ?? "usd",
    });

    const subscription = await stripe.subscriptions.retrieve(String(subscriptionId));
    await upsertSubscription(env, row.user_id, subscription, row.plan, row.interval, row.tokens_per_period);
    return;
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    const user = (subscription.metadata?.user_id ? await getUserById(env, subscription.metadata.user_id) : null)
      ?? (await getUserByStripeCustomer(env, customerId));
    if (!user) return;
    const planId = String(subscription.metadata?.plan || "");
    const interval = String(subscription.metadata?.interval || "month");
    const plan = planById(planId);
    await upsertSubscription(
      env,
      user.id,
      subscription,
      plan?.id ?? planId,
      interval,
      plan ? planTokens(plan, interval as Interval) : 0,
    );
  }
}

/** Verify the signature Stripe sends, so only real Stripe events can grant tokens. */
export async function verifyStripeEvent(env: Env, request: Request): Promise<Stripe.Event> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) throw new Error("missing stripe-signature header");
  const body = await request.text();
  const stripe = stripeClient(env);
  return stripe.webhooks.constructEventAsync(
    body,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}

export { formatUsd };
