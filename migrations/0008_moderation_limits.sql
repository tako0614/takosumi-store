-- Stable report deduplication and atomic fixed-window rate limits. The rebuild
-- also removes the raw OIDC subject: moderation needs an opaque abuse key, not
-- a second copy of account identity.

CREATE TABLE reports_v2 (
  id            TEXT PRIMARY KEY,
  listing_id    TEXT NOT NULL,
  reporter_key  TEXT NOT NULL,
  reason_digest TEXT NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TEXT NOT NULL
);

INSERT INTO reports_v2 (
  id, listing_id, reporter_key, reason_digest, reason, status, created_at
)
SELECT
  id, listing_id, 'legacy:' || id, '', reason, status, created_at
FROM reports;

DROP TABLE reports;
ALTER TABLE reports_v2 RENAME TO reports;

CREATE INDEX reports_listing_idx ON reports (listing_id);
CREATE INDEX reports_status_idx ON reports (status);

CREATE UNIQUE INDEX reports_open_dedupe_unique
  ON reports (listing_id, reporter_key, reason_digest)
  WHERE status = 'open';

CREATE TABLE report_rate_limits (
  reporter_key TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  count        INTEGER NOT NULL CHECK (count > 0),
  CONSTRAINT report_rate_limits_pk PRIMARY KEY (reporter_key, bucket_start)
);
