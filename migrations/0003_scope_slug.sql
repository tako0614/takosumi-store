-- scope/slug listing identity. A listing's public id is `${scope}/${slug}`
-- where scope = the publisher's handle. Columns are nullable-with-default so
-- the migration is safe on existing rows (the production catalog is empty).

ALTER TABLE listings ADD COLUMN scope TEXT NOT NULL DEFAULT '';
ALTER TABLE listings ADD COLUMN slug TEXT NOT NULL DEFAULT '';

CREATE INDEX listings_scope_idx ON listings (scope, slug);
