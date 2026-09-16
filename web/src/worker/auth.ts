/**
 * Email and password accounts for Klips.
 *
 * Passwords are stored as salted PBKDF2-SHA256 hashes. A signed-in browser holds a random session
 * token in an HttpOnly cookie; the database only keeps its SHA-256, so a leaked table can't sign anyone in.
 */
import { type Env, type User, getUserById, now, sha256 } from "./db";

/** Where customer emails and replies go. */
export const SUPPORT_EMAIL = "kcd.ryanc@gmail.com";
export const SESSION_COOKIE = "klips_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const RESET_SECONDS = 60 * 60;
const PBKDF2_ITERATIONS = 100_000; // the most Cloudflare Workers allows
const HASH_SCHEME = "pbkdf2-sha256";

// ---- pure helpers (unit tested) ----

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${HASH_SCHEME}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [scheme, iterations, salt, hash] = String(stored || "").split("$");
  if (scheme !== HASH_SCHEME || !salt || !hash || !(Number(iterations) > 0)) return false;
  const actual = await pbkdf2(password, fromBase64(salt), Number(iterations));
  const expected = fromBase64(hash);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i]; // constant time
  return difference === 0;
}

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** A reason the password can't be used, or null when it's fine. */
export function passwordProblem(password: unknown): string | null {
  const text = String(password ?? "");
  if (text.length < 8) return "Use at least 8 characters for your password.";
  if (text.length > 200) return "That password is too long (200 characters at most).";
  return null;
}

export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function readCookie(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

export function sessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ---- database ----

export async function getPasswordHash(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT password_hash FROM credentials WHERE user_id = ?").bind(userId).first<{ password_hash: string }>();
  return row?.password_hash ?? null;
}

export async function setPassword(env: Env, userId: string, password: string): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
  ).bind(userId, await hashPassword(password), ts, ts).run();
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const ts = now();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, ts, ts + SESSION_SECONDS).run();
  // Housekeeping: drop this person's expired sessions.
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(userId, ts).run();
  return token;
}

export async function userFromSession(env: Env, request: Request): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
    .bind(await sha256(token)).first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at < now()) return null;
  return getUserById(env, row.user_id);
}

export async function endSession(env: Env, request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha256(token)).run();
}

export async function endAllSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/** Password reset links: one-time, expire after an hour, stored hashed. */
export async function createResetToken(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(userId),
    env.DB.prepare("INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), userId, ts, ts + RESET_SECONDS),
  ]);
  return token;
}

/** Returns the user id for a valid reset token and uses it up. */
export async function consumeResetToken(env: Env, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const hashed = await sha256(token);
  const row = await env.DB.prepare("SELECT user_id, expires_at FROM password_resets WHERE token = ?")
    .bind(hashed).first<{ user_id: string; expires_at: number }>();
  await env.DB.prepare("DELETE FROM password_resets WHERE token = ?").bind(hashed).run();
  if (!row || row.expires_at < now()) return null;
  return row.user_id;
}

/**
 * Simple fixed-window limiter for sign-in and sign-up, so passwords can't be guessed at speed.
 * `blocked` says whether the limit is already reached; `hit` counts one attempt.
 */
export const limiter = {
  async blocked(env: Env, key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const row = await env.DB.prepare("SELECT count, window_start FROM auth_attempts WHERE key = ?")
      .bind(key).first<{ count: number; window_start: number }>();
    return Boolean(row && row.window_start > now() - windowSeconds && row.count >= limit);
  },
  async hit(env: Env, key: string, windowSeconds: number): Promise<void> {
    const ts = now();
    await env.DB.prepare(
      `INSERT INTO auth_attempts (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN auth_attempts.window_start > ? THEN auth_attempts.count + 1 ELSE 1 END,
         window_start = CASE WHEN auth_attempts.window_start > ? THEN auth_attempts.window_start ELSE excluded.window_start END`,
    ).bind(key, ts, ts - windowSeconds, ts - windowSeconds).run();
  },
  async clear(env: Env, key: string): Promise<void> {
    await env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?").bind(key).run();
  },
};

/** Sends email through Resend when RESEND_API_KEY is set. Returns false when email isn't set up. */
export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    // Sent from the klips.pro domain (no inbox needed); replies go to the Klips support inbox.
    body: JSON.stringify({ from: env.EMAIL_FROM || "Klips <accounts@klips.pro>", reply_to: SUPPORT_EMAIL, to: [to], subject, text }),
  });
  if (!response.ok) {
    console.error("email send failed", response.status, await response.text());
    return false;
  }
  return true;
}
