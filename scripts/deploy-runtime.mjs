import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalTcsGitUrl } from "../spec/listing-source.ts";

/** Normalize the operator-owned public origin used by the deployed API. */
export function realizedOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("TAKOSUMI_STORE_PUBLIC_ORIGIN must be set");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("TAKOSUMI_STORE_PUBLIC_ORIGIN must be an absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("TAKOSUMI_STORE_PUBLIC_ORIGIN must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "TAKOSUMI_STORE_PUBLIC_ORIGIN must be an origin without credentials or a query",
    );
  }
  if (parsed.pathname !== "/") {
    throw new Error("TAKOSUMI_STORE_PUBLIC_ORIGIN must not contain a path");
  }
  if (/example\.com$/iu.test(parsed.hostname)) {
    throw new Error(
      "TAKOSUMI_STORE_PUBLIC_ORIGIN still contains the template hostname",
    );
  }
  return parsed.origin;
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/** Parse and validate only the values needed by the deploy entrypoint. */
export function parseRealizedConfig(source) {
  let parsed;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    throw new Error(
      `realized wrangler config is not valid TOML: ${error.message}`,
    );
  }
  const config = objectRecord(parsed);
  const workerName = typeof config.name === "string" ? config.name.trim() : "";
  if (!workerName || !/^[a-z][a-z0-9-]{1,62}$/u.test(workerName)) {
    throw new Error(
      "realized wrangler config must declare one valid Worker name",
    );
  }
  const vars = objectRecord(config.vars);
  const configOrigin = realizedOrigin(String(vars.APP_URL ?? ""));
  const databases = Array.isArray(config.d1_databases)
    ? config.d1_databases.filter((entry) => entry && typeof entry === "object")
    : [];
  const db = databases.find((entry) => entry.binding === "DB");
  if (!db || typeof db.database_name !== "string" || !db.database_name.trim()) {
    throw new Error("realized wrangler config must declare the DB D1 binding");
  }
  if (typeof db.database_id !== "string" || !db.database_id.trim()) {
    throw new Error("realized wrangler config must declare the DB database_id");
  }
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const routeHostnames = routes.flatMap((route) => {
    const pattern =
      route && typeof route === "object" && typeof route.pattern === "string"
        ? route.pattern
        : "";
    try {
      return pattern
        ? [
            new URL(pattern.includes("://") ? pattern : `https://${pattern}`)
              .hostname,
          ]
        : [];
    } catch {
      return [];
    }
  });
  return {
    workerName,
    configOrigin,
    databaseName: db.database_name.trim(),
    databaseId: db.database_id.trim(),
    migrationsTable:
      typeof db.migrations_table === "string" && db.migrations_table.trim()
        ? db.migrations_table.trim()
        : "d1_migrations",
    routeHostnames,
  };
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assetTreeDigest(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`asset tree contains a symbolic link: ${path}`);
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`asset tree contains an unsupported entry: ${path}`);
    }
  };
  visit(resolve(root));
  files.sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const name = relative(resolve(root), path).replaceAll("\\", "/");
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function assertPrivateStateDirectory(path, repositoryRoot) {
  const requested = resolve(path);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const stat = lstatSync(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "TAKOSUMI_STORE_RELEASE_STATE_DIR must be a physical directory",
    );
  }
  chmodSync(requested, 0o700);
  const physical = realpathSync(requested);
  const gitRoot = (candidate) => {
    let cursor = candidate;
    while (true) {
      if (existsSync(resolve(cursor, ".git"))) return cursor;
      const parent = resolve(cursor, "..");
      if (parent === cursor) return undefined;
      cursor = parent;
    }
  };
  const found = gitRoot(physical);
  if (found) {
    throw new Error(
      `TAKOSUMI_STORE_RELEASE_STATE_DIR is inside Git repository ${found}`,
    );
  }
  void repositoryRoot;
  return physical;
}

/**
 * Read-only audit matching migrations/0009_v2_git_identity.sql's URL grammar.
 * It intentionally contains no DDL or DML: a non-empty result blocks before
 * Wrangler is allowed to apply the forward migration.
 */
