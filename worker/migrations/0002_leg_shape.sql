-- The legs table was written from the app's field names as I remembered them.
-- The real ones, read off a finished race: notes rather than note, plus
-- intakeEstimated and issues, which were missing entirely.
--
-- Recreated rather than altered. The table has never held a row and nothing
-- reads it, so a rebuild is honest and leaves a schema anyone can read in one
-- place instead of a first version plus a list of corrections.
DROP TABLE IF EXISTS legs;

CREATE TABLE legs (
  slug              TEXT NOT NULL,
  runner_id         TEXT NOT NULL,
  idx               INTEGER NOT NULL,     -- 1-based, the app's leg index
  start_time        TEXT,
  end_time          TEXT,
  calories          INTEGER,
  fluid_oz          REAL,
  sodium_mg         INTEGER,
  intake_estimated  INTEGER,              -- 0/1: the crew guessed rather than measured
  notes             TEXT,
  issues            TEXT,                 -- JSON array
  -- The leg exactly as the app wrote it. The columns above are for querying;
  -- this is so a round trip through the database cannot quietly lose a field
  -- that gets added later and nobody remembers to add here.
  raw               TEXT NOT NULL,
  actor             TEXT,                 -- who pressed it, which git gave for free
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (slug, runner_id, idx),
  FOREIGN KEY (slug) REFERENCES races (slug) ON DELETE CASCADE
);
CREATE INDEX legs_updated ON legs (slug, updated_at);
