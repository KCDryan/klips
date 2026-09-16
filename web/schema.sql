-- Klips cloud database (Cloudflare D1).
-- The website is the authority on who owns a licence, how many tokens they hold, and what they generated.
-- Apply with:  npm run db:init        (local)
--              npm run db:init:remote (production)

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,           -- usr_xxx
  email               TEXT NOT NULL UNIQUE,
  stripe_customer_id  TEXT UNIQUE,
  tokens              INTEGER NOT NULL DEFAULT 0, -- current balance, always matches the sum of token_ledger.delta
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- A licence key is the customer's sign-in for both the desktop app and the account portal.
CREATE TABLE IF NOT EXISTS licenses (
  key           TEXT PRIMARY KEY,                 -- KLIPS-XXXX-XXXX-XXXX-XXXX
  user_id       TEXT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  device_name   TEXT,                             -- last machine that used it
  device_id     TEXT,                             -- stable per-machine id from the app
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS licenses_user ON licenses(user_id);

-- Every token movement, so a balance can always be explained and audited.
CREATE TABLE IF NOT EXISTS token_ledger (
  id          TEXT PRIMARY KEY,                   -- led_xxx
  user_id     TEXT NOT NULL REFERENCES users(id),
  delta       INTEGER NOT NULL,                   -- + purchase/refund/grant, - spend
  reason      TEXT NOT NULL,                      -- purchase | subscription_grant | spend | refund | manual
  reference   TEXT,                               -- stripe id, generation id, or a note
  balance_after INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user_time ON token_ledger(user_id, created_at DESC);
-- One ledger row per Stripe event / spend request: makes retries and webhook replays harmless.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_reason_reference ON token_ledger(reason, reference) WHERE reference IS NOT NULL;

-- One row per video the desktop app processes, reported back for the customer's history.
CREATE TABLE IF NOT EXISTS generations (
  id             TEXT PRIMARY KEY,                -- gen_xxx (created when tokens are reserved)
  user_id        TEXT NOT NULL REFERENCES users(id),
  license_key    TEXT REFERENCES licenses(key),
  status         TEXT NOT NULL DEFAULT 'reserved',-- reserved | completed | failed | refunded
  source_name    TEXT,                            -- file name of the uploaded video, for the customer's own reference
  source_seconds REAL,
  clips_requested INTEGER NOT NULL,
  clips_delivered INTEGER,
  tokens_charged INTEGER NOT NULL,
  platform       TEXT,                            -- tiktok | reels | shorts | linkedin
  app_version    TEXT,
  device_name    TEXT,
  titles         TEXT,                            -- JSON array of clip titles, for the history page
  error          TEXT,
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS generations_user_time ON generations(user_id, created_at DESC);

-- Stripe purchases: one-off token packs and subscription payments.
CREATE TABLE IF NOT EXISTS purchases (
  id                TEXT PRIMARY KEY,             -- pur_xxx
  user_id           TEXT NOT NULL REFERENCES users(id),
  stripe_event_id   TEXT UNIQUE,                  -- guards against duplicate webhook delivery
  stripe_session_id TEXT,
  kind              TEXT NOT NULL,                -- pack | subscription
  plan              TEXT,                         -- starter | creator | studio (subscriptions only)
  interval          TEXT,                         -- month | year (subscriptions only)
  tokens            INTEGER NOT NULL,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'usd',
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS purchases_user_time ON purchases(user_id, created_at DESC);

-- Active subscriptions, so monthly token grants can be issued once per billing period.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY,          -- stripe subscription id
  user_id              TEXT NOT NULL REFERENCES users(id),
  plan                 TEXT NOT NULL,             -- starter | creator | studio
  interval             TEXT NOT NULL,             -- month | year
  status               TEXT NOT NULL,             -- active | past_due | canceled | ...
  tokens_per_period    INTEGER NOT NULL,
  current_period_end   INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id);

-- Short-lived sign-in codes emailed/shown to customers for the account portal.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,                    -- random, stored hashed
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