export function canonicalCollisionAuditSql() {
  return String.raw`WITH RECURSIVE control_codes(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM control_codes WHERE n < 31
), c1_control_codes(n) AS (
  SELECT 127 UNION ALL SELECT n + 1 FROM c1_control_codes WHERE n < 159
), raw AS (
  SELECT id, trim(git) AS value FROM listings
), parts AS (
  SELECT id, value, substr(value, 9) AS tail,
    instr(substr(value, 9), '/') AS slash FROM raw
), split AS (
  SELECT id, value, substr(tail, 1, slash - 1) AS authority,
    substr(tail, slash) AS raw_path, slash FROM parts
), authority_parts AS (
  SELECT id, value, authority, raw_path, slash,
    CASE
      WHEN instr(authority, ':') = 0 THEN lower(authority)
      WHEN instr(substr(authority, instr(authority, ':') + 1), ':') > 0 THEN NULL
      WHEN substr(authority, 1, instr(authority, ':') - 1) = '' THEN NULL
      WHEN substr(authority, instr(authority, ':') + 1) = '' THEN NULL
      WHEN substr(authority, instr(authority, ':') + 1) GLOB '*[^0-9]*' THEN NULL
      WHEN CAST(substr(authority, instr(authority, ':') + 1) AS INTEGER) > 65535 THEN NULL
      WHEN CAST(substr(authority, instr(authority, ':') + 1) AS INTEGER) = 443
        THEN lower(substr(authority, 1, instr(authority, ':') - 1))
      ELSE lower(substr(authority, 1, instr(authority, ':') - 1)) || ':' ||
        CAST(CAST(substr(authority, instr(authority, ':') + 1) AS INTEGER) AS TEXT)
    END AS canonical_authority,
    CASE WHEN instr(authority, ':') = 0 THEN authority
      ELSE substr(authority, 1, instr(authority, ':') - 1) END AS host
  FROM split
), path_parts AS (
  SELECT id, value, authority, host, raw_path, slash, canonical_authority,
    rtrim(raw_path, '/') AS trimmed_path FROM authority_parts
), canonical_rows AS (
  SELECT id, value, authority, host, slash, canonical_authority,
    CASE WHEN lower(substr(trimmed_path, -4)) = '.git'
      THEN rtrim(substr(trimmed_path, 1, length(trimmed_path) - 4), '/')
      ELSE trimmed_path END AS canonical_path
  FROM path_parts
), evaluated AS (
  SELECT id, value,
    CASE
      WHEN lower(substr(value, 1, 8)) <> 'https://' OR instr(value, '\\') > 0
        OR instr(value, '?') > 0 OR instr(value, '#') > 0 OR instr(value, '@') > 0
        OR EXISTS (SELECT 1 FROM control_codes WHERE instr(value, char(n)) > 0)
        OR EXISTS (SELECT 1 FROM c1_control_codes WHERE instr(value, char(n)) > 0)
        OR slash = 0 OR authority = '' OR host = ''
        OR host GLOB '*[^A-Za-z0-9.-]*' OR instr(host, '..') > 0
        OR substr(host, 1, 1) IN ('.', '-') OR substr(host, -1, 1) IN ('.', '-')
        OR host GLOB '*.-*' OR host GLOB '*-.*' OR canonical_authority IS NULL
        OR canonical_path = '' OR canonical_path = '/'
        OR canonical_path GLOB '*[^/A-Za-z0-9._~-]*' OR instr(canonical_path, '//') > 0
        OR canonical_path IN ('/.', '/..') OR canonical_path LIKE '/./%'
        OR canonical_path LIKE '/../%' OR canonical_path LIKE '%/./%'
        OR canonical_path LIKE '%/../%' OR canonical_path LIKE '%/.'
        OR canonical_path LIKE '%/..'
      THEN NULL
      ELSE 'https://' || canonical_authority || canonical_path
    END AS git_identity
  FROM canonical_rows
), issues AS (
  SELECT id, value, 'invalid' AS issue, NULL AS git_identity
  FROM evaluated WHERE git_identity IS NULL
  UNION ALL
  SELECT id, value, 'collision' AS issue, git_identity
  FROM evaluated
  WHERE git_identity IN (
    SELECT git_identity FROM evaluated WHERE git_identity IS NOT NULL
    GROUP BY git_identity HAVING COUNT(*) > 1
  )
)
SELECT id, value, issue, git_identity FROM issues ORDER BY issue, id;`;
}

export function schemaReadbackSql() {
  return String.raw`SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger', 'view')
ORDER BY type, name;`;
}

