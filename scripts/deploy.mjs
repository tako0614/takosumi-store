#!/usr/bin/env bun

// This repository owns the Store deploy entrypoint. Provider commands below
// are deliberately private implementation details of these selected surfaces;
// operators should not copy them into a second release path.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  assertPrivateStateDirectory,
  assetTreeDigest,
  canonicalCollisionAuditSql,
  migrationConfigSource,
  migrationLedgerReadbackSql,
  migrationManifest,
  requireMigrationPrefix,
  parseRealizedConfig,
  realizedOrigin,
  requireEnv,
  schemaReadbackSql,
  tableDataReadbackSql,
  v2IndexReadbackSql,
  verifySchemaMigrationProjection,
  sha256,
} from "./deploy-runtime.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_GATE = "bun run check";
const CONFIG_ENV = "TAKOSUMI_STORE_WRANGLER_CONFIG";
const WRANGLER = resolve(repo, "node_modules/.bin/wrangler");

const W = { surface: "takosumi-store-worker" };
const L = { surface: "takosumi-store-official-listings" };
const S = { surface: "takosumi-store-schema-current" };

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: W.surface,
      target: "cloudflare-worker:operator-realized-config",
      covers: ["wrangler.toml", "wrangler.local.toml"],
      requiresScripts: ["check"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: [
        CONFIG_ENV,
        "TAKOSUMI_STORE_PUBLIC_ORIGIN",
        "TAKOSUMI_STORE_WORKER_CONFIG_SHA256",
        "TAKOSUMI_STORE_EXPECTED_WORKER",
        "TAKOSUMI_STORE_EXPECTED_DATABASE_ID",
      ],
      triggers: [],
      obligations: {
        provenance: `refuses a dirty worktree, requires exact TAKOSUMI_STORE_WORKER_CONFIG_SHA256, TAKOSUMI_STORE_EXPECTED_WORKER, and TAKOSUMI_STORE_EXPECTED_DATABASE_ID fences, requires the remote D1 ledger to equal every checked-in migration before publication, runs ${OWNER_GATE}, and builds exactly one executable index.js through Wrangler's dry-run bundler for --no-bundle replay; the Worker name and public origin come from the operator's ${CONFIG_ENV} and TAKOSUMI_STORE_PUBLIC_ORIGIN, and template values are rejected`,
        "post-conditions":
          "reads the exact v2 server-info and v2 listings routes at the HTTPS TAKOSUMI_STORE_PUBLIC_ORIGIN, requiring JSON, spec 2.0, and server.baseUrl equal to that origin",
        reversal:
          "reads the active Worker Version through the same realized Wrangler config before publish and records it; restore that version through Wrangler using the same --config path",
        "failure-handling":
          "prints provider diagnostics, distinguishes pre-publication from post-publication failure, and never retries blindly; a failed v2 readback names the recorded previous version for operator reconciliation",
      },
    },
    {
      surface: L.surface,
      target: "cloudflare-d1:takosumi-store-db:official-listings",
      covers: [
        "scripts/load-official-listings.ts",
        "scripts/official-listing-source.ts",
      ],
      requiresScripts: ["check"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: [
        CONFIG_ENV,
        "TAKOSUMI_STORE_OFFICIAL_DATABASE_ID",
        "TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_COMMIT",
        "TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_SHA256",
        "TAKOSUMI_STORE_RELEASE_STATE_DIR",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          "requires a clean main exactly equal to origin/main, runs bun run check, renders the manifest-only SQL twice, and requires TAKOSUMI_STORE_OFFICIAL_DATABASE_ID, TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_COMMIT, TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_SHA256, and TAKOSUMI_STORE_RELEASE_STATE_DIR to match the independently reviewed target, commit, digest, and private state directory",
        "post-conditions":
          "reads every official listing through https://store.takosumi.com and compares the public projection with the reviewed manifest",
        reversal:
          "captures the exact pre-mutation official rows and writes mode-0600 rollback SQL in TAKOSUMI_STORE_RELEASE_STATE_DIR before changing D1",
        "failure-handling":
          "refuses target or digest drift before mutation; after mutation starts, it never retries or auto-rolls back and prints the exact snapshot and rollback paths for reconciliation",
        "independent-review":
          "the exact Git commit and candidate SQL SHA-256 must be supplied after a reviewer inspects the source, generated SQL, and public expectations",
      },
    },
    {
      surface: S.surface,
      target: "cloudflare-d1:operator-realized-config:schema-current",
      covers: ["migrations", "src/backend/db/schema.ts"],
      requiresScripts: ["check"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: [
        CONFIG_ENV,
        "TAKOSUMI_STORE_PUBLIC_ORIGIN",
        "TAKOSUMI_STORE_SCHEMA_DATABASE_ID",
        "TAKOSUMI_STORE_SCHEMA_DATABASE_NAME",
        "TAKOSUMI_STORE_SCHEMA_REVIEW_COMMIT",
        "TAKOSUMI_STORE_SCHEMA_REVIEWER",
        "TAKOSUMI_STORE_SCHEMA_REVIEW_SHA256",
        "TAKOSUMI_STORE_SCHEMA_CONFIG_SHA256",
        "TAKOSUMI_STORE_RELEASE_STATE_DIR",
      ],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          "requires a clean commit exactly matching TAKOSUMI_STORE_SCHEMA_REVIEW_COMMIT, named reviewer TAKOSUMI_STORE_SCHEMA_REVIEWER, exact pending-migration manifest SHA-256 in TAKOSUMI_STORE_SCHEMA_REVIEW_SHA256, realized-config SHA-256 in TAKOSUMI_STORE_SCHEMA_CONFIG_SHA256, and exact D1 identity in TAKOSUMI_STORE_SCHEMA_DATABASE_ID/TAKOSUMI_STORE_SCHEMA_DATABASE_NAME before applying through this entrypoint",
        "post-conditions":
          "runs a read-only canonical collision audit before mutation, then verifies the complete D1 migration ledger, git_identity, every v2 schema/index, full listings/reports row readback, existing report_rate_limits row preservation, 0007/0008 field transforms against the private snapshot, and a private post-readback snapshot",
        reversal:
          "writes a private mode-0600 schema/data snapshot in TAKOSUMI_STORE_RELEASE_STATE_DIR outside the repository before the forward migration; there is no down migration, and any repair is forward-only",
        "failure-handling":
          "does not retry or down-migrate after mutation begins; it reports the private snapshot and authoritative readback needed for forward reconciliation",
        "pre-mutation-proof":
          "runs bun run check, validates exact commit/config/database identity, and blocks on any non-empty read-only canonical collision audit before invoking Wrangler",
        "independent-review":
          "the migration digest, exact reviewed commit, realized config digest, and database identity are supplied by an independent reviewer after inspecting migration SQL and the readback contract",
      },
    },
  ],
  otherProviderScripts: [
    {
      script: "deploy:self-host",
      why: "A wrapper a self-hoster runs against infrastructure they own. It refuses official identities and is not an official release authority.",
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const requested = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith("--"));
if (
  requested.length !== 1 ||
  ![W.surface, L.surface, S.surface].includes(requested[0])
) {
  process.stderr.write(
    `usage: bun run deploy -- <${W.surface}|${L.surface}|${S.surface}>\n`,
  );
  process.exit(1);
}

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, [...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: options.env,
    });
  } catch (error) {
    if (options.allowFailure) throw error;
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
    die(`${command} ${args.join(" ")} failed`);
  }
}

