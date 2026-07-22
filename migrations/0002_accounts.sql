-- TCS official implementation — accounts, sessions, moderation (M3).
-- No FOREIGN KEY constraints (D1 enforces FKs and cascade ordering is a
-- footgun); referential integrity is maintained in the service layer.

CREATE TABLE publishers (
  id               TEXT PRIMARY KEY,
  oidc_sub         TEXT NOT NULL UNIQUE,
  handle           TEXT UNIQUE,
  display_name     TEXT,
  email            TEXT,
  role             TEXT NOT NULL DEFAULT 'publisher',
  followed_servers TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX sessions_publisher_idx ON sessions (publisher_id);

CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  listing_id   TEXT NOT NULL,
  reporter_sub TEXT,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL
);
CREATE INDEX reports_listing_idx ON reports (listing_id);
CREATE INDEX reports_status_idx ON reports (status);
