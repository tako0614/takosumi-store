-- Free-form, multi-valued browse tags per listing, stored as a JSON string
-- array (e.g. ["social","activitypub"]). The legacy single `category` column is
-- retained and, going forward, mirrors tags[0].
ALTER TABLE listings ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
