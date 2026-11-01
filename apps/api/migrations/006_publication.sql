-- Review fixes: when a story was published, what kind of change each version is, and a blocklist that
-- keeps banned people out after their account is deleted. Additive only.

-- When the story first became public, and the version that was public at that moment. Versions from
-- before it (a newcomer's drafts nobody reviewed) stay visible only to their author and reviewers.
ALTER TABLE stories ADD COLUMN published_at timestamptz;
ALTER TABLE stories ADD COLUMN published_revision_id uuid REFERENCES story_revisions(id);

-- Stories a reviewer approved: published when first approved, with the version current at that time.
UPDATE stories s SET
  published_at = a.approved_at,
  published_revision_id = (
    SELECT r.id FROM story_revisions r
    WHERE r.story_id = s.id AND r.status = 'accepted' AND r.created_at <= a.approved_at
    ORDER BY r.created_at DESC LIMIT 1)
FROM (SELECT target_id, min(created_at) AS approved_at FROM mod_actions
      WHERE action = 'approve' AND target_type = 'story' GROUP BY target_id) a
WHERE a.target_id = s.id::text;
-- Other public stories were published when created (Members' stories).
UPDATE stories s SET
  published_at = s.created_at,
  published_revision_id = (SELECT r.id FROM story_revisions r WHERE r.story_id = s.id ORDER BY r.created_at LIMIT 1)
WHERE s.status = 'active' AND s.published_at IS NULL;

-- What a version is: the story's first version, an edit, or a copy made by a restore or a ban clean-up.
-- Copies don't count as the copier's own edits (daily limits, promotion, "versions written").
ALTER TABLE story_revisions ADD COLUMN origin text NOT NULL DEFAULT 'edit'
  CHECK (origin IN ('create', 'edit', 'restore', 'rollback'));
UPDATE story_revisions SET origin = 'create' WHERE parent_revision_id IS NULL;
UPDATE story_revisions SET origin = 'restore' WHERE edit_summary LIKE 'Restored the version from %';
UPDATE story_revisions SET origin = 'rollback' WHERE edit_summary = 'Rolled back changes by a removed account';

-- Google accounts of banned people whose Hexstory account was deleted (SHA-256 of the Google `sub`),
-- so deleting a banned account doesn't let them sign up again.
CREATE TABLE banned_subjects (
  sub_hash   text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
