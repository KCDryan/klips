/** Database helpers for the Klips Worker: ids, users, licences, token ledger, generations. */

export interface Env {
  DB: D1Database;
  SITE_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  DOWNLOADS: R2Bucket;
  /** Private key for uploading installers (scripts/upload_installer.py). Not for customers. */
  ADMIN_TOKEN: string;
  /** Optional: sends password reset emails through Resend (resend.com). */
  RESEND_API_KEY?: string;
  /** Sender for account emails, e.g. "Klips <accounts@klips.pro>". */
  EMAIL_FROM?: string;
}

export interface User {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  tokens: number;
  created_at: number;
  updated_at: number;
}

export interface License {
  key: string;
  user_id: string;
  status: string;
  device_name: string | null;
  device_id: string | null;
  last_seen_at: number | null;
  created_at: number;
}

export const now = () => Math.floor(Date.now() / 1000);

export function id(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

/** Licence keys: KLIPS-XXXX-XXXX-XXXX-XXXX, using characters that can't be misread aloud. */
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newLicenseKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length]);
  const groups = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join(""));
  return `KLIPS-${groups.join("-")}`;
}

export function normalizeLicenseKey(raw: string): string {
  return String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getUserById(env: Env, userId: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<User>();
}

export async function getUserByEmail(env: Env, email: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first<User>();
}

export async function getUserByStripeCustomer(env: Env, customerId: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE stripe_customer_id = ?").bind(customerId).first<User>();
}

/** Remember the Stripe customer for an account, so later purchases and the billing portal use the same one. */
export async function linkStripeCustomer(env: Env, user: User, customerId: string | null): Promise<User> {
  if (!customerId || user.stripe_customer_id === customerId) return user;
  const taken = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ? AND id != ?").bind(customerId, user.id).first();
  if (taken) {
    // Never let a customer id clash block a purchase from being credited.
    console.warn("stripe customer already linked to another account", customerId);
    return user;
  }
  await env.DB.prepare("UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?").bind(customerId, now(), user.id).run();
  return (await getUserById(env, user.id))!;
}

/** Create an account with no password yet (sign-up adds the password straight after). */
export async function createUser(env: Env, email: string): Promise<User> {
  const ts = now();
  const userId = id("usr");
  await env.DB.prepare("INSERT INTO users (id, email, stripe_customer_id, tokens, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)")
    .bind(userId, email.toLowerCase(), ts, ts).run();
  return (await getUserById(env, userId))!;
}

/**
 * The account's app key. Customers never see it: the desktop app receives it when they sign in
 * with their email and password, and uses it for every token request after that.
 */
export async function ensureLicense(env: Env, userId: string): Promise<License> {
  const existing = await env.DB.prepare("SELECT * FROM licenses WHERE user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1")
    .bind(userId).first<License>();
  if (existing) return existing;
  const key = newLicenseKey();
  await env.DB.prepare("INSERT INTO licenses (key, user_id, status, created_at) VALUES (?, ?, 'active', ?)").bind(key, userId, now()).run();
  return (await env.DB.prepare("SELECT * FROM licenses WHERE key = ?").bind(key).first<License>())!;
}

/** Find or create the account for an email address (used for checkouts made before accounts existed). */
export async function ensureUser(env: Env, email: string, stripeCustomerId?: string | null): Promise<{ user: User; license: License }> {
  const found = await getUserByEmail(env, email);
  const user = await linkStripeCustomer(env, found ?? (await createUser(env, email)), stripeCustomerId ?? null);
  return { user, license: await ensureLicense(env, user.id) };
}

export async function getLicense(env: Env, key: string): Promise<{ license: License; user: User } | null> {
  const license = await env.DB.prepare("SELECT * FROM licenses WHERE key = ?").bind(normalizeLicenseKey(key)).first<License>();
  if (!license || license.status !== "active") return null;
  const user = await getUserById(env, license.user_id);
  return user ? { license, user } : null;
}

/**
 * Add tokens to an account and record why.
 * `reference` makes the write idempotent: a Stripe webhook delivered twice credits once.
 * Returns the new balance, or null when this reference was already applied.
 */
export async function creditTokens(
  env: Env,
  userId: string,
  amount: number,
  reason: string,
  reference: string | null,
): Promise<number | null> {
  if (amount <= 0) throw new Error("credit amount must be positive");
  if (reference) {
    const existing = await env.DB.prepare("SELECT id FROM token_ledger WHERE reason = ? AND reference = ?")
      .bind(reason, reference).first();
    if (existing) return null;
  }
  const ts = now();
  const user = await getUserById(env, userId);
  if (!user) throw new Error("unknown user");
  const balance = user.tokens + amount;
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET tokens = tokens + ?, updated_at = ? WHERE id = ?").bind(amount, ts, userId),
    env.DB.prepare(
      "INSERT INTO token_ledger (id, user_id, delta, reason, reference, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id("led"), userId, amount, reason, reference, balance, ts),
  ]);
  return balance;
}

/**
 * Take tokens for a generation. The UPDATE only matches while the balance is high enough,
 * so two devices spending at the same moment can't push an account below zero.
 * Returns the new balance, or null when there aren't enough tokens.
 */
export async function spendTokens(
  env: Env,
  userId: string,
  amount: number,
  reference: string,
): Promise<number | null> {
  if (amount <= 0) throw new Error("spend amount must be positive");
  const ts = now();
  const result = await env.DB.prepare("UPDATE users SET tokens = tokens - ?, updated_at = ? WHERE id = ? AND tokens >= ?")
    .bind(amount, ts, userId, amount).run();
  if (!result.meta.changes) return null;
  const user = await getUserById(env, userId);
  const balance = user?.tokens ?? 0;
  await env.DB.prepare(
    "INSERT INTO token_ledger (id, user_id, delta, reason, reference, balance_after, created_at) VALUES (?, ?, ?, 'spend', ?, ?, ?)",
  ).bind(id("led"), userId, -amount, reference, balance, ts).run();
  return balance;
}

/** Give back tokens for clips that were never delivered (fewer clips than paid for, or a failed run). */
export async function refundTokens(env: Env, userId: string, amount: number, reference: string): Promise<number | null> {
  if (amount <= 0) return null;
  return creditTokens(env, userId, amount, "refund", reference);
}
