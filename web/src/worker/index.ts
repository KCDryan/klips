/**
 * Klips API.
 *
 * The desktop app runs on the customer's own machine; this Worker is the authority on
 * licences, token balances and the history of everything they generated.
 */
import {
  FREE_CLIPS_PER_DAY,
  PACK,
  PLANS,
  TOKENS_PER_CLIP,
  YEARLY_DISCOUNT,
  freeDayStart,
  normalizePackTokens,
  packCents,
  planById,
  planCents,
  planTokens,
  tokensForClips,
} from "../shared/pricing";
import { recordPageView, recordSignupSource, stats } from "./analytics";
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
  freeClipsUsedToday,
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

/** Files the owner can upload to R2, and the type each is served with. */
const UPLOAD_TYPES: Record<string, string> = {
  "Klips-mac.dmg": "application/x-apple-diskimage",
  "Klips-mac-intel.dmg": "application/x-apple-diskimage",
  "Klips-windows-setup.exe": "application/vnd.microsoft.portable-executable",
  "demo.mp4": "video/mp4",
  "demo-poster.jpg": "image/jpeg",
};

const DOWNLOADS: Record<string, string> = {
  "/download/mac": "Klips-mac.dmg",
  "/download/mac-intel": "Klips-mac-intel.dmg",
  "/download/windows": "Klips-windows-setup.exe",
};

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

/** How many free clips are left today and when the count resets. */
async function freeAllowance(env: Env, userId: string) {
  const dayStart = freeDayStart(now());
  const used = await freeClipsUsedToday(env, userId, dayStart);
  return {
    free_clips_per_day: FREE_CLIPS_PER_DAY,
    free_clips_left: Math.max(0, FREE_CLIPS_PER_DAY - used),
    free_resets_at: dayStart + 86400,
  };
}

