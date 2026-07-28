# Official Store release

The official `https://store.takosumi.com` deployment is a `state-change` deploy
surface owned by this repository: a database-coupled Worker with static assets,
D1, KV, and R2. The official deploy and a self-host deployment are separate
authorities.

## Public operator interface

Run official release operations from the sibling `takos-control` checkout:

```bash
bun run deploy
```

`prepare` is credentialless and does not mutate staging or production.
`status` is always read-only. Authenticated `promote` is the only supported
production-mutation entrypoint. Do not invoke Store adapters, provider
mutation commands, an operator-authored envelope, or a generic `--execute`
path directly. If the fixed adapter is unavailable, the surface fails closed;
there is no direct-provider fallback.

## Candidate and target authority

The repository owns the reproducible candidate builder and Store-specific
adapter implementation. The control repository owns release policy, candidate
identity, approval, target lease, journal protocol, and the runnable surface
catalog.

Non-secret realized account/resource IDs, Wrangler config, and redacted
evidence may live in the private `takosumi-private` operator repository; they
never enter a public product/control repository. Secret values and
credentials, canonical release journals, approval receipts, and snapshot
material remain outside every repository. Credentials are read only by the
fixed target adapter after promotion authorization and are never passed to
source builds.

During `prepare`, the fixed adapter:

- resolves one exact clean source ref and runs the repository's portable
  `bun run check`;
- builds the Worker and SPA twice without credentials and rejects byte drift;
- seals the Worker, complete static assets, migration set, toolchain,
  SBOM/provenance, release policy, realized-config digest, and target
  fingerprint into one candidate identity;
- verifies that official production/staging identities cannot overlap
  self-host or replica identities;
- determines whether the candidate is a compatible deployment or a state
  transition; and
- creates any required isolated rehearsal without granting it production
  authority.

Staging, rehearsal, and production consume the same sealed artifact bytes.
Nothing rebuilds between review and promotion.

## Promotion invariants

Before mutation, `promote` reacquires a target lease and rechecks the Release
ID, Candidate ID, source, policy version, approval, target fingerprint,
artifact closure, and current remote deployment head.

For a compatible deployment, the adapter:

1. records a durable pre-mutation intent;
2. applies only reviewed forward migrations;
3. uploads the sealed Worker and assets without rebuilding;
4. verifies exact D1, KV, R2, Assets, variable, secret-name, route, and domain
   bindings;
5. promotes only the new Worker Version at 100 percent traffic under CAS;
6. reads back the exact Version, deployment, custom-domain ownership, health,
   TCS API, icon bytes, CORS behavior, SPA asset, and fallback behavior; and
7. records success only after authoritative remote readback.

A candidate containing schema/data/topology/authority change is a state
transition. It additionally requires an independent reviewer, a fresh isolated
production-equivalent rehearsal using only encrypted/anonymized data, and a
forward-only repair plan. D1 is never automatically down-migrated.

The release is idempotent by Release ID. A retry may resume only the same
candidate, target, policy, and pre-mutation head. Concurrent promotion has one
lease/CAS winner.

## Failure and recovery

Inspect interrupted work with:

```bash
bun run deploy
```

- A failure proven to be before mutation becomes `FAILED_SAFE`.
- A known partial change requiring forward repair becomes
  `RECOVERY_REQUIRED`.
- A timeout or lost response after mutation may have started becomes
  `INDETERMINATE`.

`INDETERMINATE` freezes the Store surface until the fixed adapter reconciles
the authoritative remote state. Do not blindly rerun `promote`, deploy with
Wrangler, delete an uploaded Version, roll D1 backward, or guess which
resource belongs to the attempt. Cleanup/recovery authority is derived from
the retained operation journal plus exact live readback.

Replica resources are create-only, uniquely named by the rehearsal identity,
and never reuse official target names or credentials. Destroy/quarantine is
allowed only for resources whose creation receipt and current ownership both
match that rehearsal. A terminal replica identity is never reused.

## Separate boundaries

- Self-host deployment is documented in [`deploy.md`](deploy.md). It uses
  operator-owned non-official resources and is not an official Store release.
- Catalog listing registration and icon rehosting are mutable content
  operations, not part of the immutable Worker release. They require their own
  authenticated content authority and evidence.
- The Store is not an installable Capsule until it owns a real OpenTofu module
  that provisions and deploys the actual Worker artifact.

The component-local builder and adapters may retain lower-level implementation
and recovery commands, but those commands are private implementation details
behind the three-operation public interface above.
