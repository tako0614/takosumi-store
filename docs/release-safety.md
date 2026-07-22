# Official Store release safety

The official `https://store.takosumi.com` deployment is the
`takosumi-store` release-safety surface. It is a database-coupled Worker with
one sealed build promoted through long-lived staging and a fresh isolated
replica before production. This is separate from self-host deployment.

## Authority and operator files

The public repository owns the reproducible builder and fixed adapters. The
ecosystem release controller owns authorization and is the only supported
parent process. Real account IDs, resource IDs, config values, API tokens,
snapshot data, and evidence stay outside this repository.

The operator root contains:

```text
store/release-policy.production.json
store/wrangler.production.toml
store/wrangler.staging.toml
```

The two config paths are safe relative `configPath` values in the policy. The
builder and every adapter hash the exact bytes. The policy fixes production to
Worker `takosumi-store` at `https://store.takosumi.com`, binds D1 `DB`, R2
`ICONS`, KV `KV`, static assets `ASSETS`, runtime flags, exact variable and
secret binding names, the custom domain, and the canonical
`/tcs/v1/listings/tako/takos` canary.

Cloudflare credentials are accepted only through absolute `0600` files:

```text
TAKOSUMI_RELEASE_ACCOUNT_ID_FILE
TAKOSUMI_RELEASE_API_TOKEN_FILE
TAKOSUMI_RELEASE_STAGING_ACCOUNT_ID_FILE
TAKOSUMI_RELEASE_STAGING_API_TOKEN_FILE
TAKOSUMI_RELEASE_REPLICA_ACCOUNT_ID_FILE
TAKOSUMI_RELEASE_REPLICA_API_TOKEN_FILE
TAKOSUMI_RELEASE_REPLICA_SOURCE_ACCOUNT_ID_FILE
TAKOSUMI_RELEASE_REPLICA_SOURCE_API_TOKEN_FILE
TAKOSUMI_RELEASE_REPLICA_SNAPSHOT_KEY_FILE
TAKOSUMI_RELEASE_REPLICA_WORKERS_SUBDOMAIN_FILE
```

The source pair is a dedicated production **read-only** credential used only by
`prepare-input`; the ordinary replica pair can mutate only the isolated replica
resources. The snapshot key is exactly 32 bytes and the Workers subdomain file
contains only the account subdomain label needed to derive the fresh replica
origin. Every file is absolute, operator-owned, `0600`, outside Git worktrees,
and outside the retained evidence directory. Raw Cloudflare credential
variables are rejected by the fixed adapters.

## One-time staging bootstrap

The canonical staging target is created once, before the normal release
envelope exists, through a separate controller authority. The public owner
entrypoint is fixed to
`scripts/store-staging-bootstrap-fixed-adapter.ts`; direct Wrangler deployment
and arbitrary command/argument injection are not supported. The operator policy
fixes exactly these non-production identities:

```text
Worker: takosumi-store-staging
origin/custom domain: https://store-staging.takosumi.com
D1: takosumi-store-staging-db
KV: takosumi-store-staging-kv
R2: takosumi-store-staging-icons
```

The lifecycle is
`plan -> preflight-provision-no-write -> provision -> attest -> adopt`.
The preflight repeats every exact Cloudflare readback, compiles the exact
bootstrap Worker with `wrangler versions upload --dry-run`, and exercises the
read-only Wrangler Versions API through the sealed Node entrypoint. It must
finish before a signed bootstrap source tag is cut. Before the first
Cloudflare mutation, provision writes create-only intents for all five
resources. A lost create response is recovered only when one exact-name owner
is found; zero or multiple matches become fail-closed `presence-unknown`
evidence. Version bindings, 100% traffic, the exact custom-domain owner, and
all storage IDs are read back before inventory is accepted. Generated staging
Wrangler and release-policy bytes remain in the external `0700/0600` evidence
directory until the operator copies their exact bytes to the private config
repository.

`adopt` binds those config/policy digests and permanently revokes bootstrap
cleanup authority. Before adoption or a first normal candidate only,
`cleanup-plan -> destroy` may delete the exact retained bootstrap inventory.
`quarantine` instead removes the custom domain and disables workers.dev while
retaining Worker/D1/KV/R2 for investigation. Production credential variables,
production target fallback, placeholder resource IDs, and reusing production
names are rejected for every bootstrap action.

## Build once

The release commit must be clean canonical `main`, pushed to `origin/main`,
and be the peeled commit of a pushed, signed, annotated `v0.1.12` tag.

```bash
bun run release:candidate -- \
  --evidence-directory /absolute/operator/evidence/store-0.1.12 \
  --operator-root /absolute/operator/root
```

The builder runs the SPA and Worker builds twice and rejects byte drift. It
stores the prebuilt Worker, complete static assets, migrations `0001` through
`0006`, CycloneDX SBOM, provenance, candidate, and manifest as `0600` files in
an external `0700` directory. The promotion digest order is Worker, assets,
migrations. Staging, replica, and production use those same bytes; only the
environment config digest and target fingerprint differ.

Before any remote mutation, adapters recompute the complete artifact filesystem
inventory, all file and component-set digests, SBOM/provenance digests, and the
aggregate artifact digest. They also verify the actual Bun executable/version,
`bun.lock`, Wrangler bundled entrypoint, package metadata, and version against
the candidate. The full installed `node_modules` runtime is also sealed as an
ordered path/type/mode/content/symlink tree and recomputed before Wrangler is
executed and again after its version probe. Optional or transitive packages
therefore cannot be replaced beneath a valid entrypoint digest; manifest text
alone is never toolchain evidence.

## Fixed staging and production

The release controller invokes only these owner-local entrypoints:

