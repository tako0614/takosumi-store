import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  REPLICA_CHECK_NAMES,
  SURFACE_ID,
  VERSION,
  assertMigrationReadback,
  assertVersionBindings,
  candidateHealthChecks,
  canonicalJson,
  createWranglerRunner,
  digestJson,
  deploymentHasExactVersionAtFullTraffic,
  isRecord,
  readCredentialFiles,
  readPolicy,
  readPrivateFile,
  readPrivateJson,
  parseJsonOutput,
  runLiveChecks,
  sha256Bytes,
  validateEnvelope,
  verifyArtifact,
  verifySourceAuthority,
  writePrivateJson,
  type CandidateHealthCheck,
  type JsonObject,
  type ReleaseEnvelope,
  type StoreArtifactManifest,
  type TargetPolicy,
  type WranglerRunner,
} from "./store-release-common.ts";
import {
  deploySealedStore,
  migrationLineageMatches,
} from "./store-release-fixed-adapter.ts";

const ACTIONS = [
  "plan",
  "provision",
  "attest",
  "cleanup-plan",
  "destroy",
  "quarantine",
] as const;
type Action = (typeof ACTIONS)[number];
const MUTATIONS = new Set<Action>(["provision", "destroy", "quarantine"]);
const EVIDENCE_FILES: Record<Action, string> = {
  plan: "worker-release-replica-plan.json",
  provision: "worker-release-replica-inventory.json",
  attest: "worker-release-replica-attestation.json",
  "cleanup-plan": "worker-release-replica-cleanup-plan.json",
  destroy: "worker-release-replica-destroy-attestation.json",
  quarantine: "worker-release-replica-quarantine-attestation.json",
};
const STATUSES: Record<Action, string> = {
  plan: "planned",
  provision: "provisioned",
  attest: "attested",
  "cleanup-plan": "cleanup-planned",
  destroy: "destroyed",
  quarantine: "quarantined",
};
const PROGRESS_FILE = "worker-release-replica-progress.json";
const ACCOUNT = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu;
const KV = /^[0-9a-f]{32}$/u;
const NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;

interface ReplicaConfig extends JsonObject {
  readonly kind: "takosumi.store-release-replica-config@v1";
  readonly surfaceId: typeof SURFACE_ID;
  readonly releaseId: string;
  readonly replicaId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly productionTarget: {
    readonly accountId: string;
    readonly workerName: string;
    readonly databaseId: string;
    readonly kvNamespaceId: string;
    readonly iconsBucketName: string;
    readonly origin: string;
  };
  readonly target: {
    readonly accountId: string;
    readonly workerName: string;
    readonly databaseName: string;
    readonly kvNamespaceName: string;
    readonly iconsBucketName: string;
    readonly origin: string;
  };
}

interface Progress extends JsonObject {
  readonly kind: "takosumi.store-release-replica-progress@v1";
  readonly status:
    | "provisioning"
    | "provisioned"
    | "destroying"
    | "destroyed"
    | "quarantining"
    | "quarantined";
  readonly surfaceId: typeof SURFACE_ID;
  readonly releaseId: string;
  readonly replicaId: string;
  readonly accountId: string;
  readonly target: ReplicaConfig["target"];
  readonly artifactDigests: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resources: readonly {
    readonly type: "worker" | "d1" | "kv" | "r2";
    readonly name: string;
    readonly id?: string;
    readonly state:
      | "intent-recorded"
      | "present"
      | "presence-unknown"
      | "deleted";
  }[];
  readonly completedSteps: readonly string[];
  readonly productionFallback: false;
}

interface Inventory extends JsonObject {
  readonly kind: "takosumi.store-release-replica-inventory@v1";
  readonly status: "verified";
  readonly surfaceId: typeof SURFACE_ID;
  readonly releaseId: string;
  readonly replicaId: string;
  readonly accountId: string;
  readonly target: ReplicaConfig["target"] & {
    readonly databaseId: string;
    readonly kvNamespaceId: string;
    readonly versionId: string;
  };
  readonly artifactDigests: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly checks: readonly CandidateHealthCheck[];
  readonly remoteEvidence: JsonObject;
  readonly productionFallback: false;
}

function validateConfig(
  value: unknown,
  envelope: ReleaseEnvelope,
): ReplicaConfig {
  if (!isRecord(value)) throw new Error("replica_config_invalid");
  const config = value as ReplicaConfig;
  if (
    config.kind !== "takosumi.store-release-replica-config@v1" ||
    config.surfaceId !== SURFACE_ID ||
    config.releaseId !== envelope.releaseId ||
    config.replicaId !== envelope.replica.id ||
    config.createdAt !== envelope.replica.createdAt ||
    config.expiresAt !== envelope.replica.expiresAt ||
    !isRecord(config.productionTarget) ||
    !isRecord(config.target)
  ) {
    throw new Error("replica_config_authority_mismatch");
  }
  if (
    !ACCOUNT.test(config.target.accountId) ||
    ![
      config.target.workerName,
      config.target.databaseName,
      config.target.kvNamespaceName,
      config.target.iconsBucketName,
    ].every((name) => NAME.test(name)) ||
    config.target.accountId !== config.productionTarget.accountId ||
    config.target.workerName === config.productionTarget.workerName ||
    config.target.iconsBucketName === config.productionTarget.iconsBucketName ||
    config.target.origin === config.productionTarget.origin
  ) {
    throw new Error("replica_target_not_isolated");
  }
  const requiredFragment = config.replicaId
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .slice(0, 20);
  if (
    ![
      config.target.workerName,
      config.target.databaseName,
      config.target.kvNamespaceName,
      config.target.iconsBucketName,
    ].every((name) => name.includes(requiredFragment))
  ) {
    throw new Error("replica_names_do_not_bind_replica_id");
  }
  const origin = new URL(config.target.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/"
  ) {
    throw new Error("replica_origin_invalid");
  }
  return config;
}

