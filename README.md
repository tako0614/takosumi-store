# Takosumi Store

A self-hostable store for **Takos Capsules** (installable apps / OpenTofu
modules), served by Takosumi. It exposes a **simple open HTTP/JSON read API**
(`spec/`, "TCS") that the takos / takosumi clients consume — users browse and
install Capsules from inside those apps rather than visiting the store site
directly. The store's own site is mainly for browsing its catalog and
registering (publishing) listings.

- **Read API:** `GET /tcs/v1/listings`, `GET /tcs/v1/listings/search`,
  `GET /tcs/v1/listings/{id}`, `GET /.well-known/tcs` (ServerInfo). Error
  envelope + keyset cursor pagination. CORS-open for cross-origin clients.
- **Publishing:** account-based registration ("Sign in with Takosumi Accounts"
  OIDC), moderation, and an install handoff that deep-links into a Takos
  `/install` flow.
- **Trust model:** server-selection trust. A Listing presents a repository; it
  does not pin or approve a release. The installer selects a tag/commit, reviews
  the OpenTofu plan, and applies its own policy checks. No publisher signatures
  exist in v1.

A Listing is a pointer to a Capsule: `{ git, path }` plus bilingual presentation
metadata and browse facets. It is deliberately not an install manifest, input
schema, output projection, or version lock. The wire schema is owned and
re-declared here; the Store does not import `takosumi-contract`.

## Stack

Cloudflare Worker + Hono backend + Solid/Vite SPA + Drizzle/D1, bun tooling.
The worker serves the SPA and the API on one origin.

## Commands

```bash
bun install
bun run check     # tsc --noEmit
bun test          # spec validators + store + read-api
bun run build     # vite build → ./dist
bun run dev       # wrangler dev (local D1)
```

## Status and versioning

- [x] M0 scaffold
- [x] M1 spec + read API + seed listings
- [x] M2 site UI + client-side aggregation
- [x] M3 accounts + publish + moderation
- [x] M4 install handoff
- [x] M5 package-as-Capsule (`outputs.tf`) + distribution seed

The next public source release is `v0.1.7`. Release tags are immutable: changed
bytes require a new version.

Docs: the open read spec is in [`docs/SPEC.md`](docs/SPEC.md); deploying (Capsule
or wrangler self-host) is in [`docs/deploy.md`](docs/deploy.md).

Official read deployment:

```text
https://store.takosumi.com
```

The official deployment is currently read-only unless Takosumi Accounts OIDC
settings and `SESSION_HASH_SALT` are provided. Realized production resource IDs,
hostnames, and OIDC settings are operator-owned and are not stored in this
repository.

## License

The Store implementation is licensed under AGPL-3.0-only. The portable TCS
contract in [`spec/`](spec/) is MIT licensed. Bundled font notices and the
SIL Open Font License are shipped in
[`web/public/THIRD_PARTY_NOTICES.txt`](web/public/THIRD_PARTY_NOTICES.txt) and
copied into every web build.