export function v2IndexReadbackSql() {
  return String.raw`SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE name IN (
  'listings_v2_git_identity_unique',
  'listings_v2_visible_updated_idx',
  'listings_v2_visible_created_idx',
  'listings_v2_visible_category_updated_idx',
  'listings_v2_visible_category_created_idx',
  'listings_v2_visible_scope_updated_idx',
  'listings_v2_visible_scope_created_idx'
)
ORDER BY type, name;`;
}

export function schemaDataReadbackSql() {
  return "SELECT id, git FROM listings ORDER BY id;";
}

export function schemaIdentityReadbackSql() {
  return "SELECT id, git, git_identity FROM listings ORDER BY id;";
}

export function tableDataReadbackSql(table) {
  if (!/^[a-z][a-z0-9_]*$/u.test(table)) {
    throw new Error("snapshot table must be a simple SQL identifier");
  }
  return `SELECT * FROM "${table}" ORDER BY rowid;`;
}

export function migrationLedgerReadbackSql(table = "d1_migrations") {
  if (!/^[a-z][a-z0-9_]*$/u.test(table)) {
    throw new Error("migration ledger table must be a simple SQL identifier");
  }
  return `SELECT id, name, applied_at FROM "${table}" ORDER BY id;`;
}

/**
 * Wrangler resolves migrations_dir relative to an external config file. Keep
 * the reviewed config as the authority, but make a private one-shot view whose
 * only changed value points at this repository's checked-in migrations.
 */
export function migrationConfigSource(source, migrationsDirectory) {
  if (!/^(?:\/|[A-Za-z]:[\\/])/u.test(migrationsDirectory)) {
    throw new Error(
      "migration directory for the private config must be absolute",
    );
  }
  const matches = [
    ...source.matchAll(/^\s*migrations_dir\s*=\s*["'][^"']*["']\s*$/gmu),
  ];
  if (matches.length !== 1) {
    throw new Error(
      "realized config must contain exactly one DB migrations_dir",
    );
  }
  const replacement = `$1${JSON.stringify(migrationsDirectory)}`;
  const adjusted = source.replace(
    /(^\s*migrations_dir\s*=\s*)(["'][^"']*["'])/mu,
    replacement,
  );
  if (adjusted === source) {
    throw new Error(
      "realized config must declare migrations_dir for the DB binding",
    );
  }
  return adjusted;
}

export function requireMigrationPrefix(localNames, ledgerRows) {
  const local = [...localNames].sort();
  if (local.length === 0) {
    throw new Error("the checked-in migration directory is empty");
  }
  const applied = ledgerRows.map((row) => String(row?.name ?? ""));
  if (new Set(applied).size !== applied.length) {
    throw new Error("the remote migration ledger contains duplicate names");
  }
  if (applied.some((name) => !local.includes(name))) {
    throw new Error(
      "the remote migration ledger contains an unknown migration",
    );
  }
  if (applied.some((name, index) => name !== local[index])) {
    throw new Error("the remote migration ledger is not the checked-in prefix");
  }
  const pending = local.filter((name) => !applied.includes(name));
  if (pending.length === 0) {
    throw new Error(
      "the remote migration ledger already contains every checked-in migration",
    );
  }
  return pending;
}

export function migrationManifest(entries) {
  const migrations = entries.map(({ name, bytes }) => ({
    name,
    sha256: sha256(bytes),
    bytes: Buffer.byteLength(bytes),
  }));
  const value = { version: 1, migrations };
  return `${JSON.stringify(value)}\n`;
}

const RETIRED_LISTING_FIELDS = new Set([
  "ref",
  "resolved_commit",
  "inputs",
  "output_allowlist",
  "install_experience",
]);

function migratedListingExpected(before) {
  const expected = Object.fromEntries(
    Object.entries(before).filter(([key]) => !RETIRED_LISTING_FIELDS.has(key)),
  );
  const canonicalGit = canonicalTcsGitUrl(String(before.git ?? ""));
  if (!canonicalGit)
    throw new Error(`listing ${before.id} has an invalid Git URL`);
  expected.git = canonicalGit;
  expected.path =
    before.path === "."
      ? ""
      : String(before.path ?? "").replace(/^\/+|\/+$/gu, "");
  return expected;
}