function exactProductionTarget(
  config: ReplicaConfig,
  production: TargetPolicy,
): boolean {
  return (
    canonicalJson(config.productionTarget) ===
    canonicalJson({
      accountId: production.accountId,
      workerName: production.workerName,
      databaseId: production.databaseId,
      kvNamespaceId: production.kvNamespaceId,
      iconsBucketName: production.iconsBucketName,
      origin: production.origin,
    })
  );
}

export interface SanitizedSnapshotScan {
  readonly snapshotDigest: string;
  readonly sqlDigest: string;
  readonly scannerDigest: string;
  readonly sql: string;
  readonly icons: readonly {
    readonly key: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }[];
}

function decodeBase64Exact(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}_base64_missing`);
  }
  const bytes = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/u, "");
  const normalizedOutput = bytes.toString("base64").replace(/=+$/u, "");
  if (normalizedInput !== normalizedOutput)
    throw new Error(`${label}_base64_invalid`);
  return bytes;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (!quote && character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!quote && character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quote || blockComment)
    throw new Error("replica_snapshot_sql_unterminated");
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function assertPublicCatalogSqlOnly(sql: string): void {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0)
    throw new Error("replica_snapshot_sql_statements_missing");
  let listingMutationCount = 0;
  for (const statement of statements) {
    if (/^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT)$/iu.test(statement)) continue;
    const insert =
      /^INSERT(?:\s+OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?\s+INTO\s+["`]?(\w+)["`]?\b/iu.exec(
        statement,
      );
    const update =
      /^UPDATE(?:\s+OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?\s+["`]?(\w+)["`]?\s+SET\b/iu.exec(
        statement,
      );
    const target = insert?.[1] ?? update?.[1];
    if (target !== "listings") {
      throw new Error("replica_snapshot_non_public_catalog_mutation");
    }
    listingMutationCount += 1;
  }
  if (listingMutationCount === 0)
    throw new Error("replica_snapshot_public_catalog_rows_missing");
}

export function scanSanitizedSnapshot(
  bytes: Uint8Array,
  production: TargetPolicy,
): SanitizedSnapshotScan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("replica_snapshot_bundle_json_invalid");
  }
  if (!isRecord(parsed)) throw new Error("replica_snapshot_bundle_invalid");
  const exactBundleKeys = Object.keys(parsed).sort();
  if (
    canonicalJson(exactBundleKeys) !==
      canonicalJson(["icons", "kind", "sqlBase64", "sqlSha256"].sort()) ||
    parsed.kind !== "takosumi.store-sanitized-replica-bundle@v1" ||
    !Array.isArray(parsed.icons) ||
    parsed.icons.length === 0 ||
    parsed.icons.length > 64
  ) {
    throw new Error("replica_snapshot_bundle_shape_invalid");
  }
  const sqlBytes = decodeBase64Exact(parsed.sqlBase64, "replica_snapshot_sql");
  const sqlDigest = sha256Bytes(sqlBytes);
  if (sqlDigest !== parsed.sqlSha256)
    throw new Error("replica_snapshot_sql_digest_mismatch");
  const sql = sqlBytes.toString("utf8");
  if (sql.includes("\0")) {
    throw new Error("replica_snapshot_sql_invalid");
  }
  assertPublicCatalogSqlOnly(sql);
  for (const identity of [
    production.accountId,
    production.workerName,
    production.databaseName,
    production.databaseId,
    production.kvNamespaceId,
    production.iconsBucketName,
    production.origin,
  ]) {
    if (identity && sql.includes(identity)) {
      throw new Error("replica_snapshot_contains_production_identity");
    }
  }
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
    /\bsk_(?:live|test)_[A-Za-z0-9]+/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
    /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[,=:]\s*['"][^'"]{8,}/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(sql))) {
    throw new Error("replica_snapshot_credential_literal_detected");
  }
  const piiPatterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}\b/iu,
    /\b(?:\d{1,3}[.]){3}\d{1,3}\b/u,
    /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/iu,
    /\beyJ[A-Za-z0-9_-]{8,}[.]eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}\b/u,
    /\b(?:cookie|set-cookie|session[_-]?(?:id|token)|csrf[_-]?token)\b\s*[,=:]\s*['"][^'"]{4,}/iu,
  ];
  if (piiPatterns.some((pattern) => pattern.test(sql))) {
    throw new Error("replica_snapshot_pii_literal_detected");
  }
  const icons = parsed.icons.map((entry, index) => {
    if (
      !isRecord(entry) ||
      canonicalJson(Object.keys(entry).sort()) !==
        canonicalJson(["bytesBase64", "key", "mediaType", "sha256"].sort()) ||
      typeof entry.key !== "string" ||
      !/^icons\/[0-9a-f]{64}$/u.test(entry.key) ||
      !new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]).has(
        String(entry.mediaType),
      )
    ) {
      throw new Error(`replica_snapshot_icon_shape_invalid:${index}`);
    }
    const iconBytes = decodeBase64Exact(
      entry.bytesBase64,
      `replica_snapshot_icon_${index}`,
    );
    if (iconBytes.byteLength === 0 || iconBytes.byteLength > 1024 * 1024) {
      throw new Error(`replica_snapshot_icon_size_invalid:${index}`);
    }
    const digest = sha256Bytes(iconBytes);
    if (
      digest !== entry.sha256 ||
      entry.key !== `icons/${digest.slice(7)}` ||
      !sql.includes(entry.key)
    ) {
      throw new Error(
        `replica_snapshot_icon_digest_or_reference_mismatch:${index}`,
      );
    }
    return {
      key: entry.key,
      mediaType: String(entry.mediaType),
      bytes: iconBytes,
      sha256: digest,
    };
  });
  if (
    !sql.includes("tako/takos") ||
    !sql.includes("{{TAKOSUMI_STORE_REPLICA_ORIGIN}}") ||
    new Set(icons.map((icon) => icon.key)).size !== icons.length
  ) {
    throw new Error("replica_snapshot_canonical_listing_or_icon_missing");
  }
  return {
    snapshotDigest: sha256Bytes(bytes),
    sqlDigest,
    scannerDigest: digestJson({
      kind: "takosumi.store-snapshot-scan@v1",
      bytes: bytes.byteLength,
      sqlDigest,
      iconDigests: icons.map((icon) => icon.sha256),
      productionIdentityCount: 7,
      credentialPatternCount: forbidden.length,
      piiPatternCount: piiPatterns.length,
      mutableTableAllowlist: ["listings"],
      status: "passed",
    }),
    sql,
    icons,
  };
}

async function authorizeParent(
  action: Action,
  envelopePath: string,
): Promise<{
  sourceCheckout: string;
  operatorRoot: string;
}> {
  if (
    process.env.TAKOS_RELEASE_SAFETY_REPLICA_PARENT_AUTHORIZED !==
      `${SURFACE_ID}@v1` ||
    process.env.TAKOS_RELEASE_SAFETY_REPLICA_ACTION !== action ||
    process.env.TAKOS_RELEASE_SAFETY_ENVELOPE !== envelopePath ||
    MUTATIONS.has(action) !==
      (process.env.TAKOS_RELEASE_SAFETY_REPLICA_EXECUTE === "authorized")
  ) {
    throw new Error("replica_parent_authority_mismatch");
  }
  for (const raw of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    if (process.env[raw])
      throw new Error(`raw_replica_credential_forbidden:${raw}`);
  }
  const source = process.env.TAKOS_RELEASE_SAFETY_SOURCE_CHECKOUT;
  const operatorRoot = process.env.TAKOS_RELEASE_SAFETY_OPERATOR_ROOT;
  if (!source?.startsWith("/") || !operatorRoot?.startsWith("/")) {
    throw new Error("replica_source_or_operator_root_missing");
  }
  return {
    sourceCheckout: await realpath(source),
    operatorRoot: await realpath(operatorRoot),
  };
}

async function writeProgress(path: string, progress: Progress): Promise<void> {
  await writePrivateJson(path, progress, { replace: true });
}

function updateResource(
  progress: Progress,
  type: Progress["resources"][number]["type"],
  update: Partial<Progress["resources"][number]>,
): Progress {
  return {
    ...progress,
    resources: progress.resources.map((resource) =>
      resource.type === type ? { ...resource, ...update } : resource,
    ),
  };
}

function actionResult(
  action: Action,
  envelope: ReleaseEnvelope,
  evidenceBytes: Uint8Array,
  targetInventoryDigest: string,
): JsonObject {
  return {
    kind: "takos.release-safety-replica-action-result@v1",
    status: STATUSES[action],
    action,
    surfaceId: SURFACE_ID,
    releaseId: envelope.releaseId,
    sourceCommit: envelope.source.commit,
    controllerCommit: envelope.controllerSource.commit,
    replicaAdapterDigest: envelope.authority.replicaAdapterDigest,
    evidenceFile: EVIDENCE_FILES[action],
    evidenceDigest: sha256Bytes(evidenceBytes),
    targetInventoryDigest,
    productionFallback: false,
  };
}

function parseD1Id(output: string): string {
  const match = output.match(/database_id\s*=\s*["']([0-9a-f-]{36})["']/iu);
  if (!match || !UUID.test(match[1]!)) throw new Error("replica_d1_id_missing");
  return match[1]!.toLowerCase();
}

function parseKvId(output: string): string {
  const candidates = [
    ...output.matchAll(/["']?id["']?\s*[:=]\s*["']([0-9a-f]{32})["']/giu),
  ];
  const value = candidates.at(-1)?.[1];
  if (!value || !KV.test(value)) throw new Error("replica_kv_id_missing");
  return value;
}

function replicaToml(
  config: Pick<ReplicaConfig, "target">,
  databaseId: string,
  kvNamespaceId: string,
): string {
  return `name = ${JSON.stringify(config.target.workerName)}
main = "artifact/worker.mjs"
compatibility_date = "2026-06-25"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = true

[vars]
APP_URL = ${JSON.stringify(config.target.origin.replace(/\/$/u, ""))}

[[d1_databases]]
binding = "DB"
database_name = ${JSON.stringify(config.target.databaseName)}
database_id = ${JSON.stringify(databaseId)}
migrations_dir = "migrations"

[[r2_buckets]]
binding = "ICONS"
bucket_name = ${JSON.stringify(config.target.iconsBucketName)}

[[kv_namespaces]]
binding = "KV"
id = ${JSON.stringify(kvNamespaceId)}

[assets]
directory = "./artifact/assets"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"
`;
}

async function materializeReplicaArtifact(
  root: string,
  manifest: StoreArtifactManifest,
  destination: string,
): Promise<void> {
  await Promise.all([
    mkdir(join(destination, "artifact"), { recursive: true, mode: 0o700 }),
    mkdir(join(destination, "migrations"), { recursive: true, mode: 0o700 }),
  ]);
  await cp(
    join(root, manifest.worker.path),
    join(destination, "artifact/worker.mjs"),
    {
      force: false,
      errorOnExist: true,
    },
  );
  await cp(join(root, "assets"), join(destination, "artifact/assets"), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  await cp(join(root, "migrations"), join(destination, "migrations"), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

async function provision(options: {
  envelope: ReleaseEnvelope;
  config: ReplicaConfig;
  sourceCheckout: string;
  artifactRoot: string;
  manifest: StoreArtifactManifest;
  runner: WranglerRunner;
  evidenceDirectory: string;
  snapshotScan: SanitizedSnapshotScan;
  readbackListingPath: string;
}): Promise<Inventory> {
  const progressPath = join(options.evidenceDirectory, PROGRESS_FILE);
  try {
    const retained = await readPrivateJson<Progress>(
      progressPath,
      options.evidenceDirectory,
    );
    if (!new Set(["destroyed", "quarantined"]).has(retained.status)) {
      throw new Error("replica_partial_progress_requires_quarantine");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "replica_partial_progress_requires_quarantine" ||
        !error.message.includes("ENOENT"))
    ) {
      throw error;
    }
  }
  let progress: Progress = {
    kind: "takosumi.store-release-replica-progress@v1",
    status: "provisioning",
    surfaceId: SURFACE_ID,
    releaseId: options.envelope.releaseId,
    replicaId: options.config.replicaId,
    accountId: options.config.target.accountId,
    target: options.config.target,
    artifactDigests: options.envelope.candidate.artifactDigests,
    createdAt: options.config.createdAt,
    expiresAt: options.config.expiresAt,
    resources: [
      {
        type: "d1",
        name: options.config.target.databaseName,
        state: "intent-recorded",
      },
      {
        type: "kv",
        name: options.config.target.kvNamespaceName,
        state: "intent-recorded",
      },
      {
        type: "r2",
        name: options.config.target.iconsBucketName,
        state: "intent-recorded",
      },
      {
        type: "worker",
        name: options.config.target.workerName,
        state: "intent-recorded",
      },
    ],
    completedSteps: ["all-resource-intents-recorded-before-mutation"],
    productionFallback: false,
  };
  await writeProgress(progressPath, progress);
  let databaseId: string;
  try {
    const d1Output = options.runner(
      ["d1", "create", options.config.target.databaseName],
      { cwd: options.sourceCheckout },
    );
    databaseId = parseD1Id(d1Output);
  } catch (error) {
    progress = updateResource(progress, "d1", { state: "presence-unknown" });
    await writeProgress(progressPath, progress);
    throw error;
  }
  progress = updateResource(progress, "d1", {
    id: databaseId,
    state: "present",
  });
  await writeProgress(progressPath, progress);
  let kvNamespaceId: string;
  try {
    const kvOutput = options.runner(
      ["kv", "namespace", "create", options.config.target.kvNamespaceName],
      { cwd: options.sourceCheckout },
    );
    kvNamespaceId = parseKvId(kvOutput);
  } catch (error) {
    progress = updateResource(progress, "kv", { state: "presence-unknown" });
    await writeProgress(progressPath, progress);
    throw error;
  }
  progress = updateResource(progress, "kv", {
    id: kvNamespaceId,
    state: "present",
  });
  await writeProgress(progressPath, progress);
  try {
    options.runner(
      ["r2", "bucket", "create", options.config.target.iconsBucketName],
      { cwd: options.sourceCheckout },
    );
  } catch (error) {
    progress = updateResource(progress, "r2", { state: "presence-unknown" });
    await writeProgress(progressPath, progress);
    throw error;
  }
  progress = updateResource(progress, "r2", { state: "present" });
  await writeProgress(progressPath, progress);
  const releaseRoot = await mkdtemp(
    join(tmpdir(), "takosumi-store-replica-release-"),
  );
  await chmod(releaseRoot, 0o700);
  try {
    await materializeReplicaArtifact(
      options.artifactRoot,
      options.manifest,
      releaseRoot,
    );
    await writeFile(
      join(releaseRoot, "wrangler.toml"),
      replicaToml(options.config, databaseId, kvNamespaceId),
      {
        mode: 0o400,
        flag: "wx",
      },
    );
    options.runner(
      [
        "d1",
        "migrations",
        "apply",
        options.config.target.databaseName,
        "--remote",
        "--config",
        "wrangler.toml",
      ],
      { cwd: releaseRoot },
    );
    const sqlPath = join(releaseRoot, "sanitized-snapshot.sql");
    const materializedSql = options.snapshotScan.sql.replaceAll(
      "{{TAKOSUMI_STORE_REPLICA_ORIGIN}}",
      options.config.target.origin.replace(/\/$/u, ""),
    );
    if (materializedSql.includes("{{TAKOSUMI_STORE_REPLICA_ORIGIN}}")) {
      throw new Error("replica_snapshot_origin_materialization_failed");
    }
    await writeFile(sqlPath, materializedSql, { mode: 0o600, flag: "wx" });
    options.runner(
      [
        "d1",
        "execute",
        options.config.target.databaseName,
        "--remote",
        "--config",
        "wrangler.toml",
        "--file",
        sqlPath,
        "--yes",
      ],
      { cwd: releaseRoot },
    );
    const iconReadback: { key: string; sha256: string; mediaType: string }[] =
      [];
    const iconDirectory = join(releaseRoot, "replica-icons");
    await mkdir(iconDirectory, { mode: 0o700 });
    for (const [index, icon] of options.snapshotScan.icons.entries()) {
      const source = join(iconDirectory, `${index}.source`);
      const readback = join(iconDirectory, `${index}.readback`);
      await writeFile(source, icon.bytes, { mode: 0o600, flag: "wx" });
      options.runner(
        [
          "r2",
          "object",
          "put",
          `${options.config.target.iconsBucketName}/${icon.key}`,
          "--remote",
          "--file",
          source,
          "--content-type",
          icon.mediaType,
          "--force",
        ],
        { cwd: releaseRoot },
      );
      options.runner(
        [
          "r2",
          "object",
          "get",
          `${options.config.target.iconsBucketName}/${icon.key}`,
          "--remote",
          "--file",
          readback,
        ],
        { cwd: releaseRoot },
      );
      const readbackDigest = sha256Bytes(await readFile(readback));
      if (readbackDigest !== icon.sha256) {
        throw new Error("replica_icon_remote_readback_mismatch");
      }
      iconReadback.push({
        key: icon.key,
        sha256: icon.sha256,
        mediaType: icon.mediaType,
      });
    }
    const target: TargetPolicy = {
      configPath: "replica-generated.toml",
      accountId: options.config.target.accountId,
      workerName: options.config.target.workerName,
      origin: options.config.target.origin,
      databaseName: options.config.target.databaseName,
      databaseId,
      kvNamespaceId,
      iconsBucketName: options.config.target.iconsBucketName,
      publishCapability: false,
      compatibilityDate: "2026-06-25",
      compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
      requiredVarNames: ["APP_URL"],
      requiredSecretNames: [],
      customDomainHostname: new URL(options.config.target.origin).hostname,
      readbackListingPath: options.readbackListingPath,
    };
    const checks = candidateHealthChecks(
      REPLICA_CHECK_NAMES,
      target,
      options.envelope.candidate.artifactDigests,
      options.envelope.replica.configFingerprint as string,
    );
    let readback: Awaited<ReturnType<typeof deploySealedStore>>;
    try {
      readback = await deploySealedStore({
        runner: options.runner,
        cwd: releaseRoot,
        target,
        envelope: options.envelope,
        manifest: options.manifest,
        candidateChecks: checks,
      });
    } catch (error) {
      progress = updateResource(progress, "worker", {
        state: "presence-unknown",
      });
      await writeProgress(progressPath, progress);
      throw error;
    }
    progress = updateResource(progress, "worker", {
      id: readback.versionId,
      state: "present",
    });
    progress = {
      ...progress,
      status: "provisioned",
      completedSteps: [
        ...progress.completedSteps,
        "d1-created",
        "kv-created",
        "r2-created",
        "schema-and-snapshot-applied",
        "worker-deployed-and-read-back",
      ],
    };
    await writeProgress(progressPath, progress);
    return {
      kind: "takosumi.store-release-replica-inventory@v1",
      status: "verified",
      surfaceId: SURFACE_ID,
      releaseId: options.envelope.releaseId,
      replicaId: options.config.replicaId,
      accountId: options.config.target.accountId,
      target: {
        ...options.config.target,
        databaseId,
        kvNamespaceId,
        versionId: readback.versionId,
      },
      artifactDigests: options.envelope.candidate.artifactDigests,
      createdAt: options.config.createdAt,
      expiresAt: options.config.expiresAt,
      checks,
      remoteEvidence: {
        versionDigest: digestJson(readback.version),
        deploymentDigest: digestJson(readback.deployments),
        migrationLineageDigest: digestJson(readback.migrationLineage),
        snapshotDigest: options.snapshotScan.snapshotDigest,
        snapshotSqlDigest: options.snapshotScan.sqlDigest,
        snapshotScannerDigest: options.snapshotScan.scannerDigest,
        iconReadbackDigest: digestJson(iconReadback),
      },
      productionFallback: false,
    };
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
}

async function attestReplicaRemote(options: {
  envelope: ReleaseEnvelope;
  inventory: Inventory;
  artifactRoot: string;
  manifest: StoreArtifactManifest;
  runner: WranglerRunner;
  snapshotScan: SanitizedSnapshotScan;
  readbackListingPath: string;
}): Promise<JsonObject> {
  const releaseRoot = await mkdtemp(
    join(tmpdir(), "takosumi-store-replica-attest-"),
  );
  await chmod(releaseRoot, 0o700);
  try {
    await materializeReplicaArtifact(
      options.artifactRoot,
      options.manifest,
      releaseRoot,
    );
    await writeFile(
      join(releaseRoot, "wrangler.toml"),
      replicaToml(
        { target: options.inventory.target },
        options.inventory.target.databaseId,
        options.inventory.target.kvNamespaceId,
      ),
      { mode: 0o400, flag: "wx" },
    );
    const version = parseJsonOutput(
      options.runner(
        [
          "versions",
          "view",
          options.inventory.target.versionId,
          "--name",
          options.inventory.target.workerName,
          "--config",
          "wrangler.toml",
          "--json",
        ],
        { cwd: releaseRoot },
      ),
      "replica_worker_version_readback",
    );
    const target: TargetPolicy = {
      configPath: "replica-generated.toml",
      accountId: options.inventory.accountId,
      workerName: options.inventory.target.workerName,
      origin: options.inventory.target.origin,
      databaseName: options.inventory.target.databaseName,
      databaseId: options.inventory.target.databaseId,
      kvNamespaceId: options.inventory.target.kvNamespaceId,
      iconsBucketName: options.inventory.target.iconsBucketName,
      publishCapability: false,
      compatibilityDate: "2026-06-25",
      compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
      requiredVarNames: ["APP_URL"],
      requiredSecretNames: [],
      customDomainHostname: new URL(options.inventory.target.origin).hostname,
      readbackListingPath: options.readbackListingPath,
    };
    assertVersionBindings(version, options.inventory.target.versionId, target);
    const deployments = parseJsonOutput(
      options.runner(
        [
          "deployments",
          "status",
          "--name",
          options.inventory.target.workerName,
          "--config",
          "wrangler.toml",
          "--json",
        ],
        { cwd: releaseRoot },
      ),
      "replica_worker_deployment_readback",
    );
    if (
      !deploymentHasExactVersionAtFullTraffic(
        deployments,
        options.inventory.target.versionId,
      )
    ) {
      throw new Error("replica_worker_deployment_readback_mismatch");
    }
    const migrations = options.runner(
      [
        "d1",
        "migrations",
        "list",
        options.inventory.target.databaseName,
        "--remote",
        "--config",
        "wrangler.toml",
      ],
      { cwd: releaseRoot },
    );
    assertMigrationReadback(migrations, options.manifest.migrations.length);
    const migrationLineage = parseJsonOutput(
      options.runner(
        [
          "d1",
          "execute",
          options.inventory.target.databaseName,
          "--remote",
          "--config",
          "wrangler.toml",
          "--command",
          "SELECT name FROM d1_migrations ORDER BY id",
          "--json",
        ],
        { cwd: releaseRoot },
      ),
      "replica_d1_migration_lineage",
    );
    if (!migrationLineageMatches(migrationLineage, options.manifest)) {
      throw new Error("replica_d1_migration_lineage_mismatch");
    }
    const iconReadback: { key: string; sha256: string; mediaType: string }[] =
      [];
    const iconDirectory = join(releaseRoot, "replica-icon-readback");
    await mkdir(iconDirectory, { mode: 0o700 });
    for (const [index, icon] of options.snapshotScan.icons.entries()) {
      const readback = join(iconDirectory, `${index}.readback`);
      options.runner(
        [
          "r2",
          "object",
          "get",
          `${options.inventory.target.iconsBucketName}/${icon.key}`,
          "--remote",
          "--file",
          readback,
        ],
        { cwd: releaseRoot },
      );
      if (sha256Bytes(await readFile(readback)) !== icon.sha256) {
        throw new Error("replica_icon_remote_readback_mismatch");
      }
      iconReadback.push({
        key: icon.key,
        sha256: icon.sha256,
        mediaType: icon.mediaType,
      });
    }
    const checks = candidateHealthChecks(
      REPLICA_CHECK_NAMES,
      target,
      options.envelope.candidate.artifactDigests,
      options.envelope.replica.configFingerprint as string,
    );
    await runLiveChecks({
      target,
      manifest: options.manifest,
      artifactRoot: options.artifactRoot,
      candidateChecks: checks,
    });
    return {
      versionDigest: digestJson(version),
      deploymentDigest: digestJson(deployments),
      migrationLineageDigest: digestJson(migrationLineage),
      snapshotDigest: options.snapshotScan.snapshotDigest,
      snapshotSqlDigest: options.snapshotScan.sqlDigest,
      snapshotScannerDigest: options.snapshotScan.scannerDigest,
      iconReadbackDigest: digestJson(iconReadback),
    };
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
}

function exactKvNamespaceId(output: string, title: string): string | null {
  const parsed = parseJsonOutput(output, "replica_kv_namespace_inventory");
  const matches: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (value.title === title && typeof value.id === "string") {
      if (!KV.test(value.id))
        throw new Error("replica_kv_namespace_id_invalid");
      matches.push(value.id);
    }
    Object.values(value).forEach(visit);
  };
  visit(parsed);
  const ids = [...new Set(matches)];
  if (ids.length > 1)
    throw new Error("replica_kv_namespace_inventory_ambiguous");
  return ids[0] ?? null;
}

async function destroyExact(options: {
  inventory: Inventory | Progress;
  runner: WranglerRunner;
  cwd: string;
  progressPath: string;
  action: "destroy" | "quarantine";
}): Promise<void> {
  const target = options.inventory.target;
  const resources =
    "resources" in options.inventory
      ? options.inventory.resources
      : [
          {
            type: "worker",
            name: target.workerName,
            id: (target as Inventory["target"]).versionId,
            state: "present",
          },
          {
            type: "d1",
            name: target.databaseName,
            id: (target as Inventory["target"]).databaseId,
            state: "present",
          },
          {
            type: "kv",
            name: target.kvNamespaceName,
            id: (target as Inventory["target"]).kvNamespaceId,
            state: "present",
          },
          { type: "r2", name: target.iconsBucketName, state: "present" },
        ];
  let progress: Progress = {
    kind: "takosumi.store-release-replica-progress@v1",
    status: options.action === "destroy" ? "destroying" : "quarantining",
    surfaceId: SURFACE_ID,
    releaseId: options.inventory.releaseId,
    replicaId: options.inventory.replicaId,
    accountId: options.inventory.accountId,
    target,
    artifactDigests: options.inventory.artifactDigests,
    createdAt: options.inventory.createdAt,
    expiresAt: options.inventory.expiresAt,
    resources: resources as Progress["resources"],
    completedSteps: ["exact-cleanup-started-from-retained-inventory"],
    productionFallback: false,
  };
  await writeProgress(options.progressPath, progress);
  const worker = progress.resources.find(
    (resource) => resource.type === "worker",
  );
  if (worker && worker.state !== "deleted") {
    options.runner(["delete", worker!.name, "--force"], { cwd: options.cwd });
    progress = updateResource(progress, "worker", { state: "deleted" });
    await writeProgress(options.progressPath, progress);
  }
  const d1 = progress.resources.find((resource) => resource.type === "d1");
  if (d1 && d1.state !== "deleted") {
    options.runner(["d1", "delete", d1!.name, "--skip-confirmation"], {
      cwd: options.cwd,
    });
    progress = updateResource(progress, "d1", { state: "deleted" });
    await writeProgress(options.progressPath, progress);
  }
  const kv = progress.resources.find((resource) => resource.type === "kv");
  if (kv && kv.state !== "deleted") {
    const kvId =
      kv.state === "present" && kv.id
        ? kv.id
        : exactKvNamespaceId(
            options.runner(["kv", "namespace", "list"], {
              cwd: options.cwd,
            }),
            kv.name,
          );
    if (kvId) {
      options.runner(
        [
          "kv",
          "namespace",
          "delete",
          "--namespace-id",
          kvId,
          "--skip-confirmation",
        ],
        { cwd: options.cwd },
      );
    }
    progress = updateResource(progress, "kv", { state: "deleted" });
    await writeProgress(options.progressPath, progress);
  }
  const r2 = progress.resources.find((resource) => resource.type === "r2");
  if (r2 && r2.state !== "deleted") {
    options.runner(["r2", "bucket", "delete", r2!.name], { cwd: options.cwd });
    progress = updateResource(progress, "r2", { state: "deleted" });
  }
  progress = {
    ...progress,
    status: options.action === "destroy" ? "destroyed" : "quarantined",
  };
  await writeProgress(options.progressPath, progress);
}

export async function runStoreReplicaAdapter(options: {
  readonly action: string;
  readonly envelopePath: string;
  readonly wrapperPath: string;
  readonly runner?: WranglerRunner;
}): Promise<JsonObject> {
  if (!ACTIONS.includes(options.action as Action))
    throw new Error("unsupported_replica_action");
  const action = options.action as Action;
  const envelopePath = await realpath(options.envelopePath);
  const parent = await authorizeParent(action, envelopePath);
  const envelope = validateEnvelope(await readPrivateJson(envelopePath));
  await verifySourceAuthority(parent.sourceCheckout, envelope);
  if (
    sha256Bytes(await readFile(options.wrapperPath)) !==
    envelope.authority.replicaAdapterDigest
  ) {
    throw new Error("replica_adapter_digest_mismatch");
  }
  const policy = await readPolicy(parent.operatorRoot);
  if (
    policy.digest !== envelope.authority.operatorPolicyDigest ||
    policy.digest !== envelope.candidate.policyDigest
  ) {
    throw new Error("replica_policy_digest_mismatch");
  }
  const configPath = process.env.TAKOSUMI_RELEASE_REPLICA_RUNTIME_CONFIG_FILE;
  const snapshotPath =
    process.env.TAKOSUMI_RELEASE_REPLICA_SANITIZED_SNAPSHOT_FILE;
  if (!configPath?.startsWith("/") || !snapshotPath?.startsWith("/")) {
    throw new Error("replica_config_or_snapshot_file_missing");
  }
  const configBytes = await readPrivateFile(configPath);
  const config = validateConfig(
    JSON.parse(configBytes.toString("utf8")),
    envelope,
  );
  if (!exactProductionTarget(config, policy.policy.production)) {
    throw new Error("replica_production_target_policy_mismatch");
  }
  if (sha256Bytes(configBytes) !== envelope.replica.configFingerprint) {
    throw new Error("replica_config_fingerprint_mismatch");
  }
  const snapshotBytes = await readPrivateFile(snapshotPath, {
    maxBytes: 64 * 1024 * 1024,
  });
  const snapshotScan = scanSanitizedSnapshot(
    snapshotBytes,
    policy.policy.production,
  );
  if (
    snapshotScan.snapshotDigest !==
    (envelope.replica.data as JsonObject)?.snapshotDigest
  ) {
    throw new Error("replica_snapshot_digest_mismatch");
  }
  const artifact = await verifyArtifact(envelope.evidence.directory, envelope);
  if (
    artifact.manifest.digests.migrations !==
    envelope.replica.migrationPlanDigest
  ) {
    throw new Error("replica_migration_plan_digest_mismatch");
  }
  const plan = {
    kind: "takosumi.store-release-replica-plan@v1",
    surfaceId: SURFACE_ID,
    releaseId: envelope.releaseId,
    replicaId: config.replicaId,
    sourceCommit: envelope.source.commit,
    artifactDigests: envelope.candidate.artifactDigests,
    configFingerprint: envelope.replica.configFingerprint,
    migrationPlanDigest: envelope.replica.migrationPlanDigest,
    snapshotDigest: (envelope.replica.data as JsonObject).snapshotDigest,
    target: config.target,
    productionFallback: false,
  };
  const evidenceDirectory = await realpath(envelope.evidence.directory);
  if (dirname(envelopePath) !== evidenceDirectory)
    throw new Error("replica_evidence_directory_mismatch");
  if (action === "plan") {
    const bytes = await writePrivateJson(
      join(evidenceDirectory, EVIDENCE_FILES.plan),
      plan,
    );
    return actionResult(action, envelope, bytes, digestJson(plan));
  }
  const credentials = await readCredentialFiles(
    "TAKOSUMI_RELEASE_REPLICA_ACCOUNT_ID_FILE",
    "TAKOSUMI_RELEASE_REPLICA_API_TOKEN_FILE",
    config.target.accountId,
  );
  const wranglerEntrypoint = await realpath(
    resolve(
      parent.sourceCheckout,
      "node_modules/wrangler/wrangler-dist/cli.js",
    ),
  );
  const runner =
    options.runner ??
    createWranglerRunner({
      wranglerEntrypoint,
      accountId: credentials.accountId,
      apiToken: credentials.apiToken,
    });
  if (action === "provision") {
    const inventory = await provision({
      envelope,
      config,
      sourceCheckout: parent.sourceCheckout,
      artifactRoot: artifact.root,
      manifest: artifact.manifest,
      runner,
      evidenceDirectory,
      snapshotScan,
      readbackListingPath: policy.policy.production.readbackListingPath,
    });
    const bytes = await writePrivateJson(
      join(evidenceDirectory, EVIDENCE_FILES.provision),
      inventory,
    );
    return actionResult(action, envelope, bytes, digestJson(inventory));
  }
  const inventoryPath = join(evidenceDirectory, EVIDENCE_FILES.provision);
  const progressPath = join(evidenceDirectory, PROGRESS_FILE);
  if (action === "cleanup-plan") {
    const inventory = await readPrivateJson<Inventory>(
      inventoryPath,
      evidenceDirectory,
    );
    const cleanup = {
      kind: "takosumi.store-release-replica-cleanup-plan@v1",
      surfaceId: SURFACE_ID,
      releaseId: envelope.releaseId,
      replicaId: config.replicaId,
      targetInventoryDigest: digestJson(inventory),
      exactTarget: inventory.target,
      actions: [
        "delete exact replica Worker",
        "delete exact replica D1",
        "delete exact replica KV",
        "delete exact replica R2",
      ],
      productionFallback: false,
    };
    const bytes = await writePrivateJson(
      join(evidenceDirectory, EVIDENCE_FILES["cleanup-plan"]),
      cleanup,
    );
    return actionResult(action, envelope, bytes, digestJson(inventory));
  }
  if (action === "attest") {
    const inventory = await readPrivateJson<Inventory>(
      inventoryPath,
      evidenceDirectory,
    );
    const liveRemoteEvidence = await attestReplicaRemote({
      envelope,
      inventory,
      artifactRoot: artifact.root,
      manifest: artifact.manifest,
      runner,
      snapshotScan,
      readbackListingPath: policy.policy.production.readbackListingPath,
    });
    if (
      canonicalJson(liveRemoteEvidence) !==
      canonicalJson(inventory.remoteEvidence)
    ) {
      throw new Error("replica_remote_inventory_readback_mismatch");
    }
    const targetInventoryDigest = digestJson(inventory);
    if (targetInventoryDigest !== envelope.replica.targetInventoryDigest) {
      throw new Error("replica_target_inventory_digest_mismatch");
    }
    const attestation = {
      kind: "takos.release-safety-replica-attestation@v1",
      status: "verified",
      surfaceId: SURFACE_ID,
      releaseId: envelope.releaseId,
      sourceCommit: envelope.source.commit,
      controllerCommit: envelope.controllerSource.commit,
      replicaAdapterDigest: envelope.authority.replicaAdapterDigest,
      replicaId: envelope.replica.id,
      accessPolicy: envelope.replica.accessPolicy,
      createdAt: envelope.replica.createdAt,
      verifiedAt: envelope.replica.verifiedAt,
      expiresAt: envelope.replica.expiresAt,
      configFingerprint: envelope.replica.configFingerprint,
      migrationPlanDigest: envelope.replica.migrationPlanDigest,
      targetInventoryDigest,
      artifactDigests: envelope.replica.artifactDigests,
      checks: envelope.replica.checks,
      failureRehearsal: envelope.replica.failureRehearsal,
      data: envelope.replica.data,
      productionFallback: false,
    };
    const attestationPath = join(evidenceDirectory, EVIDENCE_FILES.attest);
    let bytes: Uint8Array;
    try {
      bytes = await writePrivateJson(attestationPath, attestation);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("EEXIST"))
        throw error;
      const retained = await readPrivateFile(attestationPath, {
        expectedDirectory: evidenceDirectory,
      });
      const expected = Buffer.from(`${canonicalJson(attestation)}\n`);
      if (!retained.equals(expected)) {
        throw new Error("replica_attestation_immutable_conflict");
      }
      bytes = retained;
    }
    return actionResult(action, envelope, bytes, targetInventoryDigest);
  }
  let recoverable: Inventory | Progress;
  try {
    recoverable = await readPrivateJson<Inventory>(
      inventoryPath,
      evidenceDirectory,
    );
  } catch {
    recoverable = await readPrivateJson<Progress>(
      progressPath,
      evidenceDirectory,
    );
  }
  await destroyExact({
    inventory: recoverable,
    runner,
    cwd: parent.sourceCheckout,
    progressPath,
    action,
  });
  const terminal = {
    kind: `takosumi.store-release-replica-${action}@v1`,
    surfaceId: SURFACE_ID,
    releaseId: envelope.releaseId,
    replicaId: config.replicaId,
    status: action === "destroy" ? "destroyed" : "quarantined",
    sourceInventoryDigest: digestJson(recoverable),
    exactTarget: recoverable.target,
    productionFallback: false,
  };
  const bytes = await writePrivateJson(
    join(evidenceDirectory, EVIDENCE_FILES[action]),
    terminal,
  );
  return actionResult(action, envelope, bytes, digestJson(terminal));
}

export async function mainReplicaAdapter(wrapperPath: string): Promise<void> {
  const action = process.argv[2] ?? "";
  const args = process.argv.slice(3);
  if (
    args.length !== 2 ||
    args[0] !== "--envelope" ||
    !args[1]?.startsWith("/")
  ) {
    throw new Error("replica_adapter_arguments_invalid");
  }
  const result = await runStoreReplicaAdapter({
    action,
    envelopePath: args[1],
    wrapperPath,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
