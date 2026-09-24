# Takosumi Store

A self-hostable catalog for **Takos Capsules** (installable apps / OpenTofu
modules). It exposes a **simple open HTTP/JSON read API**
(`spec/`, "TCS") that the takos / takosumi clients consume — users browse and
install Capsules from inside those apps rather than visiting the store site
directly. The store's own site is mainly for browsing its catalog and
registering (publishing) listings.

## What it gives you

- **Read API:** TCS 2.0 is the canonical URL-only surface:
  `GET /tcs/v2/listings`,
  `GET /tcs/v2/listings/{scope}/{slug}`, and `GET /tcs/v2/server-info`.
  The v1 routes and `/.well-known/tcs` remain explicit read-only compatibility
  adapters. Responses use the TCS error envelope and keyset cursor
  pagination, with CORS open for cross-origin clients. See
  [docs/SPEC-v2.md](docs/SPEC-v2.md).
- **Publishing:** account-based registration ("Sign in with Takosumi Accounts"
  OIDC), moderation, and an install handoff that deep-links into a Takos
  `/install` flow.
- **Trust model:** server-selection trust. A Listing presents a repository; it
  does not pin or approve a release. The installer selects a tag/commit, reviews
  the OpenTofu plan, and applies its own policy checks. No publisher signatures
  exist in v1.

The canonical v2 Listing is a repository URL `{ source: { git } }` plus
bilingual presentation metadata and generic browse facets. It is deliberately
not an install manifest, input schema, output projection, or version lock. The
legacy v1 wire schema retains `{ git, path }` only for compatibility. The wire
schema is owned and re-declared here; the Store does not import
`takosumi-contract`.

Repository metadata has two separate boundaries:

- `.well-known/tcs.json` is optional Store indexing input for browse
  presentation such as a repository-relative icon. It cannot declare setup or
  execution behavior.
- `.well-known/takosumi.json` is an optional, installer-owned Takosumi install
  UX proposal. The Store does not read, validate, persist, return, merge, or
  override it. Takosumi may consume it from the selected immutable source
  snapshot; TCS 2.0 hands off only `{ git }` and a suggested name.

## How it is built

Cloudflare Worker + Hono backend + Solid/Vite SPA + Drizzle/D1, bun tooling.
The worker serves the SPA and the API on one origin.

## Getting started

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
- [x] M5 guarded self-host and official deploy path

Takosumi Store has its own semver stream. Release tags and published artifacts
are immutable: changed bytes require a new version. The official target is
deployed by this repository's own entrypoint:

```bash
bun run deploy
```

Docs: the canonical TCS 2.0 open read spec is in
[`docs/SPEC-v2.md`](docs/SPEC-v2.md); the v1 compatibility contract is in
[`docs/SPEC.md`](docs/SPEC.md); self-hosting is in [`docs/deploy.md`](docs/deploy.md).

This repository does not currently ship a deployable OpenTofu module. It must
therefore not be listed as an installable Capsule. The supported deployment
surface is the guarded Worker flow documented below; a future Capsule requires
real resource and artifact provisioning before an OpenTofu output is added.

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
