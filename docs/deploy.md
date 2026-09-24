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

The takos / takosumi clients consume the store's [current TCS 2.0 read API](./SPEC-v2.md)
directly (CORS-open), so users browse and install Capsules from inside those
apps. The [TCS 1.0 contract](./SPEC.md) remains only as the v1 compatibility
contract for the explicit `/tcs/v1` adapter. The store's own site is mainly for
browsing its catalog and registering (publishing) listings.

## Operator release

Do not register this repository as an installable Store listing until it owns a
real OpenTofu module. Official releases run from this owning repository:

```bash
export TAKOSUMI_STORE_WRANGLER_CONFIG=/path/to/operator-realized-wrangler.toml
export TAKOSUMI_STORE_PUBLIC_ORIGIN=https://store-staging.example.net
export TAKOSUMI_STORE_WORKER_CONFIG_SHA256=<sha256-of-realized-wrangler-config>
export TAKOSUMI_STORE_EXPECTED_WORKER=<exact-realized-worker-name>
export TAKOSUMI_STORE_EXPECTED_DATABASE_ID=<exact-realized-database-id>
bun run deploy -- takosumi-store-worker
```

The entrypoint derives the Worker target from the realized Wrangler config; it
does not accept a second `--name` target. The three target-fence variables must
match the realized config digest, Worker name, and D1 database ID exactly.
`TAKOSUMI_STORE_PUBLIC_ORIGIN` must be an HTTPS origin and must equal
`[vars].APP_URL` in that config. After publication it probes
`/tcs/v2/server-info` and `/tcs/v2/listings?limit=1`, requiring JSON, TCS 2.0,
and an exact `server.baseUrl` match. A failed readback is indeterminate: do not
retry blindly; inspect the recorded previous version.

The dry run writes one executable `index.js` under a private output directory;
publication replays those exact bytes with Wrangler `--no-bundle` and rechecks
the bundle and static-asset-tree digests immediately before and after publish.

### Applying the TCS 2.0 schema migration

The checked-in forward migration suffix (currently including
`0009_v2_git_identity.sql`) is an irreversible D1 state transition. It has one
owning command and no raw Wrangler fallback:

```bash
export TAKOSUMI_STORE_SCHEMA_DATABASE_ID=<exact-realized-database-id>
export TAKOSUMI_STORE_SCHEMA_DATABASE_NAME=<exact-realized-database-name>
export TAKOSUMI_STORE_SCHEMA_REVIEW_COMMIT=<reviewed-git-commit>
export TAKOSUMI_STORE_SCHEMA_REVIEWER=<independent-reviewer-identity>
export TAKOSUMI_STORE_SCHEMA_REVIEW_SHA256=<sha256-of-canonical-pending-manifest>
export TAKOSUMI_STORE_SCHEMA_CONFIG_SHA256=<sha256-of-realized-wrangler-config>
export TAKOSUMI_STORE_RELEASE_STATE_DIR=/private/path/outside/all-repositories
bun run deploy -- takosumi-store-schema-current
```

Before mutation this surface runs `bun run check`, verifies the exact reviewed
commit/config/database identity, performs a read-only canonical URL collision
audit, and writes a mode-0600 schema/data snapshot outside every repository.
The surface reads the remote `d1_migrations` ledger and requires it to be an
exact prefix of this repository's sorted migration files. It derives the
non-empty pending suffix, hashes each pending filename/byte length/SHA-256 into
the reviewed manifest, and applies only that suffix from a private migration
tree. This also works when the realized config lives outside the repository.
After the forward migrations it verifies the complete ledger, v2
column/indexes, populated `git_identity`, and full listings/reports readback.
If `report_rate_limits` already exists, its rows are reread and compared exactly.
The subsequent Worker surface owns health and public v2 endpoint readback. It
never retries blindly and never down-migrates; an interrupted operation is
reconciled forward from the private snapshot.

Run `takosumi-store-schema-current` to completion before
`takosumi-store-worker`. The Worker preflight rereads the remote D1 migration
ledger and refuses to publish until it contains every checked-in migration. In
staging this deliberately permits a short schema-first cutover gap where the
old Worker remains served while the schema becomes current; publishing the new
Worker before that readback would let it query an unready schema.

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
