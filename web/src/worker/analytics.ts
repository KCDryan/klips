/**
 * Privacy-friendly analytics for klips.pro: daily page-view counts by page, referring site, campaign source
 * and country, plus where each sign-up came from. No cookies, no IP addresses, no visitor ids.
 */
import { type Env, now } from "./db";

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|monitor|curl|wget|python/i;
const SITE_HOSTS = new Set(["klips.pro", "www.klips.pro", "localhost", "127.0.0.1"]);

export function isBot(userAgent: string | null): boolean {
  return !userAgent || BOT_RE.test(userAgent);
}

/** Just the path, lower-cased and trimmed, so query strings (tokens, session ids) are never stored. */
export function cleanPath(raw: unknown): string {
  const text = String(raw ?? "/").split(/[?#]/)[0].toLowerCase().slice(0, 80);
  return text.startsWith("/") ? text : "/";
}

/** The referring site's hostname, or "" when it's direct or from klips.pro itself. */
export function referrerHost(raw: unknown): string {
  try {
    const host = new URL(String(raw)).hostname.replace(/^www\./, "").toLowerCase();
    return SITE_HOSTS.has(host) || SITE_HOSTS.has(`www.${host}`) ? "" : host.slice(0, 80);
  } catch {
    return "";
  }
}

export function cleanTag(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 50);
}

export function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export async function recordPageView(env: Env, request: Request, body: Record<string, unknown>): Promise<void> {
  if (isBot(request.headers.get("user-agent"))) return;
  const country = cleanTag((request as Request & { cf?: { country?: string } }).cf?.country).toUpperCase().slice(0, 2);
  await env.DB.prepare(
    `INSERT INTO page_views (day, path, referrer, source, country, views) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(day, path, referrer, source, country) DO UPDATE SET views = views + 1`,
  ).bind(utcDay(now()), cleanPath(body.path), referrerHost(body.referrer), cleanTag(body.source), country).run();
}

export async function recordSignupSource(env: Env, userId: string, source: unknown): Promise<void> {
  const data = (source && typeof source === "object" ? source : {}) as Record<string, unknown>;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO signup_sources (user_id, referrer, source, campaign, landing_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(userId, referrerHost(data.referrer), cleanTag(data.source), cleanTag(data.campaign), cleanPath(data.landing), now()).run();
}

/** Everything worth watching, for scripts/stats.py. */
export async function stats(env: Env, days: number) {
  const since = now() - days * 86400;
  const sinceDay = utcDay(since);
  const all = <T>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).all<T>().then((r) => r.results ?? []);
  const one = <T>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).first<T>();

  const [daily, pages, referrers, sources, countries, signupsBySource, funnel, revenue, clips] = await Promise.all([
    all("SELECT day, SUM(views) AS views FROM page_views WHERE day >= ? GROUP BY day ORDER BY day", sinceDay),
    all("SELECT path, SUM(views) AS views FROM page_views WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT 15", sinceDay),
    all("SELECT referrer, SUM(views) AS views FROM page_views WHERE day >= ? AND referrer != '' GROUP BY referrer ORDER BY views DESC LIMIT 15", sinceDay),
    all("SELECT source, SUM(views) AS views FROM page_views WHERE day >= ? AND source != '' GROUP BY source ORDER BY views DESC LIMIT 15", sinceDay),
    all("SELECT country, SUM(views) AS views FROM page_views WHERE day >= ? AND country != '' GROUP BY country ORDER BY views DESC LIMIT 10", sinceDay),
    all(
      `SELECT CASE WHEN s.source != '' THEN s.source WHEN s.referrer != '' THEN s.referrer ELSE 'direct' END AS origin,
              COUNT(*) AS signups
       FROM users u LEFT JOIN signup_sources s ON s.user_id = u.id
       WHERE u.created_at >= ? GROUP BY origin ORDER BY signups DESC LIMIT 15`,
      since,
    ),
    one<Record<string, number>>(
      `SELECT
         COUNT(*) AS signed_up,
         SUM(CASE WHEN u.tokens > 0 OR EXISTS (SELECT 1 FROM user_flags f WHERE f.user_id = u.id AND f.flag = 'free_plan')
                   OR EXISTS (SELECT 1 FROM token_ledger l WHERE l.user_id = u.id AND l.reason IN ('purchase','subscription_grant')) THEN 1 ELSE 0 END) AS chose_plan,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM licenses l WHERE l.user_id = u.id AND l.last_seen_at IS NOT NULL) THEN 1 ELSE 0 END) AS installed_engine,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM generations g WHERE g.user_id = u.id AND g.status = 'completed' AND g.clips_delivered > 0) THEN 1 ELSE 0 END) AS made_clips,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM purchases p WHERE p.user_id = u.id) THEN 1 ELSE 0 END) AS paid
       FROM users u WHERE u.created_at >= ?`,
      since,
    ),
    one<Record<string, number>>("SELECT COUNT(*) AS purchases, COALESCE(SUM(amount_cents), 0) AS cents FROM purchases WHERE created_at >= ?", since),
    one<Record<string, number>>(
      `SELECT COALESCE(SUM(CASE WHEN tier = 'free' THEN clips_delivered ELSE 0 END), 0) AS free_clips,
              COALESCE(SUM(CASE WHEN tier = 'tokens' THEN clips_delivered ELSE 0 END), 0) AS paid_clips
       FROM generations WHERE status = 'completed' AND created_at >= ?`,
      since,
    ),
  ]);

  return { days, daily, pages, referrers, sources, countries, signups_by_source: signupsBySource, funnel, revenue, clips };
}
