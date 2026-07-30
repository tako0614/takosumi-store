#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { getTableColumns } from "drizzle-orm";
import { listingToInsert } from "../src/backend/db/listings-store.ts";
import { listings } from "../src/backend/db/schema.ts";
import type { Listing } from "../spec/listing.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const surface = "takosumi-store-official-listings";
const publicOrigin = "https://store.takosumi.com";
const currentIds = [
  "tako/yurucommu",
  "tako/takos-storage",
  "tako/takos-git",
  "tako/takos",
  "tako/takos-office",
  "tako/takos-computer",
] as const;
const retiredIds = ["tako/office", "tako/computer"] as const;
const snapshotIds = [...currentIds, ...retiredIds];
const officialNamespaceWhere =
  "(scope IS 'tako' OR substr(id, 1, 5) IS 'tako/')";

function die(message: string, details: readonly string[] = []): never {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const detail of details) process.stderr.write(`- ${detail}\n`);
  process.exit(1);
}

function run(
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdio?: "inherit";
  } = {},
): string {
  return execFileSync(command, [...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: options.env,
    stdio: options.stdio,
  }) as string;
}

function git(...args: string[]): string {
  return run("git", args).trim();
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) die(`${name} is required`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) die("snapshot contains a non-finite number");
    return String(value);
  }
  if (typeof value !== "string") {
    die(`snapshot contains unsupported ${typeof value} value`);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    die(`${path} must be a physical directory`);
  }
  chmodSync(path, 0o700);
  if ((lstatSync(path).mode & 0o077) !== 0) {
    die(`${path} must not be accessible to group or other users`);
  }
}

function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if ((lstatSync(path).mode & 0o077) !== 0) {
    die(`${path} was not created with mode 0600`);
  }
}

export function gitRepositoryAncestor(path: string): string | undefined {
  const requested = resolve(path);
  let existing = requested;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const physical = resolve(
    realpathSync(existing),
    relative(existing, requested),
  );
  let cursor = physical;
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

export function officialNamespaceRowIds(
  rows: readonly Readonly<Record<string, unknown>>[],
): string[] {
  const ids = rows.map((row) => {
    if (typeof row.id !== "string" || !row.id.startsWith("tako/")) {
      throw new Error("official namespace readback contained an invalid id");
    }
    return row.id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("official namespace readback contained duplicate ids");
  }
  return ids.sort();
}

function parseWranglerJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    die("Wrangler did not return strict JSON");
  }
}

function queryRows(raw: string): Record<string, unknown>[] {
  const body = parseWranglerJson(raw);
  if (!Array.isArray(body) || body.length !== 1) {
    die("D1 readback returned an unexpected result envelope");
  }
  const result = body[0];
  if (
    !result ||
    typeof result !== "object" ||
    (result as { success?: unknown }).success !== true ||
    !Array.isArray((result as { results?: unknown }).results)
  ) {
    die("D1 readback did not report one successful result");
  }
  return (result as { results: Record<string, unknown>[] }).results;
}

function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    die(`invalid database identifier ${value}`);
  }
  return value;
}

function sqlEquals(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): string {
  return columns
    .map((column) => `${sqlIdentifier(column)} IS ${sqlValue(row[column])}`)
    .join(" AND ");
}

const columnMeta = getTableColumns(listings);
function sqlColumn(field: string): string {
  const column = (columnMeta as Record<string, { name?: unknown }>)[field];
  if (!column || typeof column.name !== "string") {
    die(`unknown listing field ${field}`);
  }
  return sqlIdentifier(column.name);
}

const protectedFields = new Set([
  "id",
  "createdAt",
  "publisherId",
  "publisherHandle",
  "publisherDisplayName",
  "iconUrl",
  "badges",
  "status",
]);

