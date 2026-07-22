# Deploying Takosumi Store

Two ways to run it: as a Capsule provisioned by a Takosumi control plane
(recommended), or self-hosted directly with wrangler.

## A. Install as a Capsule (via Takosumi)

`outputs.tf` makes this repo a plain OpenTofu Capsule. Takosumi provisions its
D1 (`DB`, with `migrations/`), R2 (`ICONS`), KV (`KV`), generated
`SESSION_HASH_SALT`, route, and optional public OIDC client. Takos is the
user-facing launcher and install experience; it does not own the control-plane
ledger or provision these resources. Without an accounts plane the Store still
runs read-only.

Distribution or featured-app placement is a separate Takos product decision;
this repository does not claim that the Store is preinstalled or featured.

## B. Self-host with wrangler

```bash
bun install
# Provision uniquely named self-host resources. Do not reuse any of the
# official Store identities. Then copy wrangler.toml outside the repository and
# replace every example value in that operator-owned configuration:
export STORE_WRANGLER_CONFIG=/path/to/takosumi-store.production.toml
bunx wrangler d1 create my-store-db
bunx wrangler kv namespace create my-store-kv
bunx wrangler r2 bucket create my-store-icons
bunx wrangler d1 migrations apply my-store-db \
  --config "$STORE_WRANGLER_CONFIG"                  # apply every migration in migrations/
# Build and deploy through the guarded self-host wrapper. The realized config
# must use a Worker name other than `takosumi-store` and a non-official origin.
bun run deploy:self-host -- \
  --i-understand-this-is-self-host \
  --config "$STORE_WRANGLER_CONFIG"
# optional: enable publishing
bunx wrangler secret put SESSION_HASH_SALT \
  --config "$STORE_WRANGLER_CONFIG"                 # openssl rand -hex 32
#   set TAKOSUMI_ACCOUNTS_ISSUER_URL + TAKOSUMI_ACCOUNTS_CLIENT_ID for OIDC login
#   (register redirect_uri <origin>/account/callback with the issuer)
```

`APP_URL` should be your non-official routed origin (used for
ServerInfo.baseUrl, OIDC redirect, and install-link host de-dup). The self-host
path must never use `store.takosumi.com`, the Worker name `takosumi-store`, or
the official backing-resource identities.

Publishing remains disabled unless `SESSION_HASH_SALT`,
`TAKOSUMI_ACCOUNTS_ISSUER_URL`, and `TAKOSUMI_ACCOUNTS_CLIENT_ID` are configured
for the deployment.

The wrapper refuses the official `store.takosumi.com` target and any invocation
under the ecosystem release controller. It also rejects the canonical official
custom-domain route and the public official D1, KV, and R2 names. Cloudflare's
opaque resource IDs are not copied into this public repository; isolation for
those IDs is fail-closed through separate official account/token custody. The
official Store is released only through
[the fixed release-safety flow](./release-safety.md).

## Consuming the store

The takos / takosumi clients consume the store's [read API](./SPEC.md) directly
(CORS-open), so users browse and install Capsules from inside those apps. The
store's own site is mainly for browsing its catalog and registering (publishing)
listings.

## Operator / release publication

The Store listing advertises only the repository and module path. Takosumi's
install/source flow owns the selected tag/commit and OpenTofu plan. Before
publishing this Store itself as an installable app:

1. Push this repo to its remote (`https://github.com/tako0614/takosumi-store.git`).
2. Run the public CI and release verification against the exact candidate SHA.
3. Create a signed annotated `v0.1.13` tag at that exact commit and push both the
   commit and tag. The candidate builder rejects lightweight, unsigned,
   unpushed, or differently peeled tags.
4. Register it as a submodule from the ecosystem root once the remote exists:
   `git submodule add https://github.com/tako0614/takosumi-store.git takosumi-store`.
5. Register the Store listing or distribution entry with the repository URL and
   module path only; do not copy release tags or commits into Store metadata.

The official staging target is not provisioned with these manual commands. Its
one-time, create-only bootstrap is a separate fixed controller flow documented
in [release-safety.md](./release-safety.md); after `adopt`, every deployment
uses the ordinary immutable staging/replica/production release envelope.

## Official listing icon indexing

Repository presentation may name an absolute credential-free HTTPS icon or a
repository-root-relative path in `.well-known/tcs.json`. The official loader
resolves GitHub `HEAD` to an exact commit, reads the document and relative icon
from that commit, validates the bounded image bytes, uploads the
digest-addressed object to the Store `ICONS` R2 bucket, and writes only the
Store-owned HTTPS URL to the listing row.

Run the upload and SQL generation together from an authenticated operator
checkout whose realized Wrangler configuration lives outside this repository:

```bash
TAKOSUMI_STORE_ICON_REHOST=remote \
  bun run scripts/load-official-listings.ts > /tmp/official.sql
bunx wrangler d1 execute takosumi-store-db \
  --remote --config "$STORE_WRANGLER_CONFIG" --file /tmp/official.sql
```

`TAKOSUMI_STORE_ICON_BUCKET`, `TAKOSUMI_STORE_PUBLIC_ORIGIN`, and
`TAKOSUMI_STORE_WRANGLER_CONFIG` override the deployment defaults. If commit
resolution, metadata fetch, path validation, content validation, size limits,
or R2 upload fails, the loader still emits the listing without `iconUrl`; it
never publishes the remote source URL as a fallback.
