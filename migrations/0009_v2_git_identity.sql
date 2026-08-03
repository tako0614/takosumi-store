-- TCS 2.0 uses the canonical repository URL as the listing identity.
--
-- The identity is materialized rather than derived in a query predicate. A
-- normalized URL is therefore both indexed and available to every write path,
-- while the legacy module-path uniqueness index remains intact for v1.

-- Build the audit table before altering the live schema. If a legacy row is
-- malformed or collides after canonicalization, this statement fails and no
-- git_identity column has been added yet.
DROP TABLE IF EXISTS listings_v2_git_identity_audit;
CREATE TEMP TABLE listings_v2_git_identity_audit (
  id           TEXT PRIMARY KEY,
  git_identity TEXT NOT NULL CHECK (git_identity <> ''),
  UNIQUE (git_identity)
);

WITH RECURSIVE control_codes(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM control_codes WHERE n < 31
), c1_control_codes(n) AS (
  SELECT 127
  UNION ALL
  SELECT n + 1 FROM c1_control_codes WHERE n < 159
), raw AS (
  SELECT id, trim(git) AS value
  FROM listings
), parts AS (
  SELECT
    id,
    value,
    substr(value, 9) AS tail,
    instr(substr(value, 9), '/') AS slash
  FROM raw
), split AS (
  SELECT
    id,
    value,
    substr(tail, 1, slash - 1) AS authority,
    substr(tail, slash) AS raw_path,
    slash
  FROM parts
), authority_parts AS (
  SELECT
    id,
    value,
    authority,
    raw_path,
    slash,
    CASE
      WHEN instr(authority, ':') = 0 THEN lower(authority)
      WHEN instr(substr(authority, instr(authority, ':') + 1), ':') > 0 THEN NULL
      WHEN substr(authority, 1, instr(authority, ':') - 1) = '' THEN NULL
      WHEN substr(authority, instr(authority, ':') + 1) = '' THEN NULL
      WHEN substr(authority, instr(authority, ':') + 1) GLOB '*[^0-9]*' THEN NULL
      WHEN CAST(substr(authority, instr(authority, ':') + 1) AS INTEGER) > 65535 THEN NULL
      WHEN CAST(substr(authority, instr(authority, ':') + 1) AS INTEGER) = 443
        THEN lower(substr(authority, 1, instr(authority, ':') - 1))
      ELSE lower(substr(authority, 1, instr(authority, ':') - 1)) || ':' ||
        CAST(CAST(substr(authority, instr(authority, ':') + 1) AS INTEGER) AS TEXT)
    END AS canonical_authority,
    CASE
      WHEN instr(authority, ':') = 0 THEN authority
      ELSE substr(authority, 1, instr(authority, ':') - 1)
    END AS host
  FROM split
), path_parts AS (
  SELECT
    id,
    value,
    authority,
    host,
    raw_path,
    slash,
    canonical_authority,
    rtrim(raw_path, '/') AS trimmed_path
  FROM authority_parts
), canonical_rows AS (
  SELECT
    id,
    CASE
      WHEN lower(substr(trimmed_path, -4)) = '.git'
        THEN rtrim(substr(trimmed_path, 1, length(trimmed_path) - 4), '/')
      ELSE trimmed_path
    END AS canonical_path,
    value,
    authority,
    host,
    slash,
    canonical_authority
  FROM path_parts
)
INSERT INTO listings_v2_git_identity_audit (id, git_identity)
SELECT
  id,
  CASE
    WHEN lower(substr(value, 1, 8)) <> 'https://'
      OR instr(value, '\') > 0
      OR instr(value, '?') > 0
      OR instr(value, '#') > 0
      OR EXISTS (
        SELECT 1 FROM control_codes WHERE instr(value, char(n)) > 0
      )
      OR EXISTS (
        SELECT 1 FROM c1_control_codes WHERE instr(value, char(n)) > 0
      )
      OR instr(value, '@') > 0
      OR slash = 0
      OR authority = ''
      OR host = ''
      OR host GLOB '*[^A-Za-z0-9.-]*'
      OR instr(host, '..') > 0
      OR substr(host, 1, 1) IN ('.', '-')
      OR substr(host, -1, 1) IN ('.', '-')
      OR host GLOB '*.-*'
      OR host GLOB '*-.*'
      OR canonical_authority IS NULL
      OR canonical_path = ''
      OR canonical_path = '/'
      OR canonical_path GLOB '*[^/A-Za-z0-9._~-]*'
      OR instr(canonical_path, '//') > 0
      OR canonical_path IN ('/.', '/..')
      OR canonical_path LIKE '/./%'
      OR canonical_path LIKE '/../%'
      OR canonical_path LIKE '%/./%'
      OR canonical_path LIKE '%/../%'
      OR canonical_path LIKE '%/.'
      OR canonical_path LIKE '%/..'
      THEN NULL
    ELSE 'https://' || canonical_authority || canonical_path
  END AS git_identity
FROM canonical_rows;

ALTER TABLE listings ADD COLUMN git_identity TEXT NOT NULL DEFAULT '';

-- Copy the audited identity into the canonical raw URL column as well. v1
-- readers therefore see the same URL normalization, while v2 uses the indexed
-- materialized key below for collision checks and exact lookup.
UPDATE listings
SET
  git_identity = (
    SELECT git_identity
    FROM listings_v2_git_identity_audit audit
    WHERE audit.id = listings.id
  ),
  git = (
    SELECT git_identity
    FROM listings_v2_git_identity_audit audit
    WHERE audit.id = listings.id
  );

DROP TABLE listings_v2_git_identity_audit;

CREATE UNIQUE INDEX listings_v2_git_identity_unique
  ON listings (git_identity);

-- Keyset list paths always constrain visibility before ordering. Category and
-- scope each have both sort indexes; the API rejects an unindexed
-- category+scope combination rather than silently scanning one partition.
CREATE INDEX listings_v2_visible_updated_idx
  ON listings (status, updated_at, id);
CREATE INDEX listings_v2_visible_created_idx
  ON listings (status, created_at, id);
CREATE INDEX listings_v2_visible_category_updated_idx
  ON listings (status, category, updated_at, id);
CREATE INDEX listings_v2_visible_category_created_idx
  ON listings (status, category, created_at, id);
CREATE INDEX listings_v2_visible_scope_updated_idx
  ON listings (status, scope, updated_at, id);
CREATE INDEX listings_v2_visible_scope_created_idx
  ON listings (status, scope, created_at, id);
