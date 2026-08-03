# Store release safety

The Store owning repository is the release authority for its Worker and D1
schema. `takos-control` records cross-repository policy and checks contracts;
it is not a deploy adapter and does not own Store credentials or production
configuration. Self-host deployment is a separate authority.

## Public operator interface

The only official entrypoint is selected explicitly from this repository:

```bash
export TAKOSUMI_STORE_WRANGLER_CONFIG=/private/operator/store-staging.toml
export TAKOSUMI_STORE_PUBLIC_ORIGIN=https://store-staging.example.net
export TAKOSUMI_STORE_WORKER_CONFIG_SHA256=<sha256-of-realized-wrangler-config>
export TAKOSUMI_STORE_EXPECTED_WORKER=<exact-realized-worker-name>
export TAKOSUMI_STORE_EXPECTED_DATABASE_ID=<exact-realized-database-id>
bun run deploy -- takosumi-store-worker
```

The realized config supplies the Worker name, D1 binding, routes, and
environment. The public origin must be HTTPS and must equal `[vars].APP_URL`;
repository templates and placeholder values are rejected. Wrangler is always
called with that same `--config` path, including the active-version read and
the publish command. No second `--name` or raw provider command is an
operator-facing release path.

The Worker release is considered complete only after both exact v2 routes
respond with JSON:

- `GET <origin>/tcs/v2/server-info` advertises spec `2.0` and the exact origin
  in `server.baseUrl`;
- `GET <origin>/tcs/v2/listings?limit=1` returns an `items` array.

The entrypoint gates publication on a complete remote D1 migration ledger and
records the source commit, exact dry-run executable `index.js` bundle digest,
deterministic `dist` asset-tree digest, and previous Worker Version. The
publication command replays that bundle with `--no-bundle`; a post-publication
readback failure is indeterminate. Do not rerun or roll back from guessed
state; inspect the authoritative deployment list and use the recorded version
with the same realized config.

## Schema transition 0009

The checked-in forward migration suffix (including `0009_v2_git_identity.sql`)
is a separate irreversible surface:

```bash
bun run deploy -- takosumi-store-schema-current
```

The command requires exact reviewed commit, named reviewer, canonical pending
migration-manifest digest (filename, byte length, and SHA-256 per file),
realized-config digest, D1 database ID/name, public origin, and a private state
directory. It requires the remote migration ledger to be an exact prefix of
the checked-in files, then creates a mode-0600 private migration tree/config
and runs a read-only canonical URL collision/invalid-row audit before invoking
the pinned Wrangler binary. A mode-0600 snapshot of schema and listing identity
data is written outside every Git repository before mutation.

The forward migration is followed by authoritative D1 readback of the complete
ledger, `git_identity`, every v2 uniqueness/sort index, and full listings and
reports rows. Existing `report_rate_limits` rows are reread and compared
exactly. The subsequent Worker surface owns health and public v2 route
readback. Run this schema surface to completion before the Worker surface. In
staging, the old Worker may remain served during the intentional schema-first
cutover gap. There is no down migration or blind retry. If mutation may have
started, stop and reconcile forward using the private snapshot and live D1
readback.

## Separate authorities

- `bun run deploy:self-host` is only for operator-owned, non-official
  resources; its explicit config must remain outside this repository.
- Official listing synchronization is the separate
  `takosumi-store-official-listings` surface and has its own reviewed content
  snapshot.
- Credentials, realized Wrangler configs, release journals, and snapshots
  stay outside public repositories. A task, branch name, or green check does
  not grant production authority.
