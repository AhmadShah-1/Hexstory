-- Moderator-editable rules, and a record of photo uploads for per-user daily quotas.
-- Additive only, so the previous deployment keeps working while this one rolls out.

-- Runtime settings changed on the Moderation screen. `rules` holds overrides of RULES
-- (packages/shared/src/rules.ts); missing keys fall back to the defaults in code.
CREATE TABLE site_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per upload slot handed out. `declared_bytes` is the original's signed size (it bounds what
-- can land in staging storage); `stored_bytes` is what was published (WebP full + thumbnail).
CREATE TABLE uploads (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  declared_bytes int NOT NULL,
  stored_bytes   int,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX uploads_user_idx ON uploads (user_id, created_at DESC);
