-- TCS official implementation — initial schema.
-- Canonical hand-authored D1 migration (mirrored by src/backend/db/schema.ts).

CREATE TABLE listings (
  id                     TEXT PRIMARY KEY,
  git                    TEXT NOT NULL,
  ref                    TEXT NOT NULL,
  resolved_commit        TEXT,
  path                   TEXT NOT NULL DEFAULT '',
  kind                   TEXT NOT NULL,
  surface                TEXT NOT NULL,
  provider               TEXT NOT NULL,
  category               TEXT NOT NULL,
  suggested_name         TEXT NOT NULL,
  name_ja                TEXT NOT NULL,
  name_en                TEXT NOT NULL,
  description_ja         TEXT NOT NULL DEFAULT '',
  description_en         TEXT NOT NULL DEFAULT '',
  badge_ja               TEXT NOT NULL DEFAULT '',
  badge_en               TEXT NOT NULL DEFAULT '',
  icon_url               TEXT,
  inputs                 TEXT NOT NULL DEFAULT '[]',
  output_allowlist       TEXT NOT NULL DEFAULT '[]',
  publisher_id           TEXT,
  publisher_handle       TEXT,
  publisher_display_name TEXT,
  badges                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'visible',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE UNIQUE INDEX listings_source_unique ON listings (git, ref, path);
CREATE INDEX listings_updated_idx  ON listings (updated_at, id);
CREATE INDEX listings_created_idx  ON listings (created_at, id);
CREATE INDEX listings_category_idx ON listings (category);
CREATE INDEX listings_kind_idx     ON listings (kind);
CREATE INDEX listings_provider_idx ON listings (provider);
