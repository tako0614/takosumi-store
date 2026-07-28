-- Remove retired install-authority columns without editing deployed history.
-- Every listing row and public identifier is copied forward unchanged; only
-- version selection, install form, and output projection columns are retired.

CREATE TABLE listings_v2 (
  id                     TEXT PRIMARY KEY,
  scope                  TEXT NOT NULL DEFAULT '',
  slug                   TEXT NOT NULL DEFAULT '',
  git                    TEXT NOT NULL,
  path                   TEXT NOT NULL DEFAULT '',
  kind                   TEXT NOT NULL,
  surface                TEXT NOT NULL,
  provider               TEXT NOT NULL,
  category               TEXT NOT NULL,
  tags                   TEXT NOT NULL DEFAULT '[]',
  suggested_name         TEXT NOT NULL,
  name_ja                TEXT NOT NULL,
  name_en                TEXT NOT NULL,
  description_ja         TEXT NOT NULL DEFAULT '',
  description_en         TEXT NOT NULL DEFAULT '',
  badge_ja               TEXT NOT NULL DEFAULT '',
  badge_en               TEXT NOT NULL DEFAULT '',
  icon_url               TEXT,
  publisher_id           TEXT,
  publisher_handle       TEXT,
  publisher_display_name TEXT,
  badges                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'visible',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

INSERT INTO listings_v2 (
  id, scope, slug, git, path, kind, surface, provider, category, tags,
  suggested_name, name_ja, name_en, description_ja, description_en,
  badge_ja, badge_en, icon_url, publisher_id, publisher_handle,
  publisher_display_name, badges, status, created_at, updated_at
)
SELECT
  id, scope, slug,
  CASE
    WHEN lower(substr(rtrim(git, '/'), -4)) = '.git'
      THEN substr(rtrim(git, '/'), 1, length(rtrim(git, '/')) - 4)
    ELSE rtrim(git, '/')
  END,
  CASE WHEN path = '.' THEN '' ELSE trim(path, '/') END,
  kind, surface, provider, category, tags,
  suggested_name, name_ja, name_en, description_ja, description_en,
  badge_ja, badge_en, icon_url, publisher_id, publisher_handle,
  publisher_display_name, badges, status, created_at, updated_at
FROM listings;

DROP TABLE listings;
ALTER TABLE listings_v2 RENAME TO listings;

CREATE UNIQUE INDEX listings_source_unique ON listings (git, path);
CREATE INDEX listings_scope_idx ON listings (scope, slug);
CREATE INDEX listings_updated_idx ON listings (updated_at, id);
CREATE INDEX listings_created_idx ON listings (created_at, id);
CREATE INDEX listings_category_idx ON listings (category);
CREATE INDEX listings_kind_idx ON listings (kind);
CREATE INDEX listings_provider_idx ON listings (provider);
