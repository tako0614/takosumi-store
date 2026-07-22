-- Store listings are repository-discovery pointers. The public identity is the
-- Git URL plus module path; ref/resolved_commit are retained only as internal
-- compatibility columns for old rows and are no longer part of the public TCS
-- contract.

DROP INDEX IF EXISTS listings_source_unique;
CREATE UNIQUE INDEX listings_source_unique ON listings (git, path);