export function casMutationSql(input: {
  readonly desired: readonly Listing[];
  readonly before: readonly Record<string, unknown>[];
}): string {
  const beforeById = new Map(
    input.before.map((row) => [String(row.id ?? ""), row] as const),
  );
  const out: string[] = [];
  for (const retiredId of retiredIds) {
    const before = beforeById.get(retiredId);
    if (!before) continue;
    const columns = Object.keys(before).map(sqlIdentifier);
    out.push(
      `DELETE FROM listings WHERE id IS ${sqlValue(retiredId)} AND ${sqlEquals(before, columns)};`,
    );
  }
  for (const listing of input.desired) {
    const row = listingToInsert(listing) as Record<string, unknown>;
    const before = beforeById.get(listing.id);
    const fields = Object.keys(row);
    if (!before) {
      const columns = fields.map(sqlColumn);
      out.push(
        `INSERT INTO listings (${columns.join(", ")}) SELECT ${fields
          .map((field) => sqlValue(row[field]))
          .join(
            ", ",
          )} WHERE NOT EXISTS (SELECT 1 FROM listings WHERE id IS ${sqlValue(listing.id)});`,
      );
      continue;
    }
    const mutable = fields.filter((field) => !protectedFields.has(field));
    const mutableColumns = mutable.map(sqlColumn);
    out.push(
      `UPDATE listings SET ${mutable
        .map(
          (field, index) => `${mutableColumns[index]}=${sqlValue(row[field])}`,
        )
        .join(
          ", ",
        )} WHERE id IS ${sqlValue(listing.id)} AND ${sqlEquals(before, mutableColumns)};`,
    );
  }
  return `${out.join("\n\n")}\n`;
}

export function rollbackSql(input: {
  readonly desired: readonly Listing[];
  readonly before: readonly Record<string, unknown>[];
}): string {
  const beforeById = new Map(
    input.before.map((row) => [String(row.id ?? ""), row] as const),
  );
  const desiredById = new Map(
    input.desired.map((listing) => [listing.id, listing] as const),
  );
  const out: string[] = [];
  for (const listing of input.desired) {
    const desired = listingToInsert(listing) as Record<string, unknown>;
    const before = beforeById.get(listing.id);
    const fields = Object.keys(desired);
    if (!before) {
      const columns = fields.map(sqlColumn);
      const desiredByColumn = Object.fromEntries(
        fields.map((field, index) => [columns[index], desired[field]]),
      );
      out.push(
        `DELETE FROM listings WHERE id IS ${sqlValue(listing.id)} AND ${sqlEquals(desiredByColumn, columns)};`,
      );
      continue;
    }
    const mutableFields = fields.filter((field) => !protectedFields.has(field));
    const mutableColumns = mutableFields.map(sqlColumn);
    const desiredByColumn = Object.fromEntries(
      mutableFields.map((field, index) => [
        mutableColumns[index],
        desired[field],
      ]),
    );
    out.push(
      `UPDATE listings SET ${mutableColumns
        .map((column) => `${column}=${sqlValue(before[column])}`)
        .join(
          ", ",
        )} WHERE id IS ${sqlValue(listing.id)} AND ${sqlEquals(desiredByColumn, mutableColumns)};`,
    );
  }
  for (const retiredId of retiredIds) {
    const before = beforeById.get(retiredId);
    if (!before || desiredById.has(retiredId)) continue;
    const columns = Object.keys(before).map(sqlIdentifier);
    out.push(
      `INSERT INTO listings (${columns.join(", ")}) SELECT ${columns
        .map((column) => sqlValue(before[column]))
        .join(
          ", ",
        )} WHERE NOT EXISTS (SELECT 1 FROM listings WHERE id IS ${sqlValue(retiredId)});`,
    );
  }
  return `${out.join("\n\n")}\n`;
}

function comparableListing(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    die("public listing readback was not an object");
  }
  const listing = value as Record<string, unknown>;
  const keys = [
    "id",
    "scope",
    "slug",
    "source",
    "kind",
    "surface",
    "provider",
    "category",
    "tags",
    "suggestedName",
    "name",
    "description",
    "badge",
    "badges",
    "iconUrl",
    "publisher",
    "createdAt",
    "updatedAt",
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, listing[key]]));
}

