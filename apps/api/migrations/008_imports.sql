-- Bulk imports (docs/IMPORT.md): stories and developments loaded by `npm run import` remember the key
-- they had in the import file, so running an import again updates instead of duplicating, and the batch
-- they came in, so a bad batch can be taken down at once. Readers see imported stories labelled as such.
-- Additive only.
ALTER TABLE stories
  ADD COLUMN import_key   text,
  ADD COLUMN import_batch text;
CREATE UNIQUE INDEX stories_import_key_idx ON stories (import_key) WHERE import_key IS NOT NULL;
CREATE INDEX stories_import_batch_idx ON stories (import_batch) WHERE import_batch IS NOT NULL;

ALTER TABLE story_developments ADD COLUMN import_key text;
CREATE UNIQUE INDEX story_developments_import_key_idx ON story_developments (import_key) WHERE import_key IS NOT NULL;
