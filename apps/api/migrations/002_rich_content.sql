-- Story bodies become structured documents (see packages/shared/src/richtext.ts).
-- `body` stays as the server-derived plain text (diffs, abuse checks); `image_key` / `image_credit`
-- now hold the first image in the content and serve as the list thumbnail.
-- Rows written before this migration have content = NULL and are rendered from `body` (legacyDoc).
ALTER TABLE story_revisions ADD COLUMN content jsonb CHECK (content IS NULL OR jsonb_typeof(content) = 'array');
