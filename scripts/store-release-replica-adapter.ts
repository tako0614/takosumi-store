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
import { dirname, join } from "node:path";

import {
  REPLICA_CHECK_NAMES,
  RELEASE_CREDENTIAL_PATTERNS,
  RELEASE_PII_PATTERNS,
  SURFACE_ID,
  VERSION,
  assertIconMediaType,
  assertNoReleaseCredentialOrPii,
  assertMigrationReadback,
  assertVersionBindings,
  candidateHealthChecks,
  canonicalJson,
  createCloudflareReadClient,
  createWranglerRunner,
  digestJson,
  deploymentHasExactVersionAtFullTraffic,
  isRecord,
  readCredentialFiles,
  readPolicy,
  readPrivateFile,
  readPrivateJson,
  readRuntimeTopology,
  parseJsonOutput,
  runLiveChecks,
  sha256Bytes,
  validateEnvelope,
  verifyActualToolchain,
  verifyArtifact,
  verifySourceAuthority,
  writePrivateJson,
  type CandidateHealthCheck,
  type CloudflareReadClient,
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

export interface ReplicaConfig extends JsonObject {
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

export interface Progress extends JsonObject {
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
  readonly preflightAbsenceDigest: string;
  readonly completedSteps: readonly string[];
  readonly productionFallback: false;
}

export interface Inventory extends JsonObject {
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

function assertExactObjectKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is JsonObject {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson([...expected].sort())
  ) {
    throw new Error(`${label}_schema_invalid`);
  }
}

function assertReplicaTargetBound(
  target: unknown,
  config: ReplicaConfig,
  label: string,
): asserts target is ReplicaConfig["target"] {
  assertExactObjectKeys(
    target,
    [
      "accountId",
      "workerName",
      "databaseName",
      "kvNamespaceName",
      "iconsBucketName",
      "origin",
    ],
    label,
  );
  if (canonicalJson(target) !== canonicalJson(config.target)) {
    throw new Error(`${label}_authority_mismatch`);
  }
  if (
    target.workerName === config.productionTarget.workerName ||
    target.databaseName === config.productionTarget.databaseId ||
    target.kvNamespaceName === config.productionTarget.kvNamespaceId ||
    target.iconsBucketName === config.productionTarget.iconsBucketName ||
    target.origin === config.productionTarget.origin
  ) {
    throw new Error(`${label}_production_identity_forbidden`);
  }
}

export function validateInventory(
  value: unknown,
  envelope: ReleaseEnvelope,
  config: ReplicaConfig,
): Inventory {
  assertExactObjectKeys(
    value,
    [
      "kind",
      "status",
      "surfaceId",
      "releaseId",
      "replicaId",
      "accountId",
      "target",
      "artifactDigests",
      "createdAt",
      "expiresAt",
      "checks",
      "remoteEvidence",
      "productionFallback",
    ],
    "replica_inventory",
  );
  const inventory = value as unknown as Inventory;
  assertExactObjectKeys(
    inventory.target,
    [
      "accountId",
      "workerName",
      "databaseName",
      "kvNamespaceName",
      "iconsBucketName",
      "origin",
      "databaseId",
      "kvNamespaceId",
      "versionId",
    ],
    "replica_inventory_target",
  );
  const baseTarget = { ...inventory.target } as JsonObject;
  delete baseTarget.databaseId;
  delete baseTarget.kvNamespaceId;
  delete baseTarget.versionId;
  assertReplicaTargetBound(baseTarget, config, "replica_inventory_target");
  if (
    inventory.kind !== "takosumi.store-release-replica-inventory@v1" ||
    inventory.status !== "verified" ||
    inventory.surfaceId !== SURFACE_ID ||
    inventory.releaseId !== envelope.releaseId ||
    inventory.replicaId !== config.replicaId ||
    inventory.accountId !== config.target.accountId ||
    inventory.createdAt !== config.createdAt ||
    inventory.expiresAt !== config.expiresAt ||
    canonicalJson(inventory.artifactDigests) !==
      canonicalJson(envelope.candidate.artifactDigests) ||
    inventory.productionFallback !== false ||
    !UUID.test(inventory.target.databaseId) ||
    !KV.test(inventory.target.kvNamespaceId) ||
    !UUID.test(inventory.target.versionId) ||
    inventory.target.databaseId === config.productionTarget.databaseId ||
    inventory.target.kvNamespaceId === config.productionTarget.kvNamespaceId ||
    !Array.isArray(inventory.checks) ||
    inventory.checks.length !== REPLICA_CHECK_NAMES.length
  ) {
    throw new Error("replica_inventory_authority_mismatch");
  }
  for (const [index, check] of inventory.checks.entries()) {
    assertExactObjectKeys(
      check,
      ["name", "bindingDigest"],
      `replica_inventory_check_${index}`,
    );
    if (
      check.name !== REPLICA_CHECK_NAMES[index] ||
      typeof check.bindingDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(check.bindingDigest)
    ) {
      throw new Error("replica_inventory_check_mismatch");
    }
  }
  assertExactObjectKeys(
    inventory.remoteEvidence,
    [
      "versionDigest",
      "deploymentDigest",
      "migrationLineageDigest",
      "snapshotDigest",
      "snapshotSqlDigest",
      "snapshotScannerDigest",
      "iconReadbackDigest",
      "topologyDigest",
      "preflightAbsenceDigest",
    ],
    "replica_inventory_remote_evidence",
  );
  if (
    Object.values(inventory.remoteEvidence).some(
      (digest) =>
        typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest),
    )
  ) {
    throw new Error("replica_inventory_remote_evidence_invalid");
  }
  return inventory;
}

export function validateProgress(
  value: unknown,
  envelope: ReleaseEnvelope,
  config: ReplicaConfig,
): Progress {
  assertExactObjectKeys(
    value,
    [
      "kind",
      "status",
      "surfaceId",
      "releaseId",
      "replicaId",
      "accountId",
      "target",
      "artifactDigests",
      "createdAt",
      "expiresAt",
      "resources",
      "preflightAbsenceDigest",
      "completedSteps",
      "productionFallback",
    ],
    "replica_progress",
  );
  const progress = value as unknown as Progress;
  assertReplicaTargetBound(progress.target, config, "replica_progress_target");
  if (
    progress.kind !== "takosumi.store-release-replica-progress@v1" ||
    progress.surfaceId !== SURFACE_ID ||
    progress.releaseId !== envelope.releaseId ||
    progress.replicaId !== config.replicaId ||
    progress.accountId !== config.target.accountId ||
    progress.createdAt !== config.createdAt ||
    progress.expiresAt !== config.expiresAt ||
    canonicalJson(progress.artifactDigests) !==
      canonicalJson(envelope.candidate.artifactDigests) ||
    progress.productionFallback !== false ||
    !/^sha256:[0-9a-f]{64}$/u.test(progress.preflightAbsenceDigest) ||
    progress.preflightAbsenceDigest !==
      digestJson({
        kind: "takosumi.store-replica-preflight-absence@v1",
        target: config.target,
        worker: true,
        d1: true,
        kv: true,
        r2: true,
      }) ||
    ![
      "provisioning",
      "provisioned",
      "destroying",
      "destroyed",
      "quarantining",
      "quarantined",
    ].includes(progress.status) ||
    !Array.isArray(progress.completedSteps) ||
    progress.completedSteps.some((step) => typeof step !== "string") ||
    !Array.isArray(progress.resources) ||
    progress.resources.length !== 4
  ) {
    throw new Error("replica_progress_authority_mismatch");
  }
  const expectedNames = new Map<Progress["resources"][number]["type"], string>([
    ["worker", config.target.workerName],
    ["d1", config.target.databaseName],
    ["kv", config.target.kvNamespaceName],
    ["r2", config.target.iconsBucketName],
  ]);
  const seen = new Set<string>();
  for (const [index, resource] of progress.resources.entries()) {
    assertExactObjectKeys(
      resource,
      resource.id === undefined
        ? ["type", "name", "state"]
        : ["type", "name", "id", "state"],
      `replica_progress_resource_${index}`,
    );
    const typedResource = resource as unknown as Progress["resources"][number];
    if (
      !expectedNames.has(typedResource.type) ||
      expectedNames.get(typedResource.type) !== typedResource.name ||
      seen.has(typedResource.type) ||
      !["intent-recorded", "present", "presence-unknown", "deleted"].includes(
        typedResource.state,
      )
    ) {
      throw new Error("replica_progress_resource_mismatch");
    }
    if (
      typedResource.id !== undefined &&
      ((typedResource.type === "kv" && !KV.test(typedResource.id)) ||
        (typedResource.type !== "kv" &&
          typedResource.type !== "r2" &&
          !UUID.test(typedResource.id)) ||
        typedResource.type === "r2")
    ) {
      throw new Error("replica_progress_resource_id_invalid");
    }
    if (
      (typedResource.type === "d1" &&
        typedResource.id === config.productionTarget.databaseId) ||
      (typedResource.type === "kv" &&
        typedResource.id === config.productionTarget.kvNamespaceId)
    ) {
      throw new Error("replica_progress_production_identity_forbidden");
    }
    seen.add(typedResource.type);
  }
  return progress;
}

export function assertInventoryDigest(
  inventory: Inventory,
  envelope: ReleaseEnvelope,
): void {
  if (digestJson(inventory) !== envelope.replica.targetInventoryDigest) {
    throw new Error("replica_target_inventory_digest_mismatch");
  }
}

function validateConfig(
  value: unknown,
  envelope: ReleaseEnvelope,
): ReplicaConfig {
  assertExactObjectKeys(
    value,
    [
      "kind",
      "surfaceId",
      "releaseId",
      "replicaId",
      "createdAt",
      "expiresAt",
      "productionTarget",
      "target",
    ],
    "replica_config",
  );
  const config = value as unknown as ReplicaConfig;
  assertExactObjectKeys(
    config.productionTarget,
    [
      "accountId",
      "workerName",
      "databaseId",
      "kvNamespaceId",
      "iconsBucketName",
      "origin",
    ],
    "replica_config_production_target",
  );
  assertExactObjectKeys(
    config.target,
    [
      "accountId",
      "workerName",
      "databaseName",
      "kvNamespaceName",
      "iconsBucketName",
      "origin",
    ],
    "replica_config_target",
  );
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
  assertNoReleaseCredentialOrPii(sql, "replica_snapshot");
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
    assertIconMediaType(
      iconBytes,
      String(entry.mediaType),
      `replica_snapshot_icon_${index}`,
    );
    assertNoReleaseCredentialOrPii(iconBytes, `replica_snapshot_icon_${index}`);
    assertNoReleaseCredentialOrPii(
      canonicalJson({
        key: entry.key,
        mediaType: entry.mediaType,
        sha256: entry.sha256,
      }),
      `replica_snapshot_icon_metadata_${index}`,
    );
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
      credentialPatternCount: RELEASE_CREDENTIAL_PATTERNS.length,
      piiPatternCount: RELEASE_PII_PATTERNS.length,
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
preview_urls = false

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
  cloudflareReadClient: CloudflareReadClient;
}): Promise<Inventory> {
  const progressPath = join(options.evidenceDirectory, PROGRESS_FILE);
  try {
    const retained = validateProgress(
      await readPrivateJson(progressPath, options.evidenceDirectory),
      options.envelope,
      options.config,
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
  const preflightAbsence = {
    worker:
      !workerVersionPresent(
        options.runner,
        options.sourceCheckout,
        options.config.target.workerName,
      ) &&
      !(await scriptSubdomainPresent(
        options.cloudflareReadClient,
        options.config.target.workerName,
      )),
    d1:
      exactD1DatabaseId(
        options.runner(["d1", "list", "--json"], {
          cwd: options.sourceCheckout,
        }),
        options.config.target.databaseName,
      ) === null,
    kv:
      exactKvNamespaceId(
        options.runner(["kv", "namespace", "list"], {
          cwd: options.sourceCheckout,
        }),
        options.config.target.kvNamespaceName,
      ) === null,
    r2:
      (
        await listR2Buckets(
          options.cloudflareReadClient,
          options.config.target.iconsBucketName,
        )
      ).length === 0,
  };
  if (Object.values(preflightAbsence).some((absent) => absent !== true)) {
    throw new Error("replica_preflight_target_not_absent");
  }
  const preflightAbsenceDigest = digestJson({
    kind: "takosumi.store-replica-preflight-absence@v1",
    target: options.config.target,
    ...preflightAbsence,
  });
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
    preflightAbsenceDigest,
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
        deployTriggers: true,
        readTopology: () =>
          readRuntimeTopology(
            options.cloudflareReadClient,
            target,
            "workers-dev",
          ),
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
        topologyDigest: digestJson(readback.topology),
        preflightAbsenceDigest,
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
  cloudflareReadClient: CloudflareReadClient;
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
    const topology = await readRuntimeTopology(
      options.cloudflareReadClient,
      target,
      "workers-dev",
    );
    return {
      versionDigest: digestJson(version),
      deploymentDigest: digestJson(deployments),
      migrationLineageDigest: digestJson(migrationLineage),
      snapshotDigest: options.snapshotScan.snapshotDigest,
      snapshotSqlDigest: options.snapshotScan.sqlDigest,
      snapshotScannerDigest: options.snapshotScan.scannerDigest,
      iconReadbackDigest: digestJson(iconReadback),
      topologyDigest: digestJson(topology),
    };
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
}

export function exactKvNamespaceId(
  output: string,
  title: string,
  sealedId?: string,
): string | null {
  const parsed = parseJsonOutput(output, "replica_kv_namespace_inventory");
  const matches: { title: string; id: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (
      typeof value.title === "string" &&
      typeof value.id === "string" &&
      (value.title === title || value.id === sealedId)
    ) {
      if (!KV.test(value.id))
        throw new Error("replica_kv_namespace_id_invalid");
      matches.push({ title: value.title, id: value.id });
    }
    Object.values(value).forEach(visit);
  };
  visit(parsed);
  const unique = [
    ...new Map(matches.map((entry) => [entry.id, entry])).values(),
  ];
  if (unique.length > 1)
    throw new Error("replica_kv_namespace_inventory_ambiguous");
  const match = unique[0];
  if (
    match &&
    (match.title !== title || (sealedId !== undefined && match.id !== sealedId))
  ) {
    throw new Error("replica_kv_namespace_inventory_identity_mismatch");
  }
  return match?.id ?? null;
}

export function exactD1DatabaseId(
  output: string,
  name: string,
  sealedId?: string,
): string | null {
  const parsed = parseJsonOutput(output, "replica_d1_inventory");
  const matches: { name: string; id: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isRecord(value)) return;
    if (
      typeof value.name === "string" &&
      typeof value.uuid === "string" &&
      (value.name === name || value.uuid === sealedId)
    ) {
      if (!UUID.test(value.uuid))
        throw new Error("replica_d1_inventory_id_invalid");
      matches.push({ name: value.name, id: value.uuid });
    }
    Object.values(value).forEach(visit);
  };
  visit(parsed);
  const unique = [
    ...new Map(matches.map((entry) => [entry.id, entry])).values(),
  ];
  if (unique.length > 1) throw new Error("replica_d1_inventory_ambiguous");
  const match = unique[0];
  if (
    match &&
    (match.name !== name || (sealedId !== undefined && match.id !== sealedId))
  ) {
    throw new Error("replica_d1_inventory_identity_mismatch");
  }
  return match?.id ?? null;
}

function inspectRemote(
  runner: WranglerRunner,
  args: readonly string[],
  cwd: string,
): { readonly status: "ok" | "not-found"; readonly stdout: string } {
  if (!runner.inspect) throw new Error("replica_remote_inspection_unavailable");
  const result = runner.inspect(args, { cwd });
  if (result.status === "failed") {
    throw new Error("replica_remote_inspection_failed");
  }
  return { status: result.status, stdout: result.stdout };
}

function workerVersionPresent(
  runner: WranglerRunner,
  cwd: string,
  name: string,
  expectedVersionId?: string,
): boolean {
  const result = inspectRemote(
    runner,
    ["versions", "list", "--name", name, "--json"],
    cwd,
  );
  if (result.status === "not-found") return false;
  const parsed = parseJsonOutput(result.stdout, "replica_worker_inventory");
  if (!Array.isArray(parsed))
    throw new Error("replica_worker_inventory_invalid");
  if (parsed.length === 0) return false;
  if (
    expectedVersionId &&
    !parsed.some((entry) => isRecord(entry) && entry.id === expectedVersionId)
  ) {
    throw new Error("replica_worker_inventory_version_mismatch");
  }
  return true;
}

async function scriptSubdomainPresent(
  client: CloudflareReadClient,
  workerName: string,
): Promise<boolean> {
  const response = await client.get(
    `/accounts/${encodeURIComponent(client.accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
  );
  if (response.status === "not-found") return false;
  if (!isRecord(response.result) || response.result.enabled !== true) {
    throw new Error("replica_worker_subdomain_ownership_mismatch");
  }
  return true;
}

async function listR2Buckets(
  client: CloudflareReadClient,
  name: string,
): Promise<JsonObject[]> {
  const response = await client.get(
    `/accounts/${encodeURIComponent(client.accountId)}/r2/buckets`,
    { name_contains: name, per_page: "1000" },
  );
  if (response.status !== "ok" || !isRecord(response.result)) {
    throw new Error("replica_r2_bucket_inventory_missing");
  }
  const buckets = response.result.buckets;
  if (!Array.isArray(buckets))
    throw new Error("replica_r2_bucket_inventory_invalid");
  const matches = buckets.filter(
    (entry) => isRecord(entry) && entry.name === name,
  ) as JsonObject[];
  if (matches.length > 1)
    throw new Error("replica_r2_bucket_inventory_ambiguous");
  return matches;
}

async function listAllR2Objects(
  client: CloudflareReadClient,
  bucketName: string,
): Promise<JsonObject[]> {
  const objects: JsonObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const response = await client.get(
      `/accounts/${encodeURIComponent(client.accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects`,
      { per_page: "1000", ...(cursor ? { cursor } : {}) },
    );
    if (response.status === "not-found") return [];
    if (response.status !== "ok" || !isRecord(response.result)) {
      throw new Error("replica_r2_object_inventory_missing");
    }
    const pageObjects = response.result.objects;
    if (!Array.isArray(pageObjects)) {
      throw new Error("replica_r2_object_inventory_invalid");
    }
    for (const entry of pageObjects) {
      if (!isRecord(entry) || typeof entry.key !== "string") {
        throw new Error("replica_r2_object_inventory_invalid");
      }
      objects.push(entry);
    }
    const next = response.result.cursor;
    if (typeof next !== "string" || next === "") return objects;
    cursor = next;
  }
  throw new Error("replica_r2_object_inventory_page_limit");
}

export async function destroyExact(options: {
  inventory: Inventory | Progress;
  runner: WranglerRunner;
  cwd: string;
  progressPath: string;
  action: "destroy" | "quarantine";
  snapshotScan: SanitizedSnapshotScan;
  cloudflareReadClient: CloudflareReadClient;
}): Promise<void> {
  const target = options.inventory.target;
  const retainedProgress =
    options.inventory.kind === "takosumi.store-release-replica-progress@v1"
      ? (options.inventory as Progress)
      : null;
  const desiredStatus =
    options.action === "destroy" ? "destroying" : "quarantining";
  const terminalStatus =
    options.action === "destroy" ? "destroyed" : "quarantined";
  if (
    retainedProgress &&
    ((["destroying", "destroyed"].includes(retainedProgress.status) &&
      options.action !== "destroy") ||
      (["quarantining", "quarantined"].includes(retainedProgress.status) &&
        options.action !== "quarantine"))
  ) {
    throw new Error("replica_cleanup_action_changed");
  }
  const resources = retainedProgress
    ? retainedProgress.resources
    : ([
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
      ] as Progress["resources"]);
  let progress: Progress = retainedProgress
    ? {
        ...retainedProgress,
        status:
          retainedProgress.status === terminalStatus
            ? terminalStatus
            : desiredStatus,
        completedSteps: retainedProgress.completedSteps.includes(
          "exact-cleanup-started-from-retained-authority",
        )
          ? retainedProgress.completedSteps
          : [
              ...retainedProgress.completedSteps,
              "exact-cleanup-started-from-retained-authority",
            ],
      }
    : {
        kind: "takosumi.store-release-replica-progress@v1",
        status: desiredStatus,
        surfaceId: SURFACE_ID,
        releaseId: options.inventory.releaseId,
        replicaId: options.inventory.replicaId,
        accountId: options.inventory.accountId,
        target,
        artifactDigests: options.inventory.artifactDigests,
        createdAt: options.inventory.createdAt,
        expiresAt: options.inventory.expiresAt,
        resources,
        preflightAbsenceDigest: String(
          (options.inventory as Inventory).remoteEvidence
            .preflightAbsenceDigest,
        ),
        completedSteps: ["exact-cleanup-started-from-retained-authority"],
        productionFallback: false,
      };
  await writeProgress(options.progressPath, progress);
  const preflightWorker = progress.resources.find(
    (resource) => resource.type === "worker",
  )!;
  const preflightWorkerPresent = workerVersionPresent(
    options.runner,
    options.cwd,
    preflightWorker.name,
    preflightWorker.id,
  );
  if (
    preflightWorkerPresent !==
    (await scriptSubdomainPresent(
      options.cloudflareReadClient,
      preflightWorker.name,
    ))
  ) {
    throw new Error("replica_worker_inventory_topology_mismatch");
  }
  const preflightD1 = progress.resources.find(
    (resource) => resource.type === "d1",
  )!;
  const preflightD1Id = exactD1DatabaseId(
    options.runner(["d1", "list", "--json"], { cwd: options.cwd }),
    preflightD1.name,
    preflightD1.id,
  );
  if (preflightD1Id && preflightD1.id && preflightD1Id !== preflightD1.id) {
    throw new Error("replica_d1_inventory_id_mismatch");
  }
  const preflightKv = progress.resources.find(
    (resource) => resource.type === "kv",
  )!;
  const preflightKvId = exactKvNamespaceId(
    options.runner(["kv", "namespace", "list"], { cwd: options.cwd }),
    preflightKv.name,
    preflightKv.id,
  );
  if (preflightKvId && preflightKv.id && preflightKvId !== preflightKv.id) {
    throw new Error("replica_kv_inventory_id_mismatch");
  }
  const preflightKvKeys = preflightKvId
    ? parseJsonOutput(
        options.runner(
          ["kv", "key", "list", "--namespace-id", preflightKvId, "--remote"],
          { cwd: options.cwd },
        ),
        "replica_kv_key_inventory",
      )
    : [];
  if (!Array.isArray(preflightKvKeys) || preflightKvKeys.length !== 0) {
    throw new Error("replica_kv_key_inventory_not_empty");
  }
  const preflightR2 = progress.resources.find(
    (resource) => resource.type === "r2",
  )!;
  const preflightR2Present =
    (await listR2Buckets(options.cloudflareReadClient, preflightR2.name))
      .length === 1;
  const preflightObjects = preflightR2Present
    ? await listAllR2Objects(options.cloudflareReadClient, preflightR2.name)
    : [];
  const expectedObjectKeys = options.snapshotScan.icons
    .map((icon) => icon.key)
    .sort();
  if (
    preflightR2Present &&
    canonicalJson(preflightObjects.map((entry) => String(entry.key)).sort()) !==
      canonicalJson(expectedObjectKeys)
  ) {
    throw new Error("replica_r2_object_inventory_mismatch");
  }
  if (preflightR2Present) {
    const readbackRoot = await mkdtemp(
      join(tmpdir(), "takosumi-store-replica-cleanup-preflight-"),
    );
    await chmod(readbackRoot, 0o700);
    try {
      for (const [index, icon] of options.snapshotScan.icons.entries()) {
        const path = join(readbackRoot, `${index}.readback`);
        const result = inspectRemote(
          options.runner,
          [
            "r2",
            "object",
            "get",
            `${preflightR2.name}/${icon.key}`,
            "--remote",
            "--file",
            path,
          ],
          options.cwd,
        );
        if (
          result.status !== "ok" ||
          sha256Bytes(await readFile(path)) !== icon.sha256
        ) {
          throw new Error("replica_r2_object_ownership_mismatch");
        }
      }
    } finally {
      await rm(readbackRoot, { recursive: true, force: true });
    }
  }
  const cleanupPreflightDigest = digestJson({
    kind: "takosumi.store-replica-cleanup-preflight@v1",
    worker: { name: preflightWorker.name, present: preflightWorkerPresent },
    d1: { name: preflightD1.name, id: preflightD1Id },
    kv: {
      name: preflightKv.name,
      id: preflightKvId,
      keyInventoryDigest: digestJson(preflightKvKeys),
    },
    r2: {
      name: preflightR2.name,
      present: preflightR2Present,
      objects: preflightObjects,
    },
  });
  if (
    !progress.completedSteps.includes(
      `cleanup-preflight:${cleanupPreflightDigest}`,
    )
  ) {
    progress = {
      ...progress,
      completedSteps: [
        ...progress.completedSteps,
        `cleanup-preflight:${cleanupPreflightDigest}`,
      ],
    };
    await writeProgress(options.progressPath, progress);
  }
  const worker = progress.resources.find(
    (resource) => resource.type === "worker",
  );
  if (worker) {
    const present = workerVersionPresent(
      options.runner,
      options.cwd,
      worker.name,
      worker.id,
    );
    const subdomainPresent = await scriptSubdomainPresent(
      options.cloudflareReadClient,
      worker.name,
    );
    if (present !== subdomainPresent) {
      throw new Error("replica_worker_inventory_topology_mismatch");
    }
    if (present) {
      options.runner(["delete", worker.name, "--force"], { cwd: options.cwd });
    }
    if (workerVersionPresent(options.runner, options.cwd, worker.name)) {
      throw new Error("replica_worker_post_delete_present");
    }
    if (
      await scriptSubdomainPresent(options.cloudflareReadClient, worker.name)
    ) {
      throw new Error("replica_worker_subdomain_post_delete_present");
    }
    progress = updateResource(progress, "worker", { state: "deleted" });
    await writeProgress(options.progressPath, progress);
  }
  const d1 = progress.resources.find((resource) => resource.type === "d1");
  if (d1) {
    const found = exactD1DatabaseId(
      options.runner(["d1", "list", "--json"], { cwd: options.cwd }),
      d1.name,
      d1.id,
    );
    if (found && d1.id && found !== d1.id) {
      throw new Error("replica_d1_inventory_id_mismatch");
    }
    if (found) {
      progress = updateResource(progress, "d1", {
        id: found,
        state: "present",
      });
      await writeProgress(options.progressPath, progress);
      options.runner(["d1", "delete", d1.name, "--skip-confirmation"], {
        cwd: options.cwd,
      });
    }
    if (
      exactD1DatabaseId(
        options.runner(["d1", "list", "--json"], { cwd: options.cwd }),
        d1.name,
        d1.id,
      )
    ) {
      throw new Error("replica_d1_post_delete_present");
    }
    progress = updateResource(progress, "d1", { state: "deleted" });
    await writeProgress(options.progressPath, progress);
  }
  const kv = progress.resources.find((resource) => resource.type === "kv");
  if (kv) {
    const kvId = exactKvNamespaceId(
      options.runner(["kv", "namespace", "list"], { cwd: options.cwd }),
      kv.name,
      kv.id,
    );
    if (kvId && kv.id && kvId !== kv.id) {
      throw new Error("replica_kv_inventory_id_mismatch");
    }
    if (kvId) {
      progress = updateResource(progress, "kv", { id: kvId, state: "present" });
      await writeProgress(options.progressPath, progress);
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
    if (
      exactKvNamespaceId(
        options.runner(["kv", "namespace", "list"], { cwd: options.cwd }),
        kv.name,
        kv.id,
      )
    ) {
      throw new Error("replica_kv_post_delete_present");
    }
    progress = updateResource(progress, "kv", { state: "deleted" });
    await writeProgress(options.progressPath, progress);
  }
  const r2 = progress.resources.find((resource) => resource.type === "r2");
  if (r2) {
    const present =
      (await listR2Buckets(options.cloudflareReadClient, r2.name)).length === 1;
    if (present) {
      const objects = await listAllR2Objects(
        options.cloudflareReadClient,
        r2.name,
      );
      const expectedKeys = options.snapshotScan.icons
        .map((icon) => icon.key)
        .sort();
      const actualKeys = objects.map((entry) => String(entry.key)).sort();
      if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) {
        throw new Error("replica_r2_object_inventory_mismatch");
      }
      const readbackRoot = await mkdtemp(
        join(tmpdir(), "takosumi-store-replica-cleanup-"),
      );
      await chmod(readbackRoot, 0o700);
      try {
        for (const [index, icon] of options.snapshotScan.icons.entries()) {
          const before = join(readbackRoot, `${index}.before`);
          const beforeResult = inspectRemote(
            options.runner,
            [
              "r2",
              "object",
              "get",
              `${r2.name}/${icon.key}`,
              "--remote",
              "--file",
              before,
            ],
            options.cwd,
          );
          if (beforeResult.status === "ok") {
            if (sha256Bytes(await readFile(before)) !== icon.sha256) {
              throw new Error("replica_r2_object_ownership_mismatch");
            }
            options.runner(
              ["r2", "object", "delete", `${r2.name}/${icon.key}`, "--remote"],
              { cwd: options.cwd },
            );
          }
          const after = join(readbackRoot, `${index}.after`);
          if (
            inspectRemote(
              options.runner,
              [
                "r2",
                "object",
                "get",
                `${r2.name}/${icon.key}`,
                "--remote",
                "--file",
                after,
              ],
              options.cwd,
            ).status !== "not-found"
          ) {
            throw new Error("replica_r2_object_post_delete_present");
          }
        }
        if (
          (await listAllR2Objects(options.cloudflareReadClient, r2.name))
            .length !== 0
        ) {
          throw new Error("replica_r2_object_inventory_post_delete_present");
        }
      } finally {
        await rm(readbackRoot, { recursive: true, force: true });
      }
      options.runner(["r2", "bucket", "delete", r2.name], {
        cwd: options.cwd,
      });
    }
    if (
      (await listR2Buckets(options.cloudflareReadClient, r2.name)).length !== 0
    ) {
      throw new Error("replica_r2_post_delete_present");
    }
    progress = updateResource(progress, "r2", { state: "deleted" });
    await writeProgress(options.progressPath, progress);
  }
  progress = {
    ...progress,
    status: terminalStatus,
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
  if (
    digestJson(artifact.manifest.toolchain) !==
    envelope.candidate.toolchainDigest
  ) {
    throw new Error("replica_toolchain_digest_mismatch");
  }
  const toolchain = await verifyActualToolchain(
    parent.sourceCheckout,
    artifact.manifest,
  );
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
  const cloudflareReadClient = createCloudflareReadClient(credentials);
  const wranglerEntrypoint = toolchain.wranglerEntrypoint;
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
      cloudflareReadClient,
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
    const inventory = validateInventory(
      await readPrivateJson(inventoryPath, evidenceDirectory),
      envelope,
      config,
    );
    assertInventoryDigest(inventory, envelope);
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
    const inventory = validateInventory(
      await readPrivateJson(inventoryPath, evidenceDirectory),
      envelope,
      config,
    );
    assertInventoryDigest(inventory, envelope);
    const liveRemoteEvidence = await attestReplicaRemote({
      envelope,
      inventory,
      artifactRoot: artifact.root,
      manifest: artifact.manifest,
      runner,
      snapshotScan,
      readbackListingPath: policy.policy.production.readbackListingPath,
      cloudflareReadClient,
    });
    if (
      canonicalJson(liveRemoteEvidence) !==
      canonicalJson(inventory.remoteEvidence)
    ) {
      throw new Error("replica_remote_inventory_readback_mismatch");
    }
    const targetInventoryDigest = digestJson(inventory);
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
  let inventory: Inventory | null = null;
  try {
    inventory = validateInventory(
      await readPrivateJson(inventoryPath, evidenceDirectory),
      envelope,
      config,
    );
    assertInventoryDigest(inventory, envelope);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
  }
  let progress: Progress | null = null;
  try {
    progress = validateProgress(
      await readPrivateJson(progressPath, evidenceDirectory),
      envelope,
      config,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
  }
  if (!inventory && !progress) {
    throw new Error("replica_cleanup_authority_missing");
  }
  const recoverable = progress ?? inventory!;
  await destroyExact({
    inventory: recoverable,
    runner,
    cwd: parent.sourceCheckout,
    progressPath,
    action,
    snapshotScan,
    cloudflareReadClient,
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
  const terminalPath = join(evidenceDirectory, EVIDENCE_FILES[action]);
  let bytes: Uint8Array;
  try {
    bytes = await writePrivateJson(terminalPath, terminal);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("EEXIST")) {
      throw error;
    }
    const retained = await readPrivateFile(terminalPath, {
      expectedDirectory: evidenceDirectory,
    });
    const retainedValue = JSON.parse(retained.toString("utf8"));
    if (
      !isRecord(retainedValue) ||
      retainedValue.kind !== terminal.kind ||
      retainedValue.surfaceId !== SURFACE_ID ||
      retainedValue.releaseId !== envelope.releaseId ||
      retainedValue.replicaId !== config.replicaId ||
      retainedValue.status !== terminal.status ||
      canonicalJson(retainedValue.exactTarget) !==
        canonicalJson(recoverable.target) ||
      retainedValue.productionFallback !== false
    ) {
      throw new Error("replica_cleanup_terminal_immutable_conflict");
    }
    bytes = retained;
  }
  return actionResult(
    action,
    envelope,
    bytes,
    digestJson(JSON.parse(Buffer.from(bytes).toString("utf8"))),
  );
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