export function publicListingExpectation(
  wanted: Listing,
  after: Readonly<Record<string, unknown>>,
): Listing {
  const {
    badges: _manifestBadges,
    iconUrl: _manifestIcon,
    publisher: _manifestPublisher,
    createdAt: _manifestCreatedAt,
    ...manifestOwned
  } = wanted;
  const badges =
    after.badges === null || after.badges === undefined
      ? undefined
      : JSON.parse(String(after.badges));
  if (
    badges !== undefined &&
    (!Array.isArray(badges) ||
      badges.some((badge) => typeof badge !== "string"))
  ) {
    throw new Error("official listing badges are not a string array");
  }
  const iconUrl =
    after.icon_url === null || after.icon_url === undefined
      ? undefined
      : String(after.icon_url);
  const publisher =
    after.publisher_handle === null || after.publisher_handle === undefined
      ? undefined
      : {
          handle: String(after.publisher_handle),
          ...(after.publisher_display_name === null ||
          after.publisher_display_name === undefined
            ? {}
            : { displayName: String(after.publisher_display_name) }),
        };
  if (typeof after.created_at !== "string") {
    throw new Error("official listing created_at is not a string");
  }
  return {
    ...manifestOwned,
    ...(badges === undefined || badges.length === 0 ? {} : { badges }),
    ...(iconUrl === undefined ? {} : { iconUrl }),
    ...(publisher === undefined ? {} : { publisher }),
    createdAt: after.created_at,
  };
}

export function workerVersionD1BindingId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const binding = value as { id?: unknown; database_id?: unknown };
  const id = typeof binding.id === "string" ? binding.id : undefined;
  const databaseId =
    typeof binding.database_id === "string" ? binding.database_id : undefined;
  if (id && databaseId && id !== databaseId) return undefined;
  return databaseId ?? id;
}

