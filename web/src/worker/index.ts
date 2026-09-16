/**
 * Klips API.
 *
 * The desktop app runs on the customer's own machine; this Worker is the authority on
 * licences, token balances and the history of everything they generated.
 */
import { PACK, PLANS, TOKENS_PER_CLIP, YEARLY_DISCOUNT, normalizePackTokens, packCents, planById, planCents, planTokens, tokensForClips } from "../shared/pricing";
import {
  consumeResetToken,
  createResetToken,
  createSession,
  endAllSessions,
  endSession,
  getPasswordHash,
  isValidEmail,
  limiter,
  normalizeEmail,
  passwordProblem,
  sendEmail,
  sessionCookie,
  setPassword,
  userFromSession,
  verifyPassword,
} from "./auth";
import {
  type Env,
  type User,
  createUser,
  ensureLicense,
  getLicense,
  getUserByEmail,
  getUserById,
  id,
  normalizeLicenseKey,
  now,
  refundTokens,
  spendTokens,
} from "./db";
import { createBillingPortal, createPackCheckout, createSubscriptionCheckout, handleStripeEvent, verifyStripeEvent } from "./stripe";

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

/** The website signs in with an email and password; the browser keeps a session cookie. */
async function requireSession(env: Env, request: Request): Promise<User | Response> {
  return (await userFromSession(env, request)) ?? fail("Please sign in.", 401);
}

/** A JSON response that also signs the browser in. */
async function signedIn(env: Env, user: User, status = 200): Promise<Response> {
  const response = json({ email: user.email, tokens: user.tokens }, status);
  response.headers.append("set-cookie", sessionCookie(await createSession(env, user.id)));
  return response;
}

const clientIp = (request: Request) => request.headers.get("cf-connecting-ip") || "unknown";
const FIFTEEN_MINUTES = 15 * 60;
const HOUR = 60 * 60;
const TOO_MANY = "Too many attempts. Wait 15 minutes and try again, or reset your password.";

