-- Privacy-friendly analytics: daily page-view counts and where sign-ups came from. No cookies, no visitor ids.
-- Run once on databases created before this change.
CREATE TABLE IF NOT EXISTS page_views (
  day      TEXT NOT NULL,     -- YYYY-MM-DD (UTC)
  path     TEXT NOT NULL,
  referrer TEXT NOT NULL,     -- referring site's hostname, or '' for direct
  source   TEXT NOT NULL,     -- utm_source, or ''
  country  TEXT NOT NULL,     -- two-letter code from Cloudflare, or ''
  views    INTEGER NOT NULL,
  PRIMARY KEY (day, path, referrer, source, country)
);
CREATE TABLE IF NOT EXISTS signup_sources (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  referrer     TEXT NOT NULL,
  source       TEXT NOT NULL,
  campaign     TEXT NOT NULL,
  landing_path TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
