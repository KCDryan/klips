/**
 * Klips API.
 *
 * The desktop app runs on the customer's own machine; this Worker is the authority on
 * licences, token balances and the history of everything they generated.
 */
import { PACK, PLANS, TOKENS_PER_CLIP, YEARLY_DISCOUNT, normalizePackTokens, packCents, planById, planCents, planTokens, tokensForClips } from "../shared/pricing";
import {
  type Env,
  type License,
  type User,
  ensureUser,
  getLicense,
  getUserById,
  id,
  normalizeLicenseKey,
  now,
  refundTokens,
  spendTokens,
} from "./db";
import { createBillingPortal, createPackCheckout, createSubscriptionCheckout, handleStripeEvent, stripeClient, verifyStripeEvent } from "./stripe";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ error: message, ...extra }, status);

async function readJson(request: Request): Promise<Record<string, any>> {
  try {
    return (await request.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

/** The desktop app authenticates with its licence key, sent as a header or in the body. */
async function requireLicense(env: Env, request: Request, body: Record<string, any> = {}) {
  const key = normalizeLicenseKey(request.headers.get("x-klips-key") || body.license_key || "");
  if (!key) return { error: fail("Missing licence key.", 401) };
  const found = await getLicense(env, key);
  if (!found) return { error: fail("That licence key isn't active. Check it in your Klips account.", 403) };
  return found;
}

async function accountPayload(env: Env, user: User, license: License) {
  const [generations, ledger, subscription] = await Promise.all([
    env.DB.prepare(
      `SELECT id, status, source_name, clips_requested, clips_delivered, tokens_charged, platform,
              titles, created_at, completed_at, device_name
       FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(user.id).all(),
    env.DB.prepare(
      "SELECT delta, reason, balance_after, created_at FROM token_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
    ).bind(user.id).all(),
    env.DB.prepare(
      "SELECT plan, interval, status, tokens_per_period, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing','past_due') ORDER BY updated_at DESC LIMIT 1",
    ).bind(user.id).first(),
  ]);

  return {
    email: user.email,
    tokens: user.tokens,
    clips_available: Math.floor(user.tokens / TOKENS_PER_CLIP),
    license_key: license.key,
    has_billing: Boolean(user.stripe_customer_id),
    subscription: subscription ?? null,
    generations: (generations.results ?? []).map((row: any) => ({
      ...row,
      titles: row.titles ? JSON.parse(row.titles) : [],
    })),
    ledger: ledger.results ?? [],
  };
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // ---- public ----

  if (path === "/api/pricing" && method === "GET") {
    return json({
      tokens_per_clip: TOKENS_PER_CLIP,
      pack: { ...PACK, cents_per_token: packCents(1) },
      yearly_discount: YEARLY_DISCOUNT,
      plans: PLANS.map((plan) => ({
        ...plan,
        monthly: planCents(plan, "month"),
        yearly: planCents(plan, "year"),
        yearly_tokens: planTokens(plan, "year"),
      })),
    });
  }

  if (path === "/api/checkout/pack" && method === "POST") {
    const body = await readJson(request);
    const tokens = normalizePackTokens(Number(body.tokens) || PACK.defaultTokens);
    const checkoutUrl = await createPackCheckout(env, tokens, body.email);
    return json({ url: checkoutUrl });
  }

  if (path === "/api/checkout/subscription" && method === "POST") {
    const body = await readJson(request);
    const plan = planById(String(body.plan || ""));
    const interval = body.interval === "year" ? "year" : "month";
    if (!plan) return fail("Unknown plan.");
    const checkoutUrl = await createSubscriptionCheckout(env, plan, interval, body.email);
    return json({ url: checkoutUrl });
  }

  if (path === "/api/stripe/webhook" && method === "POST") {
    let event;
    try {
      event = await verifyStripeEvent(env, request);
    } catch (e) {
      return fail(`Signature check failed: ${(e as Error).message}`, 400);
    }
    await handleStripeEvent(env, event); // a thrown error returns 500 so Stripe retries
    return json({ received: true });
  }

  /** After checkout, the success page shows the licence key for this session. */
  if (path === "/api/welcome" && method === "GET") {
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) return fail("Missing session id.");
    const session = await stripeClient(env).checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid" && session.status !== "complete") {
      return json({ pending: true });
    }
    const email = session.customer_details?.email || session.customer_email;
    if (!email) return fail("That checkout has no email address.", 404);
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
    const { user, license } = await ensureUser(env, email, customerId);
    return json({ email: user.email, license_key: license.key, tokens: user.tokens });
  }

  // ---- account portal (signs in with the licence key) ----

  if (path === "/api/account" && method === "GET") {
    const auth = await requireLicense(env, request);
    if ("error" in auth) return auth.error;
    return json(await accountPayload(env, auth.user, auth.license));
  }

  if (path === "/api/account/portal" && method === "POST") {
    const body = await readJson(request);
    const auth = await requireLicense(env, request, body);
    if ("error" in auth) return auth.error;
    if (!auth.user.stripe_customer_id) return fail("No billing account yet. Buy tokens or a plan first.", 400);
    return json({ url: await createBillingPortal(env, auth.user.stripe_customer_id) });
  }

  // ---- desktop app ----

  if (path === "/api/app/activate" && method === "POST") {
    const body = await readJson(request);
    const auth = await requireLicense(env, request, body);
    if ("error" in auth) return auth.error;
    await env.DB.prepare("UPDATE licenses SET device_id = ?, device_name = ?, last_seen_at = ? WHERE key = ?")
      .bind(String(body.device_id || ""), String(body.device_name || ""), now(), auth.license.key)
      .run();
    return json({
      email: auth.user.email,
      tokens: auth.user.tokens,
      clips_available: Math.floor(auth.user.tokens / TOKENS_PER_CLIP),
      tokens_per_clip: TOKENS_PER_CLIP,
    });
  }

  /** Take tokens before a run starts. Unused clips are refunded when the app reports back. */
  if (path === "/api/app/reserve" && method === "POST") {
    const body = await readJson(request);
    const auth = await requireLicense(env, request, body);
    if ("error" in auth) return auth.error;
    const clips = Math.max(1, Math.min(30, Math.floor(Number(body.clips) || 0)));
    const cost = tokensForClips(clips);
    const generationId = id("gen");
    const balance = await spendTokens(env, auth.user.id, cost, generationId);
    if (balance === null) {
      return fail("Not enough tokens.", 402, {
        tokens: auth.user.tokens,
        tokens_needed: cost,
        clips_available: Math.floor(auth.user.tokens / TOKENS_PER_CLIP),
      });
    }
    await env.DB.prepare(
      `INSERT INTO generations (id, user_id, license_key, status, source_name, source_seconds, clips_requested,
                                tokens_charged, platform, app_version, device_name, created_at)
       VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      generationId,
      auth.user.id,
      auth.license.key,
      String(body.source_name || "").slice(0, 200),
      Number(body.source_seconds) || null,
      clips,
      cost,
      String(body.platform || "").slice(0, 40),
      String(body.app_version || "").slice(0, 40),
      String(body.device_name || "").slice(0, 80),
      now(),
    ).run();
    return json({ generation_id: generationId, tokens_charged: cost, tokens: balance });
  }

  /** The app reports what it actually produced; clips it couldn't make are refunded. */
  if (path === "/api/app/complete" && method === "POST") {
    const body = await readJson(request);
    const auth = await requireLicense(env, request, body);
    if ("error" in auth) return auth.error;
    const generation = await env.DB.prepare("SELECT * FROM generations WHERE id = ? AND user_id = ?")
      .bind(String(body.generation_id || ""), auth.user.id).first<any>();
    if (!generation) return fail("Unknown generation.", 404);
    if (generation.status !== "reserved") return json({ ok: true, tokens: auth.user.tokens });

    const delivered = Math.max(0, Math.min(generation.clips_requested, Math.floor(Number(body.clips_delivered) || 0)));
    const refund = tokensForClips(generation.clips_requested - delivered);
    const titles = Array.isArray(body.titles) ? JSON.stringify(body.titles.slice(0, 30)) : null;
    await env.DB.prepare(
      "UPDATE generations SET status = 'completed', clips_delivered = ?, tokens_charged = ?, titles = ?, completed_at = ? WHERE id = ?",
    ).bind(delivered, generation.tokens_charged - refund, titles, now(), generation.id).run();
    if (refund > 0) await refundTokens(env, auth.user.id, refund, generation.id);
    const user = await getUserById(env, auth.user.id);
    return json({ ok: true, refunded: refund, tokens: user?.tokens ?? auth.user.tokens });
  }

  /** A failed run costs nothing. */
  if (path === "/api/app/fail" && method === "POST") {
    const body = await readJson(request);
    const auth = await requireLicense(env, request, body);
    if ("error" in auth) return auth.error;
    const generation = await env.DB.prepare("SELECT * FROM generations WHERE id = ? AND user_id = ?")
      .bind(String(body.generation_id || ""), auth.user.id).first<any>();
    if (!generation) return fail("Unknown generation.", 404);
    if (generation.status === "reserved") {
      await env.DB.prepare("UPDATE generations SET status = 'failed', error = ?, completed_at = ? WHERE id = ?")
        .bind(String(body.error || "").slice(0, 500), now(), generation.id).run();
      await refundTokens(env, auth.user.id, generation.tokens_charged, generation.id);
    }
    const user = await getUserById(env, auth.user.id);
    return json({ ok: true, tokens: user?.tokens ?? auth.user.tokens });
  }

  return fail("Not found.", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 }); // static assets are served before the Worker
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, x-klips-key",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-max-age": "86400",
        },
      });
    }
    try {
      const response = await handleApi(request, env, url);
      response.headers.set("access-control-allow-origin", "*"); // the desktop app calls this API too
      return response;
    } catch (e) {
      console.error("api error", e);
      return fail((e as Error).message || "Something went wrong.", 500);
    }
  },
} satisfies ExportedHandler<Env>;
