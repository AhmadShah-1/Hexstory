-- Hexstory initial schema. See docs/DESIGN.md "Data model" for the reasoning behind each table.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub        text UNIQUE NOT NULL,
  email             text,
  display_name      text NOT NULL,
  trust_level       smallint NOT NULL DEFAULT 0 CHECK (trust_level BETWEEN 0 AND 3),
  terms_accepted_at timestamptz,
  banned_at         timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_display_name_key ON users (lower(display_name)) WHERE deleted_at IS NULL;

CREATE TABLE sessions (
  id         text PRIMARY KEY,               -- sha256 of the cookie token; the raw token is never stored
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE stories (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  current_revision_id uuid,
  status              text NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed', 'active', 'hidden')),
  protection_level    smallint NOT NULL DEFAULT 0 CHECK (protection_level BETWEEN 0 AND 3),
  cell_count          int NOT NULL DEFAULT 0,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE story_revisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id           uuid NOT NULL REFERENCES stories(id),
  parent_revision_id uuid REFERENCES story_revisions(id),
  author_id          uuid NOT NULL REFERENCES users(id),
  title              text NOT NULL,
  body               text NOT NULL,
  image_key          text,
  image_credit       text,
  cells              text[] NOT NULL,        -- compacted H3 cells (see packages/shared/src/hex.ts)
  start_year         int NOT NULL CHECK (start_year <> 0),
  start_month        smallint CHECK (start_month BETWEEN 1 AND 12),
  start_day          smallint CHECK (start_day BETWEEN 1 AND 31),
  end_year           int CHECK (end_year <> 0),
  end_month          smallint CHECK (end_month BETWEEN 1 AND 12),
  end_day            smallint CHECK (end_day BETWEEN 1 AND 31),
  is_ongoing         boolean NOT NULL DEFAULT false,
  is_approx          boolean NOT NULL DEFAULT false,
  sources            jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) >= 1),
  source_count       int GENERATED ALWAYS AS (jsonb_array_length(sources)) STORED,
  -- Most recent date the event touches; mirrors sortKey() in packages/shared/src/dates.ts
  sort_key           int GENERATED ALWAYS AS (
                       COALESCE(end_year, start_year) * 10000
                       + COALESCE(CASE WHEN end_year IS NULL THEN start_month ELSE end_month END, 0) * 100
                       + COALESCE(CASE WHEN end_year IS NULL THEN start_day ELSE end_day END, 0)
                     ) STORED,
  status             text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  edit_summary       text,
  flags              text[] NOT NULL DEFAULT '{}',
  reviewed_by        uuid REFERENCES users(id),
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX story_revisions_story_idx ON story_revisions (story_id, created_at DESC);
CREATE INDEX story_revisions_pending_idx ON story_revisions (created_at) WHERE status = 'pending';
CREATE INDEX story_revisions_author_idx ON story_revisions (author_id, created_at DESC);

ALTER TABLE stories
  ADD CONSTRAINT stories_current_revision_fk FOREIGN KEY (current_revision_id) REFERENCES story_revisions(id);

-- Every display cell (resolutions 2-5) the current revision touches. Rebuilt when the current revision changes.
CREATE TABLE story_cells (
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  res      smallint NOT NULL,
  cell     text NOT NULL,
  PRIMARY KEY (story_id, cell)
);
CREATE INDEX story_cells_cell_idx ON story_cells (cell);
CREATE INDEX story_cells_res_idx ON story_cells (res, cell);

-- The Square: live chat, one room per display cell.
CREATE TABLE comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cell       text NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  hidden_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_cell_idx ON comments (cell, created_at DESC);

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('story', 'revision', 'comment', 'user')),
  target_id   text NOT NULL,
  reporter_id uuid NOT NULL REFERENCES users(id),
  reason      text NOT NULL,
  details     text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_open_idx ON reports (created_at) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX reports_once_per_user ON reports (reporter_id, target_type, target_id) WHERE resolved_at IS NULL;

-- Append-only audit log of every moderation action.
CREATE TABLE mod_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid NOT NULL REFERENCES users(id),
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mod_actions_target_idx ON mod_actions (target_type, target_id);
