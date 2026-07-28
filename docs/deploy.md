# Deploying Takosumi Store

The Store currently ships a guarded Cloudflare Worker deployment, not an
OpenTofu Capsule. There is no `outputs.tf`: claiming installability without a
module that provisions and deploys the real Worker artifact would create a
false-success install. Use the self-host flow below or the official Release
deploy path.

## Self-host with wrangler

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

The self-host wrapper refuses the official `store.takosumi.com` target. It also
rejects the canonical official custom-domain route and the public official D1,
KV, and R2 names. Cloudflare's
opaque resource IDs are not copied into this public repository; isolation for
those IDs is fail-closed through separate official account/token custody. The
official Store is deployed only through
[the official deploy path](./release-safety.md).

## Consuming the store

The takos / takosumi clients consume the store's [read API](./SPEC.md) directly
(CORS-open), so users browse and install Capsules from inside those apps. The
store's own site is mainly for browsing its catalog and registering (publishing)
listings.

## Operator release

Do not register this repository as an installable Store listing until it owns a
real OpenTofu module. Official releases run only from the sibling control
checkout:

```bash
bun run deploy
```

The fixed adapter owns staging/rehearsal setup, immutable artifact reuse,
target fencing, promotion, readback, and recovery. See
[release-safety.md](./release-safety.md). Do not invoke a Store release adapter
or Wrangler command for the official target directly.

## Official listing icon indexing

Repository presentation may name an absolute credential-free HTTPS icon or a
repository-root-relative path in `.well-known/tcs.json`. The official loader
resolves GitHub `HEAD` to an exact commit, reads the document and relative icon
from that commit, validates the bounded image bytes, uploads the
digest-addressed object to the Store `ICONS` R2 bucket, and writes only the
Store-owned HTTPS URL to the listing row.

Official listing registration and icon rehosting are authenticated mutable
content operations, not an immutable Worker release and not an operator-facing
fallback command. Their fixed content adapter owns the external realized
configuration, validates the exact source commit and bounded image bytes,
rehosts digest-addressed bytes, and writes the Store-owned URL only after
readback. If commit resolution, metadata fetch, path validation, content
validation, size limits, or R2 upload fails, it may omit `iconUrl`; it never
publishes the remote source URL as a fallback.