function git(...args) {
  return run("git", args).trim();
}

function configPathFromEnv() {
  const configured = process.env[CONFIG_ENV]?.trim();
  if (!configured)
    die(
      `${CONFIG_ENV} is required; use an operator-realized config outside the template`,
    );
  const path = resolve(configured);
  if (!existsSync(path))
    die(`${CONFIG_ENV} points to a missing config: ${path}`);
  if (lstatSync(path).isSymbolicLink())
    die(`${CONFIG_ENV} must point to a regular config file`);
  return path;
}

function parseD1Rows(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    die("Wrangler D1 readback was not strict JSON");
  }
  if (
    !Array.isArray(body) ||
    body.length !== 1 ||
    body[0]?.success !== true ||
    !Array.isArray(body[0]?.results)
  ) {
    die("Wrangler D1 readback returned an unexpected result envelope");
  }
  return body[0].results;
}

function d1Read(databaseName, configPath, command) {
  return parseD1Rows(
    run(WRANGLER, [
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--config",
      configPath,
      "--command",
      command,
      "--json",
    ]),
  );
}

function checkedInMigrationNames() {
  const migrationDirectory = join(repo, "migrations");
  const names = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const tracked = git("ls-files", "migrations")
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice("migrations/".length))
    .sort();
  if (names.join("\n") !== tracked.join("\n")) {
    die(
      "the checked-in migrations directory does not match the working migration directory",
    );
  }
  return { directory: migrationDirectory, names };
}

