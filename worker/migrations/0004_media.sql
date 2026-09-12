-- Photos, attached to a leg of the course.
--
-- leg_idx is the course leg, not one runner's leg, which is the one design
-- decision in here worth stating. A photo of the aid station, or of two of
-- your runners standing together, does not belong to any one person, and a
-- single-runner race hides that difference until the first time somebody crews
-- two people. runner_id is the optional tag for when a photo really is of
-- somebody: the leg's dropdown shows everything on the leg, a runner's own
-- views can narrow to theirs.
--
-- The bytes are in R2 and only the key is here. R2 charges nothing for egress
-- and a photo never changes once written, so the object can be served straight
-- from a bucket hostname and cached at the edge: the worker gates the upload
-- and then gets out of the way of every read. Putting the image in D1 would
-- have made every view a database read and every spectator a worker request.
CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,
  leg_idx      INTEGER NOT NULL,
  runner_id    TEXT,
  r2_key       TEXT NOT NULL,
  content_type TEXT,
  bytes        INTEGER,
  width        INTEGER,
  height       INTEGER,
  caption      TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);

-- Every read is "the photos on this race", usually grouped by leg.
CREATE INDEX IF NOT EXISTS media_slug_leg ON media(slug, leg_idx);