export function verifySchemaMigrationProjection({
  pendingMigrations = [],
  beforeListings,
  afterListings,
  beforeReports,
  afterReports,
  beforeReportRateLimits = null,
  afterReportRateLimits = null,
}) {
  const pending = new Set(pendingMigrations);
  const authorityPending = pending.has("0007_listing_authority_boundary.sql");
  const moderationPending = pending.has("0008_moderation_limits.sql");
  const identityPending = pending.has("0009_v2_git_identity.sql");
  const compareRows = (
    beforeRows,
    afterRows,
    kind,
    expectedRow,
    allowedExtraKeys = [],
  ) => {
    if (beforeRows === null) return;
    if (afterRows === null)
      throw new Error(`${kind} table disappeared during migration`);
    if (beforeRows.length !== afterRows.length) {
      throw new Error(`${kind} row count changed during migration`);
    }
    const beforeIds = beforeRows.map((row) => String(row.id));
    const afterById = new Map(afterRows.map((row) => [String(row.id), row]));
    if (beforeIds.length !== new Set(beforeIds).size) {
      throw new Error(`${kind} snapshot contains duplicate row ids`);
    }
    if (afterRows.length !== afterById.size) {
      throw new Error(`${kind} readback contains duplicate row ids`);
    }
    for (const before of beforeRows) {
      const id = String(before.id);
      const after = afterById.get(id);
      if (!after)
        throw new Error(`${kind} row ${id} disappeared during migration`);
      const expected = expectedRow(before);
      for (const [key, value] of Object.entries(expected)) {
        if (after[key] !== value) {
          throw new Error(
            `${kind} row ${id} field ${key} changed unexpectedly`,
          );
        }
      }
      const expectedKeys = new Set(Object.keys(expected));
      const allowed = new Set(allowedExtraKeys);
      for (const key of Object.keys(after)) {
        if (!expectedKeys.has(key) && !allowed.has(key)) {
          throw new Error(`${kind} row ${id} has unexpected field ${key}`);
        }
      }
    }
    for (const after of afterRows) {
      if (!beforeIds.includes(String(after.id))) {
        throw new Error(`${kind} row ${after.id} was added during migration`);
      }
    }
  };
  const listingExpected = (before) => {
    if (authorityPending) return migratedListingExpected(before);
    const expected = { ...before };
    if (identityPending) {
      const canonicalGit = canonicalTcsGitUrl(String(before.git ?? ""));
      if (!canonicalGit)
        throw new Error(`listing ${before.id} has an invalid Git URL`);
      expected.git = canonicalGit;
    }
    return expected;
  };
  compareRows(
    beforeListings,
    afterListings,
    "listing",
    listingExpected,
    identityPending ? ["git_identity"] : [],
  );
  compareRows(beforeReports, afterReports, "report", (before) => {
    if (!moderationPending) return { ...before };
    const expected = Object.fromEntries(
      Object.entries(before).filter(([key]) => key !== "reporter_sub"),
    );
    expected.reporter_key = `legacy:${before.id}`;
    expected.reason_digest = "";
    return expected;
  });
  if (beforeReportRateLimits !== null) {
    if (afterReportRateLimits === null) {
      throw new Error("report_rate_limits table disappeared during migration");
    }
    const beforeRows = beforeReportRateLimits.map((row) =>
      JSON.stringify(row, Object.keys(row).sort()),
    );
    const afterRows = afterReportRateLimits.map((row) =>
      JSON.stringify(row, Object.keys(row).sort()),
    );
    beforeRows.sort();
    afterRows.sort();
    if (
      beforeRows.length !== afterRows.length ||
      beforeRows.some((row, index) => row !== afterRows[index])
    ) {
      throw new Error("report_rate_limits rows changed during migration");
    }
  }
  for (const row of afterListings ?? []) {
    if (
      identityPending &&
      (typeof row.git_identity !== "string" || row.git_identity !== row.git)
    ) {
      throw new Error(`listing ${row.id} has an invalid git_identity readback`);
    }
    if (authorityPending) {
      for (const field of RETIRED_LISTING_FIELDS) {
        if (field in row)
          throw new Error(`retired listing field ${field} survived`);
      }
    }
  }
  if (moderationPending) {
    for (const row of afterReports ?? []) {
      if ("reporter_sub" in row)
        throw new Error("retired report field reporter_sub survived");
    }
  }
  return {
    listings: afterListings?.length ?? 0,
    reports: afterReports?.length ?? 0,
    reportRateLimits: afterReportRateLimits?.length ?? 0,
  };
}
