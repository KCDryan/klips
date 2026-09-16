-- Free plan: 10 watermarked clips a day. Run once on databases created before this change:
--   npx wrangler d1 execute klips --remote --file=./migrations/0002_free_plan.sql
ALTER TABLE generations ADD COLUMN tier TEXT NOT NULL DEFAULT 'tokens';
CREATE INDEX IF NOT EXISTS generations_user_tier_time ON generations(user_id, tier, created_at);
CREATE TABLE IF NOT EXISTS user_flags (
  user_id    TEXT NOT NULL REFERENCES users(id),
  flag       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, flag)
);
