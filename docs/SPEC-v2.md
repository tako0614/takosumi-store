# Takosumi Capsule Store (TCS) 2.0

TCS 2.0 is an open, read-only discovery contract for Store
implementations. A Store advertises repositories and presentation metadata; it
does not select, install, execute, or configure a module.

Any third-party Store may implement this contract without Takosumi Accounts or
the official Store UI. Implementers own their publisher and moderation policy;
those policies must not add install authority to the v2 wire response.

The machine-readable contract lives in [`spec/v2/index.ts`](../spec/v2/index.ts).
Source parser fixtures are in
[`spec/fixtures/listing-v2.ts`](../spec/fixtures/listing-v2.ts), and the
conformance tests are in `test/listing-v2-source-contract.test.ts` and
`test/read-api-v2.test.ts`.

## Listing shape

The canonical source is exactly one field:

```json
{ "source": { "git": "https://github.com/example/app" } }
```

`git` is a credential-free HTTPS URL. Query strings, fragments, embedded
credentials, percent-encoding, Unicode hosts/paths, and IPv6 authorities are
rejected; empty, `.` and `..` path segments are rejected; a trailing slash and
a trailing `.git` are normalized away.
The canonical URL is the v2 de-duplication key. A v2 `Listing` may carry:

- `id`, `scope`, `slug`, and `suggestedName` for presentation and stable links;
- localized `name`, `description`, and `badge` text;
- an optional HTTPS `iconUrl`;
- optional generic `category` and `tags` presentation facets;
- optional publisher attribution and server-local curation badges; and
- `createdAt` / `updatedAt` timestamps.

Provider, kind, surface, module path, ref, resolved commit, inputs,
`InstallConfig`, output policy, and credentials are not TCS 2.0 fields. A
Store may retain old values internally for v1 compatibility, but must not
return them from v2 or use them as install authority. Category and tags are
display facets only; tag predicates are intentionally not part of v2 reads.

The Store never fetches, validates, proxies, persists, or returns
`.well-known/takosumi.json`. Installer-owned source-snapshot metadata is a
separate Takosumi contract and is out of scope for TCS.

## Read endpoints

All endpoints are unauthenticated JSON GETs and carry the same CORS behavior as
v1 (`Access-Control-Allow-Origin: *`). Errors use the TCS error envelope and
malformed cursors/queries return `400 invalid_argument`.

- `GET /tcs/v2/server-info` — v2 server info (`spec.version: "2.0"`).
- `GET /tcs/v2/listings` — keyset-paginated listings.
- `GET /tcs/v2/listings/search?q=...` — reserved; the official server returns
  `501 not_implemented` until an indexed search contract exists. A client must
  not assume that search is available from v2 server-info.
- `GET /tcs/v2/listings/{scope}/{slug}` — listing detail.
- `GET /tcs/v2/listings/{scope}/{slug}/readme` — optional repository-root
  README presentation detail.

`GET /.well-known/tcs` remains the explicit v1 compatibility document. Its
additive `spec.versions` field advertises `1.0` and `2.0`; clients that need
the canonical v2 shape use `/tcs/v2/server-info` and the `/tcs/v2` routes.

Pagination uses the opaque `{ items, nextCursor? }` shape and updated/created
keyset ordering. v2 intentionally does not expose v1's execution-looking kind,
provider, surface, or name-sort fields. The bounded list filters are
`category` and `scope`; they are independent query modes and must not be
combined. A server returns `400 invalid_argument` for that combination.

## Ambiguous legacy rows

The Store migration materializes `listings.git_identity` with the same strict
ASCII-DNS authority, decimal-port, safe-path-segment, host-case,
trailing-slash, and terminal-`.git` normalization as the v2 URL parser. An
audit table with a unique constraint makes SQLite refuse the migration when
old rows contain duplicate canonical Git URLs or an invalid source. The v2
query path is indexed by visibility, optional category/scope, and each sort
key; unbounded search/tag predicates are not part of the v2 contract.

## Publisher handoff

The v2 publisher form and API accept `{ source: { git } }`; they do not ask for
or emit an executable path. The browser install handoff contains only `git` and
the suggested display name. Existing `/publish/listings` and `/tcs/v1` routes
remain explicit legacy adapters so old clients can migrate without a silent
schema change.
