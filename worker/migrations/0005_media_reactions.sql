-- Emoji reactions on race photos.
--
-- One row per person per emoji per photo, so reacting twice with the same
-- emoji is the same row and taking it back is a delete. The address is here
-- because a reaction has to be somebody's to be taken back; it is never sent
-- to anybody else, who see counts only.
--
-- slug rides along so a race's reactions go with the race in one statement,
-- and so the photo list can fetch every reaction on a race in one read rather
-- than one per photo.
CREATE TABLE IF NOT EXISTS media_reactions (
  media_id   TEXT NOT NULL,
  slug       TEXT NOT NULL,
  email      TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (media_id, email, emoji)
);

CREATE INDEX IF NOT EXISTS media_reactions_slug ON media_reactions(slug);
CREATE INDEX IF NOT EXISTS media_reactions_email ON media_reactions(email);
