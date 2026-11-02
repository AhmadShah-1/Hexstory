-- Connected history: precise locations, summaries, categories, people and links on story versions;
-- event timelines (developments), corrections, collections and featured stories. The Square (live chat)
-- is retired: its `comments` table stays as dormant data and is no longer read or written.
-- Additive only, so the previous deployment keeps working while this one rolls out.

-- New, versioned content of a story. Older versions have NULL summary/point and empty lists.
ALTER TABLE story_revisions
  ADD COLUMN summary    text,
  ADD COLUMN categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN lat        double precision,
  ADD COLUMN lng        double precision,
  ADD COLUMN place_name text,
  ADD COLUMN people     text[] NOT NULL DEFAULT '{}',
  -- [{ "storyId": uuid, "relation": "preceded-by" | "led-to" | "part-of" | "includes" | "related" }]
  ADD COLUMN links      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(links) = 'array'),
  ADD CONSTRAINT story_revisions_point_check CHECK (
    (lat IS NULL) = (lng IS NULL) AND (lat IS NULL OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)));

-- When the story last changed in a way readers care about (accepted version or development), and
-- whether reviewers featured it on the home page.
ALTER TABLE stories
  ADD COLUMN last_update_at timestamptz,
  ADD COLUMN featured_at    timestamptz;
UPDATE stories SET last_update_at = updated_at;
ALTER TABLE stories ALTER COLUMN last_update_at SET NOT NULL, ALTER COLUMN last_update_at SET DEFAULT now();
CREATE INDEX stories_featured_idx ON stories (featured_at DESC) WHERE featured_at IS NOT NULL;
CREATE INDEX stories_active_idx ON stories (last_update_at DESC) WHERE status = 'active';

-- Derived index of the current version's links (like story_cells), so a story can list what links to it.
CREATE TABLE story_links (
  from_story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  to_story_id   uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  relation      text NOT NULL CHECK (relation IN ('preceded-by', 'led-to', 'part-of', 'includes', 'related')),
  PRIMARY KEY (from_story_id, to_story_id)
);
CREATE INDEX story_links_to_idx ON story_links (to_story_id);

-- An event's timeline: dated developments with their own place and sources. Not edited after posting;
-- reviewers can remove one (hidden_at). Newcomers' developments wait for review like their edits.
CREATE TABLE story_developments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id    uuid NOT NULL REFERENCES stories(id),
  author_id   uuid NOT NULL REFERENCES users(id),
  year        int NOT NULL CHECK (year <> 0),
  month       smallint CHECK (month BETWEEN 1 AND 12),
  day         smallint CHECK (day BETWEEN 1 AND 31),
  sort_key    int GENERATED ALWAYS AS (year * 10000 + COALESCE(month, 0) * 100 + COALESCE(day, 0)) STORED,
  title       text NOT NULL,
  body        text,
  lat         double precision,
  lng         double precision,
  place_name  text,
  sources     jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) >= 1),
  status      text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  hidden_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX story_developments_story_idx ON story_developments (story_id, sort_key DESC, created_at DESC);
CREATE INDEX story_developments_pending_idx ON story_developments (created_at) WHERE status = 'pending';
CREATE INDEX story_developments_author_idx ON story_developments (author_id, created_at DESC);

-- Readers dispute one statement of a specific version, propose a fix and give counter-evidence.
-- Reviewers accept or reject with a public note; nothing is removed from the story's history.
CREATE TABLE corrections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id          uuid NOT NULL REFERENCES stories(id),
  revision_id       uuid NOT NULL REFERENCES story_revisions(id),
  author_id         uuid NOT NULL REFERENCES users(id),
  quote             text NOT NULL,
  problem           text NOT NULL CHECK (problem IN ('inaccurate', 'missing-context', 'unsupported', 'outdated')),
  proposal          text NOT NULL,
  evidence          jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) >= 1),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  resolution_note   text,
  resolved_by       uuid REFERENCES users(id),
  resolved_at       timestamptz,
  fixed_revision_id uuid REFERENCES story_revisions(id),
  hidden_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX corrections_story_idx ON corrections (story_id, created_at DESC);
CREATE INDEX corrections_open_idx ON corrections (created_at) WHERE status = 'open';
CREATE INDEX corrections_author_idx ON corrections (author_id, created_at DESC);

-- Narratives grouping stories: hand-picked items plus optional rules (an area, categories, years).
CREATE TABLE collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('place', 'theme')),
  -- Compact cells of the area, at resolution 2 or finer (matched against story_cells).
  cells       text[] NOT NULL DEFAULT '{}',
  categories  text[] NOT NULL DEFAULT '{}',
  from_year   int,
  to_year     int,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  featured_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collections_created_by_idx ON collections (created_by, created_at DESC);

CREATE TABLE collection_items (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  story_id      uuid NOT NULL REFERENCES stories(id),
  position      int NOT NULL,
  note          text,
  PRIMARY KEY (collection_id, story_id)
);
CREATE INDEX collection_items_story_idx ON collection_items (story_id);

-- Reports can now be about developments, corrections and collections. Open reports about chat
-- messages are closed: the Square is gone.
ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('story', 'revision', 'comment', 'user', 'development', 'correction', 'collection'));
UPDATE reports SET resolved_at = now(), resolution = 'dismissed' WHERE target_type = 'comment' AND resolved_at IS NULL;
