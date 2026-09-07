-- Race data, as rows rather than as files in a git repository.
--
-- Two reasons this exists, and only one of them is latency. A split is a row
-- that changes every few minutes for thirty hours, which version control is
-- the wrong shape for. And a race config in a public repository publishes its
-- roster, by email address, to anybody who asks for the URL.
--
-- Nothing reads these tables yet. The schema ships first so it can be applied
-- and inspected before any code depends on it.

-- One row per race. `config` holds everything about the course, the fueling
-- plan and the runners: the shape the app already reads, minus the roster,
-- which is an access list and lives in its own table.
CREATE TABLE IF NOT EXISTS races (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  location     TEXT,
  start_time   TEXT,
  visibility   TEXT NOT NULL DEFAULT 'public',
  created_by   TEXT NOT NULL,
  config       TEXT NOT NULL,          -- JSON
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS races_created_by ON races (created_by);
CREATE INDEX IF NOT EXISTS races_visibility ON races (visibility);

-- Who is on a race and what they may do. Separate from `races` because it is
-- the thing that must never be served to a reader: a roster is a list of
-- people's addresses.
CREATE TABLE IF NOT EXISTS race_people (
  slug   TEXT NOT NULL,
  email  TEXT NOT NULL,
  role   TEXT NOT NULL,                -- crew | racer | pacer | viewer
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (slug, email),
  FOREIGN KEY (slug) REFERENCES races (slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS race_people_email ON race_people (email);

-- One row per leg per runner. A press is an insert or a single-column update
-- rather than a rewrite of the whole race, which is what removes the sha
-- conflict retry loop and lets a client ask for only what changed.
CREATE TABLE IF NOT EXISTS legs (
  slug        TEXT NOT NULL,
  runner_id   TEXT NOT NULL,
  idx         INTEGER NOT NULL,        -- 1-based, matches the app's leg index
  start_time  TEXT,
  end_time    TEXT,
  calories    INTEGER,
  fluid_oz    REAL,
  sodium_mg   INTEGER,
  note        TEXT,
  actor       TEXT,                    -- who pressed it, which git gave for free
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (slug, runner_id, idx),
  FOREIGN KEY (slug) REFERENCES races (slug) ON DELETE CASCADE
);
-- Answers "what has changed since I last asked", which is what stops a poll
-- costing a whole race every ten seconds.
CREATE INDEX IF NOT EXISTS legs_updated ON legs (slug, updated_at);
