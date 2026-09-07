-- The mirror stores race data. Serving a read needs the file.
--
-- Two things the typed columns do not carry:
--
--   lastUpdated, a top-level field on every data.json. Rebuilding the file
--   from legs rows alone would quietly drop it.
--
--   the git blob sha. A client round-trips it from a read into its next
--   commit, and the worker hands it to GitHub as the optimistic-concurrency
--   guard: it is what stops two crew clobbering each other's splits. A read
--   that returns the wrong sha fails every write, and one that returns none
--   drops the guard silently, which only shows up when two people press at
--   once, which is race day.
--
-- So the document is kept verbatim, exactly as it was written, next to its
-- sha. The typed rows stay what they are: a projection for querying, not the
-- thing a read is rebuilt from.
ALTER TABLE races ADD COLUMN config_sha TEXT;
ALTER TABLE races ADD COLUMN data       TEXT;
ALTER TABLE races ADD COLUMN data_sha   TEXT;