async function main(): Promise<void> {
  const configPath = resolve(env("TAKOSUMI_STORE_WRANGLER_CONFIG"));
  const databaseId = env("TAKOSUMI_STORE_OFFICIAL_DATABASE_ID");
  const reviewedCommit = env(
    "TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_COMMIT",
  ).toLowerCase();
  const reviewedDigest = env(
    "TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_SHA256",
  ).toLowerCase();
  const stateRoot = resolve(env("TAKOSUMI_STORE_RELEASE_STATE_DIR"));
  if (!/^[a-f0-9]{64}$/u.test(reviewedDigest)) {
    die("TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_SHA256 must be a SHA-256");
  }
  if (!/^[a-f0-9]{40}$/u.test(reviewedCommit)) {
    die("TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_COMMIT must be a Git commit");
  }
  const stateRepository = gitRepositoryAncestor(stateRoot);
  if (stateRepository) {
    die(
      `TAKOSUMI_STORE_RELEASE_STATE_DIR must be outside every Git repository`,
      [`selected path is inside ${stateRepository}`],
    );
  }
  privateDirectory(stateRoot);
  const physicalStateRoot = realpathSync(stateRoot);
  const physicalStateRepository = gitRepositoryAncestor(physicalStateRoot);
  if (physicalStateRepository) {
    die(`TAKOSUMI_STORE_RELEASE_STATE_DIR resolves inside a Git repository`, [
      `selected path resolves inside ${physicalStateRepository}`,
    ]);
  }
  if (!existsSync(configPath)) die(`${configPath} does not exist`);
  const config = readFileSync(configPath, "utf8");
  if (
    !/\bname\s*=\s*"takosumi-store"/u.test(config) ||
    !/\bAPP_URL\s*=\s*"https:\/\/store\.takosumi\.com"/u.test(config) ||
    !/\bdatabase_name\s*=\s*"takosumi-store-db"/u.test(config) ||
    !config.includes(`database_id = "${databaseId}"`) ||
    !/\bpattern\s*=\s*"store\.takosumi\.com"/u.test(config)
  ) {
    die("realized config does not name the exact official production Store");
  }

  const dirty = git("status", "--porcelain");
  if (dirty) {
    die(
      "the worktree is not clean; official content must belong to one commit",
      dirty.split("\n").slice(0, 20),
    );
  }
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
    die("official content may only deploy from local main");
  }
  const commit = git("rev-parse", "HEAD");
  if (reviewedCommit !== commit) {
    die(`reviewed commit ${reviewedCommit} does not match source ${commit}`);
  }
  const remoteMain = git(
    "ls-remote",
    "--exit-code",
    "origin",
    "refs/heads/main",
  )
    .split(/\s+/u)[0]
    ?.trim();
  if (remoteMain !== commit) {
    die(`local main ${commit} is not the published origin/main ${remoteMain}`);
  }

  process.stdout.write(`source ${commit} (main)\n\n==> bun run check\n`);
  run("bun", ["run", "check"], { stdio: "inherit" });

  const manifestEnv = {
    ...process.env,
    TAKOSUMI_STORE_OFFICIAL_METADATA_MODE: "manifest-only",
    TAKOSUMI_STORE_ICON_REHOST: "",
    TAKOSUMI_STORE_OFFICIAL_LOCAL_REPO_ROOT: "",
  };
  const sqlA = run("bun", ["scripts/load-official-listings.ts"], {
    env: manifestEnv,
  });
  const sqlB = run("bun", ["scripts/load-official-listings.ts"], {
    env: manifestEnv,
  });
  if (sqlA !== sqlB) die("official listing SQL was not reproducible");
  const insertCount = (sqlA.match(/\bINSERT INTO listings\b/gu) ?? []).length;
  if (
    insertCount !== currentIds.length ||
    !sqlA.includes("'tako/yurucommu'") ||
    !sqlA.includes("'deploy/takoform'") ||
    !sqlA.includes("'takoform'")
  ) {
    die("official listing SQL does not contain the exact reviewed catalog");
  }
  const sqlDigest = sha256(sqlA);
  if (sqlDigest !== reviewedDigest) {
    die(
      `reviewed SQL digest ${reviewedDigest} does not match candidate ${sqlDigest}`,
    );
  }

  const expectedRaw = run(
    "bun",
    ["scripts/load-official-listings.ts", "--expected-json"],
    { env: manifestEnv },
  );
  const expected = JSON.parse(expectedRaw) as unknown;
  if (
    !Array.isArray(expected) ||
    expected.length !== currentIds.length ||
    new Set(
      expected.map((listing) =>
        listing &&
        typeof listing === "object" &&
        !Array.isArray(listing) &&
        typeof (listing as { id?: unknown }).id === "string"
          ? (listing as { id: string }).id
          : "",
      ),
    ).size !== currentIds.length ||
    [...currentIds].sort().join("\n") !==
      expected
        .map((listing) => (listing as { id: string }).id)
        .sort()
        .join("\n")
  ) {
    die("official listing expectation set is incomplete");
  }
  const desiredListings = expected as Listing[];

  const listed = parseWranglerJson(
    run("bunx", ["wrangler", "d1", "list", "--json", "--config", configPath]),
  );
  if (
    !Array.isArray(listed) ||
    !listed.some(
      (database) =>
        database &&
        typeof database === "object" &&
        (database as { uuid?: unknown }).uuid === databaseId &&
        (database as { name?: unknown }).name === "takosumi-store-db",
    )
  ) {
    die("Cloudflare account does not expose the expected production Store D1");
  }

  const deployment = parseWranglerJson(
    run("bunx", [
      "wrangler",
      "deployments",
      "status",
      "--name",
      "takosumi-store",
      "--config",
      configPath,
      "--json",
    ]),
  );
  if (
    !deployment ||
    typeof deployment !== "object" ||
    !Array.isArray((deployment as { versions?: unknown }).versions) ||
    (deployment as { versions: unknown[] }).versions.length !== 1
  ) {
    die("official Store has no single authoritative production Worker Version");
  }
  const productionVersion = (
    deployment as {
      id?: unknown;
      versions: readonly { version_id?: unknown; percentage?: unknown }[];
    }
  ).versions[0];
  if (
    typeof productionVersion?.version_id !== "string" ||
    productionVersion.percentage !== 100
  ) {
    die("official Store is not serving one Worker Version at 100 percent");
  }
  const version = parseWranglerJson(
    run("bunx", [
      "wrangler",
      "versions",
      "view",
      productionVersion.version_id,
      "--name",
      "takosumi-store",
      "--config",
      configPath,
      "--json",
    ]),
  );
  const bindings =
    version &&
    typeof version === "object" &&
    (version as { resources?: unknown }).resources &&
    typeof (version as { resources: unknown }).resources === "object" &&
    Array.isArray(
      (
        (version as { resources: { bindings?: unknown } }).resources as {
          bindings?: unknown;
        }
      ).bindings,
    )
      ? (
          (version as { resources: { bindings: unknown[] } }).resources as {
            bindings: unknown[];
          }
        ).bindings
      : [];
  const liveDbBindings = bindings.filter(
    (binding) =>
      binding &&
      typeof binding === "object" &&
      (binding as { type?: unknown }).type === "d1" &&
      (binding as { name?: unknown }).name === "DB",
  );
  if (
    liveDbBindings.length !== 1 ||
    workerVersionD1BindingId(liveDbBindings[0]) !== databaseId ||
    !bindings.some(
      (binding) =>
        binding &&
        typeof binding === "object" &&
        (binding as { type?: unknown }).type === "plain_text" &&
        (binding as { name?: unknown }).name === "APP_URL" &&
        (binding as { text?: unknown }).text === publicOrigin,
    )
  ) {
    die(
      "live official Store Worker is not bound to the selected D1 and origin",
    );
  }

  const operationDir = mkdtempSync(
    join(physicalStateRoot, `official-listings-${commit.slice(0, 12)}-`),
  );
  chmodSync(operationDir, 0o700);
  const sqlPath = join(operationDir, "candidate.sql");
  const mutationPath = join(operationDir, "mutation-cas.sql");
  const snapshotPath = join(operationDir, "before.json");
  const rollbackPath = join(operationDir, "rollback.sql");
  writePrivate(sqlPath, sqlA);

  const beforeRaw = run("bunx", [
    "wrangler",
    "d1",
    "execute",
    databaseId,
    "--remote",
    "--config",
    configPath,
    "--command",
    `SELECT * FROM listings WHERE ${officialNamespaceWhere} ORDER BY id`,
    "--json",
  ]);
  const beforeRows = queryRows(beforeRaw);
  const unexpectedBefore = officialNamespaceRowIds(beforeRows).filter(
    (id) => !snapshotIds.includes(id as never),
  );
  if (unexpectedBefore.length > 0) {
    die("official namespace contains unreviewed listings", unexpectedBefore);
  }
  writePrivate(
    snapshotPath,
    `${JSON.stringify(
      {
        kind: "takosumi.store.official-listings-snapshot/v1",
        sourceCommit: commit,
        candidateSha256: sqlDigest,
        databaseId,
        rows: beforeRows,
      },
      null,
      2,
    )}\n`,
  );
  const mutationSql = casMutationSql({
    desired: desiredListings,
    before: beforeRows,
  });
  writePrivate(mutationPath, mutationSql);
  writePrivate(
    rollbackPath,
    rollbackSql({ desired: desiredListings, before: beforeRows }),
  );

  process.stdout.write(
    `candidate sha256 ${sqlDigest}\n` +
      `CAS mutation sha256 ${sha256(mutationSql)}\n` +
      `pre-mutation snapshot ${snapshotPath}\n` +
      `rollback SQL ${rollbackPath}\n\n` +
      `==> synchronizing ${currentIds.length} official listings\n`,
  );

  let touched = false;
  try {
    touched = true;
    run(
      "bunx",
      [
        "wrangler",
        "d1",
        "execute",
        databaseId,
        "--remote",
        "--config",
        configPath,
        "--file",
        mutationPath,
        "--yes",
      ],
      { stdio: "inherit" },
    );

    const afterRaw = run("bunx", [
      "wrangler",
      "d1",
      "execute",
      databaseId,
      "--remote",
      "--config",
      configPath,
      "--command",
      `SELECT * FROM listings WHERE ${officialNamespaceWhere} ORDER BY id`,
      "--json",
    ]);
    const afterRows = queryRows(afterRaw);
    const afterIds = officialNamespaceRowIds(afterRows);
    const expectedAfterIds = [...currentIds].sort();
    if (afterIds.join("\n") !== expectedAfterIds.join("\n")) {
      throw new Error(
        `official namespace closure drifted: expected ${expectedAfterIds.join(", ")}, got ${afterIds.join(", ")}`,
      );
    }
    const beforeById = new Map(
      beforeRows.map((row) => [String(row.id ?? ""), row] as const),
    );
    const afterById = new Map(
      afterRows.map((row) => [String(row.id ?? ""), row] as const),
    );
    for (const retiredId of retiredIds) {
      if (afterById.has(retiredId)) {
        throw new Error(`${retiredId} was not retired`);
      }
    }
    for (const wanted of desiredListings) {
      const listing = wanted as { id?: unknown };
      if (
        typeof listing.id !== "string" ||
        !currentIds.includes(listing.id as never)
      ) {
        die("expected listing has an unknown id");
      }
      const before = beforeById.get(listing.id);
      const after = afterById.get(listing.id);
      if (!after)
        throw new Error(`${listing.id} is absent after synchronization`);
      const desiredRow = listingToInsert(wanted) as Record<string, unknown>;
      for (const [field, value] of Object.entries(desiredRow)) {
        const column = sqlColumn(field);
        const expectedValue =
          before && protectedFields.has(field) ? before[column] : value;
        if (after[column] !== expectedValue) {
          throw new Error(`${listing.id} database field ${column} drifted`);
        }
      }
      const response = await fetch(
        `${publicOrigin}/tcs/v1/listings/${listing.id}`,
        {
          headers: { accept: "application/json" },
          redirect: "error",
        },
      );
      const body = await response.json();
      if (after.status === "visible" && response.status !== 200) {
        throw new Error(`${listing.id} visible public readback failed`);
      }
      if (after.status !== "visible" && response.status !== 404) {
        throw new Error(
          `${listing.id} hidden public readback did not fail closed`,
        );
      }
      if (response.status === 200) {
        const publicWanted = publicListingExpectation(wanted, after);
        if (
          JSON.stringify(comparableListing(body)) !==
          JSON.stringify(comparableListing(publicWanted))
        ) {
          throw new Error(`${listing.id} public readback did not match`);
        }
      }
    }
    for (const retiredId of retiredIds) {
      const response = await fetch(
        `${publicOrigin}/tcs/v1/listings/${retiredId}`,
        {
          headers: { accept: "application/json" },
          redirect: "error",
        },
      );
      if (response.status !== 404) {
        throw new Error(`${retiredId} is still publicly visible`);
      }
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n` +
        `production may have changed. Do not retry blindly. Inspect ${snapshotPath}; ` +
        `the exact reversal is ${rollbackPath}.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        kind: "takos.deploy-result@v1",
        surface,
        target: `cloudflare-d1:${databaseId}:official-listings`,
        commit,
        candidateDigest: sqlDigest,
        snapshotPath,
        rollbackPath,
        postConditions: "PASSED",
        status: touched ? "PUBLISHED" : "FAILED_SAFE",
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  await main();
}
