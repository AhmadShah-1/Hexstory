-- Moderator tools: manual trust levels, removable versions, ban requests, richer audit log.
-- Additive only, so the previous deployment keeps working while this one rolls out.

-- A moderator set this user's level by hand; automatic promotion leaves it alone.
ALTER TABLE users ADD COLUMN trust_locked boolean NOT NULL DEFAULT false;

-- A version removed from the history (abuse in an old version, or a ban clean-up). Never restorable;
-- visible to reviewers only.
ALTER TABLE story_revisions ADD COLUMN hidden_at timestamptz;

-- Structured facts about an action (e.g. what a ban clean-up removed).
ALTER TABLE mod_actions ADD COLUMN details jsonb;
CREATE INDEX mod_actions_created_idx ON mod_actions (created_at DESC, id DESC);
CREATE INDEX mod_actions_actor_idx ON mod_actions (actor_id, created_at DESC);

-- Reviewers ask moderators to ban someone; moderators ban or decline, which resolves every open request.
CREATE TABLE ban_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  resolution   text CHECK (resolution IN ('banned', 'declined', 'deleted'))
);
CREATE UNIQUE INDEX ban_requests_open_once ON ban_requests (user_id, requested_by) WHERE resolved_at IS NULL;
CREATE INDEX ban_requests_open_idx ON ban_requests (user_id) WHERE resolved_at IS NULL;

-- Per-user lookups for contribution pages and clean-up.
CREATE INDEX stories_created_by_idx ON stories (created_by, created_at DESC);
CREATE INDEX comments_user_idx ON comments (user_id, created_at DESC);
CREATE INDEX reports_target_idx ON reports (target_type, target_id) WHERE resolved_at IS NULL;