```text
scripts/store-release-staging-safety-adapter.ts
scripts/store-release-safety-adapter.ts
scripts/store-release-replica-fixed-adapter.ts
```

Each adapter requires a controller-only marker, calls controller child
verification, and re-verifies source/tag/tree/adapter/policy/config/artifact
authority. Direct invocation fails before mutation.

Staging and production then:

1. read and retain the exact pre-deploy head plus a pre-mutation intent;
2. apply D1 migrations forward and prove the six-row lineage with no pending
   migrations;
3. upload the sealed Worker and static assets without rebuilding;
4. reject missing or extra D1/R2/KV/Assets/var/secret bindings;
5. re-read and fence the deployment head before promoting only the new Version
   at 100%;
6. read back the exact Version and deployment;
7. read the Cloudflare custom-domain association before and after promotion and
   prove the exact hostname remains owned by the exact Worker service;
8. prove health, readiness, TCS ServerInfo, canonical listing, same-origin
   digest-addressed `/icons/<sha256>` bytes, exact read and preflight CORS,
   hashed SPA asset, SPA fallback, and JSON API 404 fallback;
9. retain a create-only attestation tied to the operation journal.

The operation journal advances atomically through `intent-recorded`,
`schema-applied`, `upload-intent-recorded`, `version-uploaded`, `deployed`, and
`verified`. The upload intent seals the complete pre-upload Version ID set. A
lost upload response is recovered only when exactly one new Version has the
release ID/tag annotations and exact candidate bindings; zero or multiple
candidates fail closed. A failure after D1 apply retains forward-repair
identity. Only the same source, artifact, target, and pre-deploy head can
resume; an already deployed exact Version is read back instead of redeployed.
D1 is never automatically down-migrated.

## Fresh replica

The replica adapter exposes only:

```text
prepare-input -> plan -> provision -> rehearse -> attest
                                      \-> cleanup-plan -> destroy | quarantine
```

`prepare-input` first verifies that the realized production Wrangler config is
the exact candidate config/policy/target authority. It then performs one fixed,
read-only `SELECT` for the canonical public `tako/takos` listing and reads only
its declared icon from the exact production R2 bucket or the allowlisted public
GitHub raw source. The query and production R2 read use the same already
validated config bytes through a private `0700` temporary directory and `0400`
Wrangler config. That directory is removed in `finally` and is never retained
as evidence, so replacing the operator config between validation and Wrangler
execution cannot redirect either read. The source row/reference digests and the sanitized output
row/reference digests are distinct provenance fields. The exact row, generated
SQL, icon type/bytes, production identities, PII, and credential patterns are
scanned before encryption. Only AES-256-GCM ciphertext, digest-only source
provenance, and controller input evidence are retained; plaintext is never
retained.

Its config and encrypted/anonymized snapshot bundle are absolute `0600` file
references:

```text
TAKOSUMI_RELEASE_REPLICA_RUNTIME_CONFIG_FILE
TAKOSUMI_RELEASE_REPLICA_SANITIZED_SNAPSHOT_FILE
TAKOSUMI_RELEASE_REPLICA_SNAPSHOT_KEY_FILE
```

Before remote mutation, the adapter retains intent records for the fresh D1,
KV, R2, and Worker. Names contain the replica ID, targets cannot overlap
production, and `productionFallback` is always false. The snapshot bundle
contains digest-bound SQL plus the bounded icon bytes referenced by its
canonical listing. It is scanned for production target identities and
credential-like literals, email/IP/JWT/cookie-like values, and any mutation
outside the public `listings` table. Icon declarations must match PNG, JPEG, or
WebP signatures or a fail-closed safe-SVG profile. Decoded icon bytes (including
otherwise inert SVG text and binary image metadata) and the exact allowed icon
metadata are subject to the same credential and PII scan. A retry consumes and
authenticates retained ciphertext/provenance before any production read. If the
process stopped after ciphertext retention, the digest-only provenance and
input evidence are reconstructed from that authenticated bundle without a
second production query; a partial or conflicting retained set fails closed.

Initial Worker publication has its own monotonic operation journal with the
pre-upload Version set, release annotations, exact bindings, and deployment
head. Cleanup can recover an uploaded-only Version after a lost response and
delete it only after exact ownership readback. A fully provisioned retry returns
the exact retained inventory after live readback; partial progress requires
cleanup, and a terminal replica identity is never reused.

Provisioning restores only that local sanitized bundle, uploads the same sealed
Worker/assets, and proves the controller's four fixed replica checks. The
`rehearse` action verifies the exclusive 100%-traffic Version immediately
before deleting the exact isolated Worker, proves D1/KV/R2 catalog and icon
bytes survived, and forward-repairs with the same sealed candidate and empty
pre-deploy head. Foreign or additional Worker Versions block both failure
injection and cleanup. The attestation binds the exact initial/repaired
inventories, scanner proof, failure rehearsal, and data evidence. A lost create
response is retained as `presence-unknown`, and a non-terminal progress record
blocks re-provisioning until quarantine. A destroyed or quarantined replica ID
is terminal and cannot be provisioned again. Cleanup uses the unique replica-bound
names and exact retained IDs; KV is discovered by exact title and only a single
exact namespace ID can be deleted. Before provisioning, Worker, D1, KV, and R2
absence is digest-bound. The replica enables only its exact derived
`workers.dev` origin with preview URLs disabled. Cleanup requires the exact
sanitized R2 object set and bytes, removes objects before the bucket, resumes
retained progress monotonically, and proves post-delete absence for every
resource before terminal evidence. Every terminal step is retained.

Catalog seeding is intentionally absent. `scripts/load-official-listings.ts`
resolves mutable source metadata and is a separate content-authority concern,
not part of an immutable Worker release.