async function accountPayload(env: Env, user: User) {
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

  // Installer uploads, in parts (a single request is capped at 100 MB). Only for the owner's upload script.
  if (path.startsWith("/api/admin/upload/")) {
    const given = request.headers.get("x-klips-admin") || "";
    if (!env.ADMIN_TOKEN || given.length !== env.ADMIN_TOKEN.length || given !== env.ADMIN_TOKEN) {
      return fail("Not allowed.", 403);
    }
    const key = url.searchParams.get("key") || "";
    if (!["Klips-mac.dmg", "Klips-windows-setup.exe"].includes(key)) return fail("Unknown installer name.");

    if (path === "/api/admin/upload/start" && method === "POST") {
      const upload = await env.DOWNLOADS.createMultipartUpload(key, {
        httpMetadata: { contentType: key.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/vnd.microsoft.portable-executable" },
      });
      return json({ upload_id: upload.uploadId });
    }
    const uploadId = url.searchParams.get("upload_id") || "";
    if (path === "/api/admin/upload/part" && method === "PUT") {
      const partNumber = Number(url.searchParams.get("part"));
      if (!request.body || !Number.isInteger(partNumber) || partNumber < 1) return fail("Missing part.");
      const part = await env.DOWNLOADS.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, request.body);
      return json({ part_number: part.partNumber, etag: part.etag });
    }
    if (path === "/api/admin/upload/complete" && method === "POST") {
      const body = await readJson(request);
      const parts = Array.isArray(body.parts) ? body.parts : [];
      const object = await env.DOWNLOADS.resumeMultipartUpload(key, uploadId).complete(
        parts.map((p: any) => ({ partNumber: Number(p.part_number), etag: String(p.etag) })),
      );
      return json({ key: object.key, size: object.size });
    }
    return fail("Not found.", 404);
  }

  // Installers live in R2 (the GitHub repo is private). scripts/sync.sh uploads each new release.
  if (path === "/download/mac" || path === "/download/windows") {
    const key = path.endsWith("/windows") ? "Klips-windows-setup.exe" : "Klips-mac.dmg";
    const object = await env.DOWNLOADS.get(key);
    if (!object) {
      return new Response("The installer is being prepared. Please try again in a few minutes.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "300" },
      });
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("content-length", String(object.size));
    headers.set("content-type", key.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/vnd.microsoft.portable-executable");
    headers.set("content-disposition", `attachment; filename="${key}"`);
    headers.set("cache-control", "no-cache");
    return new Response(object.body, { headers });
  }

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

  // Buying needs an account, so tokens always land somewhere the customer can sign in to.
  if (path === "/api/checkout/pack" && method === "POST") {
    const user = await requireSession(env, request);
    if (user instanceof Response) return user;
    const body = await readJson(request);
    const tokens = normalizePackTokens(Number(body.tokens) || PACK.defaultTokens);
    return json({ url: await createPackCheckout(env, tokens, user) });
  }

  if (path === "/api/checkout/subscription" && method === "POST") {
    const user = await requireSession(env, request);
    if (user instanceof Response) return user;
    const body = await readJson(request);
    const plan = planById(String(body.plan || ""));
    const interval = body.interval === "year" ? "year" : "month";
    if (!plan) return fail("Unknown plan.");
    return json({ url: await createSubscriptionCheckout(env, plan, interval, user) });
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

  /** After checkout: ready once the payment's tokens are on the account. */
  if (path === "/api/welcome" && method === "GET") {
    const sessionId = url.searchParams.get("session_id") || "";
    if (!sessionId.startsWith("cs_")) return fail("Missing checkout session.");
    const purchase = await env.DB.prepare("SELECT user_id, tokens, kind, plan FROM purchases WHERE stripe_session_id = ?")
      .bind(sessionId).first<{ user_id: string; tokens: number; kind: string; plan: string | null }>();
    if (!purchase) return json({ ready: false });
    const user = await getUserById(env, purchase.user_id);
    return json({ ready: true, email: user?.email, tokens: user?.tokens ?? 0, added: purchase.tokens, kind: purchase.kind, plan: purchase.plan });
  }

  // ---- accounts: email and password ----

  if (path === "/api/auth/me" && method === "GET") {
    const user = await userFromSession(env, request);
    return user ? json({ signed_in: true, email: user.email, tokens: user.tokens }) : json({ signed_in: false });
  }

  if (path === "/api/auth/signup" && method === "POST") {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password ?? "");
    const ipKey = `signup:${clientIp(request)}`;
    if (await limiter.blocked(env, ipKey, 20, HOUR)) return fail("Too many new accounts from this network. Try again in an hour.", 429);
    if (!isValidEmail(email)) return fail("Enter a valid email address.");
    const problem = passwordProblem(password);
    if (problem) return fail(problem);
    await limiter.hit(env, ipKey, HOUR);

    const existing = await getUserByEmail(env, email);
    if (existing && (await getPasswordHash(env, existing.id))) {
      return fail("There's already an account with this email. Sign in instead.", 409, { code: "exists" });
    }
    if (existing) {
      // Bought before accounts existed: prove it's theirs with the key from the receipt, once.
      const key = normalizeLicenseKey(String(body.license_key || ""));
      const found = key ? await getLicense(env, key) : null;
      if (!found || found.user.id !== existing.id) {
        return fail(
          key
            ? "That key doesn't match this email. Check the key on your purchase receipt."
            : "This email already bought Klips before accounts existed. Enter the licence key from your receipt once to set your password.",
          409,
          { code: "needs_license" },
        );
      }
    }
    const user = existing ?? (await createUser(env, email));
    await setPassword(env, user.id, password);
    await ensureLicense(env, user.id);
    return signedIn(env, user, existing ? 200 : 201);
  }

  if (path === "/api/auth/login" && method === "POST") {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const emailKey = `login:${email}`;
    const ipKey = `ip:${clientIp(request)}`;
    if ((await limiter.blocked(env, emailKey, 10, FIFTEEN_MINUTES)) || (await limiter.blocked(env, ipKey, 50, FIFTEEN_MINUTES))) {
      return fail(TOO_MANY, 429);
    }
    const user = isValidEmail(email) ? await getUserByEmail(env, email) : null;
    const hash = user ? await getPasswordHash(env, user.id) : null;
    if (!user || !(await verifyPassword(String(body.password ?? ""), hash))) {
      await limiter.hit(env, emailKey, FIFTEEN_MINUTES);
      await limiter.hit(env, ipKey, FIFTEEN_MINUTES);
      if (user && !hash) {
        return fail("This email bought Klips before accounts existed. Choose \"Create account\" to set a password.", 401, { code: "needs_signup" });
      }
      return fail("That email and password don't match.", 401);
    }
    await limiter.clear(env, emailKey);
    return signedIn(env, user);
  }

  if (path === "/api/auth/logout" && method === "POST") {
    await endSession(env, request);
    const response = json({ ok: true });
    response.headers.append("set-cookie", sessionCookie("", 0));
    return response;
  }

  if (path === "/api/auth/forgot" && method === "POST") {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const ipKey = `forgot:${clientIp(request)}`;
    if (await limiter.blocked(env, ipKey, 10, HOUR)) return fail("Too many reset requests. Try again in an hour.", 429);
    if (!isValidEmail(email)) return fail("Enter a valid email address.");
    if (!env.RESEND_API_KEY) {
      return fail("Password reset emails aren't switched on yet. Email support@klips.pro and we'll help you back in.", 503);
    }
    await limiter.hit(env, ipKey, HOUR);
    const user = await getUserByEmail(env, email);
    if (user) {
      const token = await createResetToken(env, user.id);
      await sendEmail(
        env,
        user.email,
        "Reset your Klips password",
        `Someone asked to reset the password for your Klips account.\n\n` +
          `Choose a new password here (the link works once, for one hour):\n${env.SITE_URL}/reset?token=${token}\n\n` +
          `If this wasn't you, ignore this email. Your password hasn't changed.`,
      );
    }
    // Same answer either way, so this can't be used to find out who has an account.
    return json({ ok: true });
  }

  if (path === "/api/auth/reset" && method === "POST") {
    const body = await readJson(request);
    const problem = passwordProblem(body.password);
    if (problem) return fail(problem);
    const userId = await consumeResetToken(env, String(body.token || ""));
    const user = userId ? await getUserById(env, userId) : null;
    if (!user) return fail("That reset link has expired or was already used. Ask for a new one.", 400);
    await setPassword(env, user.id, String(body.password));
    await endAllSessions(env, user.id);
    await limiter.clear(env, `login:${user.email}`);
    return signedIn(env, user);
  }

  if (path === "/api/auth/password" && method === "POST") {
    const user = await requireSession(env, request);
    if (user instanceof Response) return user;
    const body = await readJson(request);
    if (!(await verifyPassword(String(body.current_password ?? ""), await getPasswordHash(env, user.id)))) {
      return fail("Your current password isn't right.", 400);
    }
    const problem = passwordProblem(body.new_password);
    if (problem) return fail(problem);
    await setPassword(env, user.id, String(body.new_password));
    await endAllSessions(env, user.id); // signs out every other browser
    return signedIn(env, user);
  }

  // ---- account portal ----

  if (path === "/api/account" && method === "GET") {
    const user = await requireSession(env, request);
    if (user instanceof Response) return user;
    return json(await accountPayload(env, user));
  }

  if (path === "/api/account/portal" && method === "POST") {
    const user = await requireSession(env, request);
    if (user instanceof Response) return user;
    if (!user.stripe_customer_id) return fail("No billing account yet. Buy tokens or a plan first.", 400);
    return json({ url: await createBillingPortal(env, user.stripe_customer_id) });
  }

  // ---- desktop app ----

  /** The app signs in with the customer's email and password and receives its app key. */
  if (path === "/api/app/login" && method === "POST") {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const emailKey = `login:${email}`;
    const ipKey = `ip:${clientIp(request)}`;
    if ((await limiter.blocked(env, emailKey, 10, FIFTEEN_MINUTES)) || (await limiter.blocked(env, ipKey, 50, FIFTEEN_MINUTES))) {
      return fail(TOO_MANY, 429);
    }
    const user = isValidEmail(email) ? await getUserByEmail(env, email) : null;
    const hash = user ? await getPasswordHash(env, user.id) : null;
    if (!user || !(await verifyPassword(String(body.password ?? ""), hash))) {
      await limiter.hit(env, emailKey, FIFTEEN_MINUTES);
      await limiter.hit(env, ipKey, FIFTEEN_MINUTES);
      if (user && !hash) return fail("Finish setting up your account at klips.pro first (Create account).", 401);
      return fail("That email and password don't match. Forgot it? Reset it at klips.pro.", 401);
    }
    await limiter.clear(env, emailKey);
    const license = await ensureLicense(env, user.id);
    await env.DB.prepare("UPDATE licenses SET device_id = ?, device_name = ?, last_seen_at = ? WHERE key = ?")
      .bind(String(body.device_id || "").slice(0, 80), String(body.device_name || "").slice(0, 80), now(), license.key)
      .run();
    return json({
      app_key: license.key,
      email: user.email,
      tokens: user.tokens,
      clips_available: Math.floor(user.tokens / TOKENS_PER_CLIP),
      tokens_per_clip: TOKENS_PER_CLIP,
    });
  }

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
    // Everything else is a static page, served before the Worker ever runs.
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/download/")) {
      return new Response("Not found", { status: 404 });
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
