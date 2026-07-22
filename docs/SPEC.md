# Takosumi Capsule Store (TCS) — open read API v1.0

TCS is a small HTTP/JSON contract: the read API the takos / takosumi clients
consume to browse and install Capsules from the Takosumi store. A client points
at the store's base URL and reads its listings; the API is documented openly so
any tool can consume it.

Authentication, who may publish, and moderation are the store's own concern and
are **not** part of this read contract. The reference implementation in this repo
adds account-based publishing (registration) on top.

- Content type: `application/json`. Spec version is advertised in ServerInfo.
- Errors: `{ "error": { "code", "message", "requestId", "details?" } }`. Read
  codes: `invalid_argument` (400), `not_found` (404), `not_implemented` (501),
  `resource_exhausted` (429), `internal_error` (500).
- Pagination: keyset. List responses are `{ "items": [...], "nextCursor"? }`.
  `cursor` is an opaque token; pass it back verbatim to get the next page. Max
  page size 100.

## Endpoints (all mandatory)

### `GET /.well-known/tcs` (alias `GET /tcs/v1/server-info`) → ServerInfo

```jsonc
{
  "spec": {
    "version": "1.0",
    "capabilities": [
      "search",
      "filter.category",
      "filter.kind",
      "filter.provider",
      "filter.surface",
      "sort.updated",
      "sort.created",
      "sort.name",
      "icons",
    ],
  },
  "server": {
    "name": "…",
    "software": { "name": "…", "version": "…" },
    "baseUrl": "https://store.example.com",
  },
  "listings": { "count": 42 },
  "categories": [{ "key": "social", "count": 3 }],
  "kinds": [{ "key": "worker", "count": 30 }],
  "providers": [{ "key": "cloudflare", "count": 38 }],
  "contact?": { "admin?": "…", "url?": "…" },
  "defaultLocale?": "ja",
}
```

`capabilities` lets a client branch on optional behaviors (e.g. skip a node that
omits `search`). The four endpoints themselves are required regardless.

### `GET /tcs/v1/listings` → `{ items: Listing[], nextCursor? }`

Query: `limit?`, `cursor?`, `category?`, `kind?`, `provider?`, `surface?`,
`sort?` (`updated` default | `created` | `name`), `locale?` (`ja` | `en`,
affects `sort=name` collation only). Invalid params → `400 invalid_argument`.

### `GET /tcs/v1/listings/search?q=<query>` → `{ items: Listing[], nextCursor? }`

Same params plus required `q`. Match scope/ranking is the server's choice. A
server that does not implement search omits `search` from `capabilities` and
returns `501 not_implemented`; clients skip it during aggregated search.

### `GET /tcs/v1/listings/{id}` → `Listing`

Unknown id → `404 not_found`.

## Listing

A Listing is a pointer to an installable Capsule (a plain OpenTofu/Terraform
module) plus presentation metadata. It is not a version lock, install manifest,
setup schema, or output projection contract.

```jsonc
{
  "id": "string", // server-local stable id
  "source": {
    "git": "https://…", // https, no embedded credentials
    "path": "string", // "" or "." for repo root
  },
  "kind": "worker | storage | site",
  "surface": "service | building_block | example",
  "provider": "cloudflare", // provider address namespace
  "category": "social", // store-local browse facet
  "suggestedName": "my-app",
  "name": { "ja": "…", "en": "…" },
  "description": { "ja": "…", "en": "…" },
  "badge": { "ja": "…", "en": "…" },
  "iconUrl?": "https://…",
  "publisher?": { "handle": "…", "displayName?": "…" }, // attribution only, NOT trust
  "badges?": ["official"], // server-local curation, NOT cross-server trust
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
}
```

`iconUrl`, when present in a published response, is an absolute,
credential-free HTTPS URL. A repository `.well-known/tcs.json` may instead
name a repository-root-relative icon path as indexing input. The Store resolves
that path at one exact source commit, validates and size-limits the image, and
re-hosts immutable digest-addressed bytes before publishing the listing. Any
resolution, fetch, type, byte-validation, or storage failure omits `iconUrl` and
does not block listing discovery or installation.

## Trust

Store trust is server-selection trust. A Listing says "this repository exists
and this store presents it this way"; it does not pin a commit or approve an
install. There are no publisher signatures in v1. `publisher` and `badges` are
presentation/curation — a client must NOT treat a third-party node's
self-declared `official` badge as a trust assertion. Trust flows from **which
servers you choose to query** and from the installer reviewing the Git source,
selected ref/tag/commit, OpenTofu plan, policy checks, and repository-owned
metadata.

## Install handoff

A Listing carries everything needed to build a Takos install deep-link:
`<takos-origin>/install?git=<git>&path=<path>&name=<suggestedName>`.
The link only pre-fills the visitor's own Takos add flow — nothing installs from
a URL. The target ref/tag/commit is selected in the Takosumi install/source flow,
not by the Store.

Install setup metadata, output projection, artifacts, screenshots, and
OpenTofu-specific UX belong to the repository and installer, not this Store
read API. Servers SHOULD reject top-level fields such as `inputs`,
`installExperience`, `outputAllowlist`, `variables`, `installConfigId`,
`commit`, `source.ref`, and `source.resolvedCommit`.