function assertCompleteMigrationLedger(localNames, rows) {
  const actual = rows.map((row) => String(row.name ?? ""));
  if (actual.join("\n") !== localNames.join("\n")) {
    die(
      "the remote D1 migration ledger is not the complete checked-in prefix; schema-current must run before the Worker",
      [`expected ${localNames.join(", ")}`, `observed ${actual.join(", ")}`],
    );
  }
}

function assertWorkerTargetFence(source, realized) {
  const configDigest = requireEnv(
    process.env,
    "TAKOSUMI_STORE_WORKER_CONFIG_SHA256",
  ).toLowerCase();
  if (
    !/^[a-f0-9]{64}$/u.test(configDigest) ||
    configDigest !== sha256(source)
  ) {
    die(`TAKOSUMI_STORE_WORKER_CONFIG_SHA256 does not match ${CONFIG_ENV}`);
  }
  const expectedWorker = requireEnv(
    process.env,
    "TAKOSUMI_STORE_EXPECTED_WORKER",
  );
  if (expectedWorker !== realized.workerName) {
    die(
      `TAKOSUMI_STORE_EXPECTED_WORKER ${expectedWorker} does not match the realized Worker ${realized.workerName}`,
    );
  }
  const expectedDatabaseId = requireEnv(
    process.env,
    "TAKOSUMI_STORE_EXPECTED_DATABASE_ID",
  );
  if (expectedDatabaseId !== realized.databaseId) {
    die(
      `TAKOSUMI_STORE_EXPECTED_DATABASE_ID does not match the realized DB binding`,
    );
  }
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if ((lstatSync(path).mode & 0o077) !== 0)
    die(`${path} was not created with mode 0600`);
}

function selectWorkerBundle(outDir) {
  const candidates = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "index.js")
        candidates.push(path);
    }
  };
  visit(outDir);
  if (candidates.length !== 1) {
    throw new Error(
      `Wrangler dry-run must produce exactly one executable index.js; found ${candidates.length}`,
    );
  }
  return candidates[0];
}

