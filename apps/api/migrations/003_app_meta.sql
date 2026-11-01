-- Small key/value facts about the database itself. 'environment' records which deployment
-- environment (development, preview, production) the database belongs to; the app refuses to
-- start against a database marked for a different environment.
CREATE TABLE app_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