async function accountPayload(env: Env, user: User) {
  const [generations, ledger, subscription] = await Promise.all([
    env.DB.prepare(
      `SELECT id, status, tier, source_name, clips_requested, clips_delivered, tokens_charged, platform,
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
    ...(await freeAllowance(env, user.id)),
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

  // Owner-only tools: installer and demo uploads, and the stats report. Never for customers.
  if (path.startsWith("/api/admin/")) {
    const given = request.headers.get("x-klips-admin") || "";
    if (!env.ADMIN_TOKEN || given.length !== env.ADMIN_TOKEN.length || given !== env.ADMIN_TOKEN) {
      return fail("Not allowed.", 403);
    }
  }

  if (path === "/api/admin/stats" && method === "GET") {
    const days = Math.max(1, Math.min(365, Math.floor(Number(url.searchParams.get("days")) || 30)));
    return json(await stats(env, days));
  }

  // Uploads to R2, in parts (a single request is capped at 100 MB).
  if (path.startsWith("/api/admin/upload/")) {
    const key = url.searchParams.get("key") || "";
    const contentType = Object.hasOwn(UPLOAD_TYPES, key) ? UPLOAD_TYPES[key] : "";
    if (!contentType) return fail("Unknown file name.");

    if (path === "/api/admin/upload/start" && method === "POST") {
      const version = (url.searchParams.get("version") || "").replace(/^v/, "");
      const upload = await env.DOWNLOADS.createMultipartUpload(key, {
        httpMetadata: { contentType },
        customMetadata: /^\d+\.\d+\.\d+$/.test(version) ? { version } : undefined,
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
  if (Object.hasOwn(DOWNLOADS, path)) {
    const key = DOWNLOADS[path];
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
    headers.set("content-type", UPLOAD_TYPES[key]);
    headers.set("content-disposition", `attachment; filename="${key}"`);
    headers.set("cache-control", "no-cache");
    return new Response(object.body, { headers });
  }

  // The landing page's demo video (uploaded with scripts/upload_installer.py demo.mp4). Supports seeking.
  if ((path === "/media/demo.mp4" || path === "/media/demo-poster.jpg") && (method === "GET" || method === "HEAD")) {
    const key = path.slice("/media/".length);
    const object = await env.DOWNLOADS.get(key, { range: request.headers });
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "public, max-age=3600");
    headers.set("content-type", UPLOAD_TYPES[key]);
    const range = object.range as { offset?: number; length?: number } | undefined;
    if (range && request.headers.has("range")) {
      const offset = range.offset ?? 0;
      const length = range.length ?? object.size - offset;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("content-length", String(length));
      return new Response(method === "HEAD" ? null : (object as R2ObjectBody).body, { status: 206, headers });
    }
    headers.set("content-length", String(object.size));
    return new Response(method === "HEAD" ? null : (object as R2ObjectBody).body, { headers });
  }

  // ---- public ----

  if (path === "/api/demo" && method === "GET") {
    const [video, poster] = await Promise.all([env.DOWNLOADS.head("demo.mp4"), env.DOWNLOADS.head("demo-poster.jpg")]);
    return json({ video: Boolean(video), poster: Boolean(poster) });
  }

  /** Page-view beacon from the site (no cookies, no ids). Always answers 204 so it never gets in the way. */
  if (path === "/api/t" && method === "POST") {
    try {
      await recordPageView(env, request, await readJson(request));
    } catch (e) {
      console.error("page view not recorded", e);
    }
    return new Response(null, { status: 204 });
  }

  if (path === "/api/pricing" && method === "GET") {
    return json({
      tokens_per_clip: TOKENS_PER_CLIP,
      free_clips_per_day: FREE_CLIPS_PER_DAY,
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
    return user
      ? json({ signed_in: true, email: user.email, tokens: user.tokens, ...(await freeAllowance(env, user.id)) })
      : json({ signed_in: false });
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
    if (!existing) await recordSignupSource(env, user.id, body.source).catch((e) => console.error("signup source", e));
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
      return fail("Password reset emails aren't switched on yet. Email kcd.ryanc@gmail.com and we'll help you back in.", 503);
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

  // ---- Klips Studio and the engine on the customer's computer ----

  /** The studio hands this key to the engine on the customer's computer, so it can use their tokens. */
  if (path === "/api/engine/link" && method === "POST") {
    const user = await requireSession(env, request);
    if (user instanceof Response) return user;
    const license = await ensureLicense(env, user.id);
    return json({ app_key: license.key, email: user.email });
  }

  /** The newest engine version on the download buttons, so the studio can offer updates. */
  if (path === "/api/engine/latest" && method === "GET") {
    const [mac, windows] = await Promise.all([env.DOWNLOADS.head("Klips-mac.dmg"), env.DOWNLOADS.head("Klips-windows-setup.exe")]);
    return json({ version: mac?.customMetadata?.version || windows?.customMetadata?.version || null });
  }

  /** Progress through the setup checklist that isn't visible from the browser alone. */
  if (path === "/api/onboarding" && method === "GET") {
    const user = await requireSession(env, request);
    if (user instanceof Response) return user;
    const [bought, engine, clips, free] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM token_ledger WHERE user_id = ? AND reason IN ('purchase', 'subscription_grant', 'manual')")
        .bind(user.id).first<{ n: number }>(),
      env.DB.prepare("SELECT device_name, last_seen_at FROM licenses WHERE user_id = ? AND last_seen_at IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1")
        .bind(user.id).first<{ device_name: string | null; last_seen_at: number }>(),
      env.DB.prepare("SELECT COALESCE(SUM(clips_delivered), 0) AS n FROM generations WHERE user_id = ? AND status = 'completed'")
        .bind(user.id).first<{ n: number }>(),
      env.DB.prepare("SELECT 1 AS yes FROM user_flags WHERE user_id = ? AND flag = 'free_plan'").bind(user.id).first(),
    ]);
    return json({
      email: user.email,
      tokens: user.tokens,
      has_tokens: user.tokens > 0 || (bought?.n ?? 0) > 0,
      free_plan: Boolean(free),
      engine_linked: Boolean(engine),
      engine_device: engine?.device_name ?? null,
      clips_made: clips?.n ?? 0,
    });
  }

  /** The customer chose to start on the free plan (ticks off the "free or paid" setup step). */
  if (path === "/api/onboarding/free" && method === "POST") {
    const user = await requireSession(env, request);
    if (user instanceof Response) return user;
    await env.DB.prepare("INSERT OR IGNORE INTO user_flags (user_id, flag, created_at) VALUES (?, 'free_plan', ?)")
      .bind(user.id, now()).run();
    return json({ ok: true });
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

  /**
   * Start a run. With tokens: take 3 per clip up front; unused clips are refunded when the engine reports back.
   * On the free plan: allow up to the day's remaining free clips, and tell the engine to watermark them.
   * Engines before 1.4 don't send a plan and always use tokens.
   */
  if (path === "/api/app/reserve" && method === "POST") {
    const body = await readJson(request);
    const auth = await requireLicense(env, request, body);
    if ("error" in auth) return auth.error;
    const clips = Math.max(1, Math.min(30, Math.floor(Number(body.clips) || 0)));
    const generationId = id("gen");

    if (body.plan === "free") {
      const allowance = await freeAllowance(env, auth.user.id);
      if (allowance.free_clips_left <= 0) {
        return fail(
          `You've used today's ${FREE_CLIPS_PER_DAY} free clips. They reset at midnight UTC, or use tokens for clips without a watermark.`,
          402,
          { ...allowance, tokens: auth.user.tokens },
        );
      }
      const allowed = Math.min(clips, allowance.free_clips_left);
      await env.DB.prepare(
        `INSERT INTO generations (id, user_id, license_key, status, tier, source_name, source_seconds, clips_requested,
                                  tokens_charged, platform, app_version, device_name, created_at)
         VALUES (?, ?, ?, 'reserved', 'free', ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).bind(
        generationId,
        auth.user.id,
        auth.license.key,
        String(body.source_name || "").slice(0, 200),
        Number(body.source_seconds) || null,
        allowed,
        String(body.platform || "").slice(0, 40),
        String(body.app_version || "").slice(0, 40),
        String(body.device_name || "").slice(0, 80),
        now(),
      ).run();
      return json({
        generation_id: generationId,
        plan: "free",
        watermark: true,
        clips_allowed: allowed,
        tokens_charged: 0,
        tokens: auth.user.tokens,
        free_clips_left: allowance.free_clips_left - allowed,
        free_resets_at: allowance.free_resets_at,
      });
    }

    const cost = tokensForClips(clips);
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
    return json({ generation_id: generationId, plan: "tokens", watermark: false, clips_allowed: clips, tokens_charged: cost, tokens: balance });
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
    const refund = generation.tier === "free" ? 0 : tokensForClips(generation.clips_requested - delivered);
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
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/download/") && !url.pathname.startsWith("/media/")) {
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