async function probeV2(origin) {
  async function get(path) {
    const url = `${origin}${path}`;
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${url} did not return JSON`);
    }
    return { url, body };
  }
  const health = await get("/healthz");
  const expectedVersion = JSON.parse(
    readFileSync(join(repo, "package.json"), "utf8"),
  ).version;
  if (
    health.body?.status !== "ok" ||
    health.body?.version !== expectedVersion
  ) {
    throw new Error("healthz did not report the repository release version");
  }
  const info = await get("/tcs/v2/server-info");
  if (info.body?.spec?.version !== "2.0")
    throw new Error("v2 server-info did not advertise spec 2.0");
  if (
    typeof info.body?.server?.baseUrl !== "string" ||
    realizedOrigin(info.body.server.baseUrl) !== origin
  ) {
    throw new Error(
      "v2 server-info baseUrl does not match the realized public origin",
    );
  }
  const listings = await get("/tcs/v2/listings?limit=1");
  if (!Array.isArray(listings.body?.items))
    throw new Error("v2 listings did not return an items array");
  return { health: health.url, serverInfo: info.url, listings: listings.url };
}

function validateConfig(configPath) {
  const source = readFileSync(configPath, "utf8");
  const values = source
    .split("\n")
    .filter((line) => !/^\s*(?:#|\/\/)/u.test(line))
    .join("\n");
  const placeholder = /(?:example\.com|REPLACE_[A-Z_]+|<[a-z-]+>|xxxxx)/iu.exec(
    values,
  );
  if (placeholder)
    die(
      `${CONFIG_ENV} still contains a template placeholder ${JSON.stringify(placeholder[0])}`,
    );
  try {
    const realized = parseRealizedConfig(source);
    const origin = realizedOrigin(
      requireEnv(process.env, "TAKOSUMI_STORE_PUBLIC_ORIGIN"),
    );
    if (origin !== realized.configOrigin)
      die(
        "TAKOSUMI_STORE_PUBLIC_ORIGIN does not equal vars.APP_URL in the realized config",
      );
    if (
      realized.routeHostnames.length === 0 ||
      !realized.routeHostnames.includes(new URL(origin).hostname)
    ) {
      die(
        "the realized Wrangler routes do not include the public origin hostname",
      );
    }
    return { source, ...realized, origin };
  } catch (error) {
    die(error.message);
  }
}

async function deployWorker() {
  const configPath = configPathFromEnv();
  const realized = validateConfig(configPath);
  const workerEntry = join(repo, "src/backend/index.ts");
  const assetsDirectory = join(repo, "dist");
  if (!existsSync(workerEntry) || !existsSync(assetsDirectory)) {
    die("the Worker entrypoint and built assets must exist before bundling");
  }
  const dirty = git("status", "--porcelain");
  if (dirty)
    die(
      "the worktree is not clean; the published bundle must belong to one commit",
      dirty.split("\n").slice(0, 20),
    );
  assertWorkerTargetFence(realized.source, realized);
  const { directory: migrationDirectory, names: migrationNames } =
    checkedInMigrationNames();
  const workerLedgerViewDir = mkdtempSync(
    join(tmpdir(), "takosumi-store-worker-migration-view-"),
  );
  chmodSync(workerLedgerViewDir, 0o700);
  const workerLedgerConfig = join(workerLedgerViewDir, "wrangler.toml");
  writePrivate(
    workerLedgerConfig,
    migrationConfigSource(realized.source, migrationDirectory),
  );
  const workerLedger = d1Read(
    realized.databaseName,
    workerLedgerConfig,
    migrationLedgerReadbackSql(realized.migrationsTable),
  );
  assertCompleteMigrationLedger(migrationNames, workerLedger);
  process.stdout.write(
    "remote D1 migration ledger: complete checked-in prefix\n",
  );
  const commit = git("rev-parse", "HEAD");
  process.stdout.write(
    `source ${commit} (${git("rev-parse", "--abbrev-ref", "HEAD")})\n`,
  );
  process.stdout.write(`\n==> ${OWNER_GATE}\n`);
  run("bun", ["run", "check"], { stdio: "inherit" });

  const outDir = mkdtempSync(join(tmpdir(), "takosumi-store-deploy-"));
  chmodSync(outDir, 0o700);
  const assetsDigest = assetTreeDigest(assetsDirectory);
  process.stdout.write(`\n==> wrangler deploy --dry-run --outdir ${outDir}\n`);
  let dryRun;
  try {
    dryRun = run(
      WRANGLER,
      [
        "deploy",
        workerEntry,
        "--assets",
        assetsDirectory,
        "--dry-run",
        "--outdir",
        outDir,
        "--config",
        configPath,
      ],
      { allowFailure: true },
    );
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
    die("the candidate bundle could not be built; target is untouched");
  }
  void dryRun;
  let bundlePath;
  try {
    bundlePath = selectWorkerBundle(outDir);
  } catch (error) {
    die(error.message);
  }
  const bundleDigest = sha256(readFileSync(bundlePath));
  process.stdout.write(
    `candidate ${bundlePath} sha256 ${bundleDigest.slice(0, 16)}\nassets sha256 ${assetsDigest.slice(0, 16)}\n`,
  );

  let previous;
  try {
    const deployment = JSON.parse(
      run(WRANGLER, [
        "deployments",
        "status",
        "--json",
        "--config",
        configPath,
      ]),
    );
    if (
      !Array.isArray(deployment?.versions) ||
      deployment.versions.length !== 1 ||
      deployment.versions[0]?.percentage !== 100 ||
      typeof deployment.versions[0]?.version_id !== "string"
    ) {
      throw new Error(
        "active target is not serving one authoritative Worker Version at 100 percent",
      );
    }
    previous = deployment.versions[0].version_id;
  } catch (error) {
    die(
      `cannot read the active Worker deployment through ${CONFIG_ENV}: ${error.message}`,
    );
  }
  process.stdout.write(`previous version ${previous}\n`);
  const rollbackCommand = `${WRANGLER} versions deploy ${previous}@100% --config ${configPath}`;
  const prePublishBundleDigest = sha256(readFileSync(bundlePath));
  const prePublishAssetsDigest = assetTreeDigest(assetsDirectory);
  if (
    prePublishBundleDigest !== bundleDigest ||
    prePublishAssetsDigest !== assetsDigest
  ) {
    die(
      "the dry-run bundle or asset tree changed before publication; target is untouched",
    );
  }
  process.stdout.write(`\n==> publishing ${realized.workerName}\n`);
  try {
    process.stdout.write(
      run(WRANGLER, [
        "deploy",
        bundlePath,
        "--no-bundle",
        "--assets",
        assetsDirectory,
        "--config",
        configPath,
      ]),
    );
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
    die(
      `publication failed after target preparation; reconcile version ${previous} before retrying`,
    );
  }

  let post;
  let currentVersion;
  const postPublishBundleDigest = sha256(readFileSync(bundlePath));
  const postPublishAssetsDigest = assetTreeDigest(assetsDirectory);
  if (
    postPublishBundleDigest !== prePublishBundleDigest ||
    postPublishAssetsDigest !== prePublishAssetsDigest
  ) {
    die(
      "the published bundle or asset tree changed during publication; reconcile the target",
    );
  }
  try {
    const deployment = JSON.parse(
      run(WRANGLER, [
        "deployments",
        "status",
        "--json",
        "--config",
        configPath,
      ]),
    );
    if (
      !Array.isArray(deployment?.versions) ||
      deployment.versions.length !== 1 ||
      deployment.versions[0]?.percentage !== 100 ||
      typeof deployment.versions[0]?.version_id !== "string"
    ) {
      throw new Error(
        "post-publication target is not serving one Worker Version at 100 percent",
      );
    }
    currentVersion = deployment.versions[0].version_id;
    if (currentVersion === previous)
      throw new Error("the active Worker Version did not change");
    post = await probeV2(realized.origin);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.stdout.write(
      `${JSON.stringify({ kind: "takos.deploy-result@v1", surface: W.surface, target: `cloudflare-worker:${realized.workerName}`, commit, bundleDigest, assetsDigest, previousVersion: previous, currentVersion, rollbackCommand, postConditions: "FAILED", status: "INDETERMINATE" }, null, 2)}\n`,
    );
    die(
      `v2 post-conditions failed; do not retry blindly; reconcile version ${previous} using the same ${CONFIG_ENV}. If rollback is authorized, use: ${rollbackCommand}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ kind: "takos.deploy-result@v1", surface: W.surface, target: `cloudflare-worker:${realized.workerName}`, commit, bundleDigest, assetsDigest, previousVersion: previous, currentVersion, rollbackCommand, postConditions: "PASSED", status: "PUBLISHED", post }, null, 2)}\n`,
  );
}

function assertReviewIdentity(configSource, realized) {
  const dirty = git("status", "--porcelain");
  if (dirty)
    die(
      "the worktree is not clean; schema migration requires one reviewed commit",
      dirty.split("\n").slice(0, 20),
    );
  const commit = git("rev-parse", "HEAD");
  const reviewedCommit = requireEnv(
    process.env,
    "TAKOSUMI_STORE_SCHEMA_REVIEW_COMMIT",
  ).toLowerCase();
  if (reviewedCommit !== commit)
    die(
      `reviewed schema commit ${reviewedCommit} does not match source ${commit}`,
    );
  const reviewer = requireEnv(process.env, "TAKOSUMI_STORE_SCHEMA_REVIEWER");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._@+:-]{0,127}$/u.test(reviewer))
    die("TAKOSUMI_STORE_SCHEMA_REVIEWER must be a bounded printable identity");
  const configDigest = requireEnv(
    process.env,
    "TAKOSUMI_STORE_SCHEMA_CONFIG_SHA256",
  ).toLowerCase();
  if (
    !/^[a-f0-9]{64}$/u.test(configDigest) ||
    configDigest !== sha256(configSource)
  )
    die(`TAKOSUMI_STORE_SCHEMA_CONFIG_SHA256 does not match ${CONFIG_ENV}`);
  const databaseId = requireEnv(
    process.env,
    "TAKOSUMI_STORE_SCHEMA_DATABASE_ID",
  );
  const databaseName = requireEnv(
    process.env,
    "TAKOSUMI_STORE_SCHEMA_DATABASE_NAME",
  );
  if (
    databaseId !== realized.databaseId ||
    databaseName !== realized.databaseName
  )
    die("reviewed D1 identity does not match the realized config DB binding");
  return { commit, databaseId, databaseName, reviewer };
}

async function migrateSchema() {
  const configPath = configPathFromEnv();
  const realized = validateConfig(configPath);
  const configSource = readFileSync(configPath, "utf8");
  const identity = assertReviewIdentity(configSource, realized);
  process.stdout.write(
    `source ${identity.commit}; reviewer ${identity.reviewer}; D1 ${identity.databaseName} (${identity.databaseId})\n\n==> ${OWNER_GATE}\n`,
  );
  run("bun", ["run", "check"], { stdio: "inherit" });

  const migrationDirectory = join(repo, "migrations");
  const migrationNames = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const trackedMigrationNames = git("ls-files", "migrations")
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice("migrations/".length))
    .sort();
  if (migrationNames.join("\n") !== trackedMigrationNames.join("\n")) {
    die(
      "the checked-in migrations directory does not match the working migration directory",
    );
  }

  // The realized config lives outside this repository, so Wrangler would look
  // for its relative migrations_dir next to that config. A private config view
  // points only the read-only ledger query at the checked-in directory.
  const repoViewDir = mkdtempSync(
    join(tmpdir(), "takosumi-store-migration-view-"),
  );
  chmodSync(repoViewDir, 0o700);
  const repoViewConfig = join(repoViewDir, "wrangler.toml");
  writePrivate(
    repoViewConfig,
    migrationConfigSource(configSource, migrationDirectory),
  );
  const ledgerRows = d1Read(
    identity.databaseName,
    repoViewConfig,
    migrationLedgerReadbackSql(realized.migrationsTable),
  );
  let pendingNames;
  try {
    pendingNames = requireMigrationPrefix(migrationNames, ledgerRows);
  } catch (error) {
    die(`migration ledger preflight failed: ${error.message}`);
  }
  const pendingEntries = pendingNames.map((name) => ({
    name,
    bytes: readFileSync(join(migrationDirectory, name), "utf8"),
  }));
  const pendingManifest = migrationManifest(pendingEntries);
  const reviewedManifestDigest = requireEnv(
    process.env,
    "TAKOSUMI_STORE_SCHEMA_REVIEW_SHA256",
  ).toLowerCase();
  if (
    !/^[a-f0-9]{64}$/u.test(reviewedManifestDigest) ||
    reviewedManifestDigest !== sha256(pendingManifest)
  ) {
    die(
      "TAKOSUMI_STORE_SCHEMA_REVIEW_SHA256 does not match the canonical pending migration manifest (name, byte length, and SHA-256)",
    );
  }
  process.stdout.write(
    `migration ledger preflight: pending ${pendingNames.join(", ")}\nmanifest sha256 ${reviewedManifestDigest}\n`,
  );

  const migrationTree = mkdtempSync(
    join(tmpdir(), "takosumi-store-pending-migrations-"),
  );
  chmodSync(migrationTree, 0o700);
  for (const entry of pendingEntries) {
    writePrivate(join(migrationTree, entry.name), entry.bytes);
  }
  const migrationViewDir = mkdtempSync(
    join(tmpdir(), "takosumi-store-migration-config-"),
  );
  chmodSync(migrationViewDir, 0o700);
  const migrationConfigPath = join(migrationViewDir, "wrangler.toml");
  writePrivate(
    migrationConfigPath,
    migrationConfigSource(configSource, migrationTree),
  );

  const collisions = d1Read(
    identity.databaseName,
    migrationConfigPath,
    canonicalCollisionAuditSql(),
  );
  if (collisions.length > 0)
    die(
      "canonical collision/invalid URL audit returned rows; D1 was not changed",
      collisions.slice(0, 20).map((row) => JSON.stringify(row)),
    );
  process.stdout.write("canonical collision audit: no rows\n");

  const stateRoot = assertPrivateStateDirectory(
    requireEnv(process.env, "TAKOSUMI_STORE_RELEASE_STATE_DIR"),
    repo,
  );
  const operationDir = mkdtempSync(
    join(stateRoot, `schema-current-${identity.commit.slice(0, 12)}-`),
  );
  chmodSync(operationDir, 0o700);
  const snapshotPath = join(operationDir, "before.json");
  const afterSnapshotPath = join(operationDir, "after.json");
  const schemaBefore = d1Read(
    identity.databaseName,
    migrationConfigPath,
    schemaReadbackSql(),
  );
  const hasTable = (name) =>
    schemaBefore.some((row) => row.type === "table" && row.name === name);
  const snapshot = {
    kind: "takosumi.store.schema-current-snapshot/v1",
    sourceCommit: identity.commit,
    reviewer: identity.reviewer,
    pendingMigrations: pendingNames,
    pendingManifestSha256: reviewedManifestDigest,
    pendingManifest,
    configSha256: sha256(configSource),
    databaseId: identity.databaseId,
    databaseName: identity.databaseName,
    ledger: ledgerRows,
    schema: schemaBefore,
    listings: hasTable("listings")
      ? d1Read(
          identity.databaseName,
          migrationConfigPath,
          tableDataReadbackSql("listings"),
        )
      : null,
    reports: hasTable("reports")
      ? d1Read(
          identity.databaseName,
          migrationConfigPath,
          tableDataReadbackSql("reports"),
        )
      : null,
    reportRateLimits: hasTable("report_rate_limits")
      ? d1Read(
          identity.databaseName,
          migrationConfigPath,
          tableDataReadbackSql("report_rate_limits"),
        )
      : null,
  };
  writePrivate(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`private pre-mutation snapshot ${snapshotPath}\n`);

  let touched = false;
  try {
    touched = true;
    run(
      WRANGLER,
      [
        "d1",
        "migrations",
        "apply",
        identity.databaseName,
        "--remote",
        "--config",
        migrationConfigPath,
      ],
      { stdio: "inherit" },
    );
    const schemaAfter = d1Read(
      identity.databaseName,
      migrationConfigPath,
      schemaReadbackSql(),
    );
    const schemaRows = d1Read(
      identity.databaseName,
      migrationConfigPath,
      v2IndexReadbackSql(),
    );
    const expected = [
      "listings_v2_git_identity_unique",
      "listings_v2_visible_updated_idx",
      "listings_v2_visible_created_idx",
      "listings_v2_visible_category_updated_idx",
      "listings_v2_visible_category_created_idx",
      "listings_v2_visible_scope_updated_idx",
      "listings_v2_visible_scope_created_idx",
    ];
    const names = schemaRows.map((row) => row.name).sort();
    if (names.join("\n") !== expected.sort().join("\n"))
      throw new Error("v2 schema/index readback did not match 0009");
    const afterListings = d1Read(
      identity.databaseName,
      migrationConfigPath,
      tableDataReadbackSql("listings"),
    );
    const afterReports = d1Read(
      identity.databaseName,
      migrationConfigPath,
      tableDataReadbackSql("reports"),
    );
    const afterReportRateLimits = schemaAfter.some(
      (row) => row.type === "table" && row.name === "report_rate_limits",
    )
      ? d1Read(
          identity.databaseName,
          migrationConfigPath,
          tableDataReadbackSql("report_rate_limits"),
        )
      : null;
    const projection = verifySchemaMigrationProjection({
      pendingMigrations: pendingNames,
      beforeListings: snapshot.listings,
      afterListings,
      beforeReports: snapshot.reports,
      afterReports,
      beforeReportRateLimits: snapshot.reportRateLimits,
      afterReportRateLimits,
    });
    const finalLedger = d1Read(
      identity.databaseName,
      migrationConfigPath,
      migrationLedgerReadbackSql(realized.migrationsTable),
    );
    if (
      finalLedger.map((row) => String(row.name ?? "")).join("\n") !==
      migrationNames.join("\n")
    ) {
      throw new Error(
        "migration ledger readback did not converge to every checked-in migration",
      );
    }
    const afterSnapshot = {
      kind: "takosumi.store.schema-current-post-snapshot/v1",
      sourceCommit: identity.commit,
      reviewer: identity.reviewer,
      pendingMigrations: pendingNames,
      pendingManifestSha256: reviewedManifestDigest,
      databaseId: identity.databaseId,
      databaseName: identity.databaseName,
      ledger: finalLedger,
      schema: schemaAfter,
      indexes: schemaRows,
      listings: afterListings,
      reports: afterReports,
      reportRateLimits: afterReportRateLimits,
      projection,
    };
    writePrivate(
      afterSnapshotPath,
      `${JSON.stringify(afterSnapshot, null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error.stack ?? error}\nDo not retry or down-migrate. Reconcile forward from ${snapshotPath}; post-readback is ${afterSnapshotPath} when present.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify({ kind: "takos.deploy-result@v1", surface: S.surface, target: `cloudflare-d1:${identity.databaseId}:schema-current`, commit: identity.commit, reviewer: identity.reviewer, pendingMigrations: pendingNames, pendingManifestSha256: reviewedManifestDigest, snapshotPath, afterSnapshotPath, postConditions: "PASSED", status: touched ? "PUBLISHED" : "FAILED_SAFE" }, null, 2)}\n`,
  );
}

if (requested[0] === L.surface) {
  execFileSync("bun", ["scripts/deploy-official-listings.ts"], {
    cwd: repo,
    stdio: "inherit",
  });
} else if (requested[0] === S.surface) {
  await migrateSchema();
} else {
  await deployWorker();
}
