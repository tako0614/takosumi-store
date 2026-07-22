import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

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
  "prepare-input",
  "plan",
  "provision",
  "rehearse",
  "attest",
  "cleanup-plan",
  "destroy",
  "quarantine",
] as const;
type Action = (typeof ACTIONS)[number];
const MUTATIONS = new Set<Action>([
  "provision",
  "rehearse",
  "destroy",
  "quarantine",
]);
const EVIDENCE_FILES: Record<Action, string> = {
  "prepare-input": "worker-release-replica-input.json",
  plan: "worker-release-replica-plan.json",
  provision: "worker-release-replica-inventory.json",
  rehearse: "worker-release-replica-forward-repair-inventory.json",
  attest: "worker-release-replica-attestation.json",
  "cleanup-plan": "worker-release-replica-cleanup-plan.json",
  destroy: "worker-release-replica-destroy-attestation.json",
  quarantine: "worker-release-replica-quarantine-attestation.json",
};
const STATUSES: Record<Action, string> = {
  "prepare-input": "prepared",
  plan: "planned",
  provision: "provisioned",
  rehearse: "rehearsed",
  attest: "attested",
  "cleanup-plan": "cleanup-planned",
  destroy: "destroyed",
  quarantine: "quarantined",
};
const PROGRESS_FILE = "worker-release-replica-progress.json";
const FORWARD_REPAIR_EVIDENCE_FILE =
  "worker-release-replica-forward-repair-rehearsal.json";
const FORWARD_REPAIR_PROGRESS_FILE =
  "worker-release-replica-forward-repair-progress.json";
const FORWARD_REPAIR_OPERATION_FILE =
  "worker-release-replica-forward-repair-operation.json";
const REPLICA_CONFIG_FILE = "worker-release-replica-runtime-config.json";
const REPLICA_SNAPSHOT_FILE = "worker-release-replica-sanitized-snapshot.json";
const PRODUCTION_EXPORT_PROVENANCE_FILE =
  "worker-release-replica-production-export-provenance.json";
const ACCOUNT = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu;
const KV = /^[0-9a-f]{32}$/u;
const NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SNAPSHOT_KEY_ENV = "TAKOSUMI_RELEASE_REPLICA_SNAPSHOT_KEY_FILE";

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

interface ForwardRepairEvidence extends JsonObject {
  readonly kind: "takosumi.store-replica-forward-repair-rehearsal@v1";
  readonly status: "passed";
  readonly surfaceId: typeof SURFACE_ID;
  readonly releaseId: string;
  readonly replicaId: string;
  readonly sourceCommit: string;
  readonly strategy: "forward-repair-after-database-mutation";
  readonly configFingerprint: string;
  readonly migrationPlanDigest: string;
  readonly snapshotDigest: string;
  readonly initialInventoryDigest: string;
  readonly injectedFailure: "replica-worker-removed-after-schema";
  readonly failureInjection: JsonObject;
  readonly forwardRepair: JsonObject;
  readonly recoveredVersionId: string;
  readonly recoveredDeploymentDigest: string;
  readonly verifiedAt: string;
}

interface ForwardRepairProgress extends JsonObject {
  readonly kind: "takosumi.store-replica-forward-repair-progress@v1";
  readonly status: "intent-recorded" | "worker-absent" | "repaired";
  readonly surfaceId: typeof SURFACE_ID;
  readonly releaseId: string;
  readonly replicaId: string;
  readonly initialInventoryDigest: string;
  readonly target: Inventory["target"];
  readonly removedVersionId: string;
  readonly workerAbsenceDigest?: string;
  readonly storagePreservationDigest?: string;
  readonly recoveredVersionId?: string;
  readonly recoveredDeploymentDigest?: string;
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
  options: { readonly requireRehearsal?: boolean } = {},
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
      ...(options.requireRehearsal ? ["failureRehearsalDigest"] : []),
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
  if (
    options.requireRehearsal === true &&
    inventory.checks[REPLICA_CHECK_NAMES.length - 1]?.bindingDigest !==
      inventory.remoteEvidence.failureRehearsalDigest
  ) {
    throw new Error("replica_inventory_rehearsal_check_binding_mismatch");
  }
  return inventory;
}

export function validateForwardRepairEvidence(
  value: unknown,
  envelope: ReleaseEnvelope,
  config: ReplicaConfig,
  repairedInventory: Inventory,
  initialInventory: Inventory,
  progress: ForwardRepairProgress,
): ForwardRepairEvidence {
  assertExactObjectKeys(
    value,
    [
      "kind",
      "status",
      "surfaceId",
      "releaseId",
      "replicaId",
      "sourceCommit",
      "strategy",
      "configFingerprint",
      "migrationPlanDigest",
      "snapshotDigest",
      "initialInventoryDigest",
      "injectedFailure",
      "failureInjection",
      "forwardRepair",
      "recoveredVersionId",
      "recoveredDeploymentDigest",
      "verifiedAt",
    ],
    "replica_forward_repair_evidence",
  );
  const evidence = value as unknown as ForwardRepairEvidence;
  assertExactObjectKeys(
    evidence.failureInjection,
    [
      "removedVersionId",
      "workerAbsenceDigest",
      "resumeReadbackDigest",
      "storagePreservationDigest",
    ],
    "replica_forward_repair_failure_injection",
  );
  assertExactObjectKeys(
    evidence.forwardRepair,
    [
      "versionDigest",
      "deploymentDigest",
      "migrationLineageDigest",
      "topologyDigest",
      "verifiedAt",
    ],
    "replica_forward_repair_readback",
  );
  if (
    evidence.kind !== "takosumi.store-replica-forward-repair-rehearsal@v1" ||
    evidence.status !== "passed" ||
    evidence.surfaceId !== SURFACE_ID ||
    evidence.releaseId !== envelope.releaseId ||
    evidence.replicaId !== config.replicaId ||
    evidence.sourceCommit !== envelope.source.commit ||
    evidence.strategy !== "forward-repair-after-database-mutation" ||
    evidence.configFingerprint !== envelope.replica.configFingerprint ||
    evidence.migrationPlanDigest !== envelope.replica.migrationPlanDigest ||
    evidence.snapshotDigest !==
      (envelope.replica.data as JsonObject).snapshotDigest ||
    evidence.initialInventoryDigest !== digestJson(initialInventory) ||
    evidence.injectedFailure !== "replica-worker-removed-after-schema" ||
    evidence.failureInjection.removedVersionId !==
      initialInventory.target.versionId ||
    evidence.failureInjection.workerAbsenceDigest !==
      progress.workerAbsenceDigest ||
    evidence.failureInjection.storagePreservationDigest !==
      progress.storagePreservationDigest ||
    evidence.recoveredVersionId !== repairedInventory.target.versionId ||
    evidence.recoveredDeploymentDigest !==
      repairedInventory.remoteEvidence.deploymentDigest ||
    evidence.forwardRepair.versionDigest !==
      repairedInventory.remoteEvidence.versionDigest ||
    evidence.forwardRepair.deploymentDigest !==
      repairedInventory.remoteEvidence.deploymentDigest ||
    evidence.forwardRepair.migrationLineageDigest !==
      repairedInventory.remoteEvidence.migrationLineageDigest ||
    evidence.forwardRepair.topologyDigest !==
      repairedInventory.remoteEvidence.topologyDigest ||
    evidence.verifiedAt !== evidence.forwardRepair.verifiedAt ||
    !Number.isFinite(Date.parse(evidence.verifiedAt)) ||
    evidence.failureInjection.removedVersionId ===
      evidence.recoveredVersionId ||
    !UUID.test(String(evidence.failureInjection.removedVersionId)) ||
    !UUID.test(evidence.recoveredVersionId)
  ) {
    throw new Error("replica_forward_repair_evidence_authority_mismatch");
  }
  for (const digest of [
    evidence.initialInventoryDigest,
    evidence.failureInjection.workerAbsenceDigest,
    evidence.failureInjection.resumeReadbackDigest,
    evidence.failureInjection.storagePreservationDigest,
    ...Object.entries(evidence.forwardRepair)
      .filter(([key]) => key !== "verifiedAt")
      .map(([, value]) => value),
  ]) {
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new Error("replica_forward_repair_evidence_digest_invalid");
    }
  }
  return evidence;
}

function validateForwardRepairProgress(
  value: unknown,
  envelope: ReleaseEnvelope,
  config: ReplicaConfig,
  initialInventory: Inventory,
): ForwardRepairProgress {
  if (!isRecord(value)) {
    throw new Error("replica_forward_repair_progress_schema_invalid");
  }
  const status = value.status;
  if (
    status !== "intent-recorded" &&
    status !== "worker-absent" &&
    status !== "repaired"
  ) {
    throw new Error("replica_forward_repair_progress_status_invalid");
  }
  assertExactObjectKeys(
    value,
    [
      "kind",
      "status",
      "surfaceId",
      "releaseId",
      "replicaId",
      "initialInventoryDigest",
      "target",
      "removedVersionId",
      ...(status === "intent-recorded"
        ? []
        : ["workerAbsenceDigest", "storagePreservationDigest"]),
      ...(status === "repaired"
        ? ["recoveredVersionId", "recoveredDeploymentDigest"]
        : []),
    ],
    "replica_forward_repair_progress",
  );
  const progress = value as unknown as ForwardRepairProgress;
  if (
    progress.kind !== "takosumi.store-replica-forward-repair-progress@v1" ||
    progress.surfaceId !== SURFACE_ID ||
    progress.releaseId !== envelope.releaseId ||
    progress.replicaId !== config.replicaId ||
    progress.initialInventoryDigest !== digestJson(initialInventory) ||
    canonicalJson(progress.target) !== canonicalJson(initialInventory.target) ||
    progress.removedVersionId !== initialInventory.target.versionId ||
    !UUID.test(progress.removedVersionId)
  ) {
    throw new Error("replica_forward_repair_progress_authority_mismatch");
  }
  if (
    status !== "intent-recorded" &&
    (typeof progress.workerAbsenceDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(progress.workerAbsenceDigest) ||
      typeof progress.storagePreservationDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(progress.storagePreservationDigest))
  ) {
    throw new Error("replica_forward_repair_progress_storage_invalid");
  }
  if (
    status === "repaired" &&
    (!UUID.test(String(progress.recoveredVersionId)) ||
      progress.recoveredVersionId === progress.removedVersionId ||
      typeof progress.recoveredDeploymentDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(progress.recoveredDeploymentDigest))
  ) {
    throw new Error("replica_forward_repair_progress_recovery_invalid");
  }
  return progress;
}

function replicaHealthChecks(
  target: TargetPolicy,
  envelope: ReleaseEnvelope,
  failureRehearsalDigest?: string,
): CandidateHealthCheck[] {
  const checks = candidateHealthChecks(
    REPLICA_CHECK_NAMES,
    target,
    envelope.candidate.artifactDigests,
    envelope.replica.configFingerprint as string,
  );
  if (failureRehearsalDigest) {
    checks[REPLICA_CHECK_NAMES.length - 1] = {
      name: REPLICA_CHECK_NAMES[REPLICA_CHECK_NAMES.length - 1]!,
      bindingDigest: failureRehearsalDigest,
    };
  }
  return checks;
}

function validateForwardRepairOperation(
  value: unknown,
  envelope: ReleaseEnvelope,
  target: TargetPolicy,
): JsonObject {
  assertExactObjectKeys(
    value,
    [
      "kind",
      "environment",
      "surfaceId",
      "releaseId",
      "sourceCommit",
      "artifactDigests",
      "targetFingerprint",
      "target",
      "preDeploymentDigest",
      "phase",
      "versionId",
      "updatedAt",
    ],
    "replica_forward_repair_operation",
  );
  assertExactObjectKeys(
    value.target,
    [
      "accountId",
      "workerName",
      "databaseId",
      "kvNamespaceId",
      "iconsBucketName",
      "origin",
    ],
    "replica_forward_repair_operation_target",
  );
  const phases = [
    "intent-recorded",
    "schema-applied",
    "version-uploaded",
    "deployed",
    "verified",
  ];
  const phase = String(value.phase);
  const phaseIndex = phases.indexOf(phase);
  const versionRequired = phaseIndex >= phases.indexOf("version-uploaded");
  if (
    value.kind !== "takosumi.store-release-operation@v1" ||
    value.environment !== "replica-forward-repair" ||
    value.surfaceId !== SURFACE_ID ||
    value.releaseId !== envelope.releaseId ||
    value.sourceCommit !== envelope.source.commit ||
    canonicalJson(value.artifactDigests) !==
      canonicalJson(envelope.candidate.artifactDigests) ||
    value.targetFingerprint !== digestJson(target) ||
    canonicalJson(value.target) !==
      canonicalJson({
        accountId: target.accountId,
        workerName: target.workerName,
        databaseId: target.databaseId,
        kvNamespaceId: target.kvNamespaceId,
        iconsBucketName: target.iconsBucketName,
        origin: target.origin,
      }) ||
    value.preDeploymentDigest !== digestJson({ versions: [] }) ||
    phaseIndex < 0 ||
    versionRequired !== (typeof value.versionId === "string") ||
    (versionRequired && !UUID.test(String(value.versionId))) ||
    !Number.isFinite(Date.parse(String(value.updatedAt)))
  ) {
    throw new Error("replica_forward_repair_operation_authority_mismatch");
  }
  return value;
}

export async function recoverForwardRepairCleanupProgress(options: {
  progress: Progress;
  envelope: ReleaseEnvelope;
  config: ReplicaConfig;
  evidenceDirectory: string;
  readbackListingPath: string;
}): Promise<Progress> {
  try {
    const initialInventory = validateInventory(
      await readPrivateJson(
        join(options.evidenceDirectory, EVIDENCE_FILES.provision),
        options.evidenceDirectory,
      ),
      options.envelope,
      options.config,
    );
    const forwardProgress = validateForwardRepairProgress(
      await readPrivateJson(
        join(options.evidenceDirectory, FORWARD_REPAIR_PROGRESS_FILE),
        options.evidenceDirectory,
      ),
      options.envelope,
      options.config,
      initialInventory,
    );
    const repairTarget: TargetPolicy = {
      configPath: "replica-generated.toml",
      accountId: initialInventory.accountId,
      workerName: initialInventory.target.workerName,
      origin: initialInventory.target.origin,
      databaseName: initialInventory.target.databaseName,
      databaseId: initialInventory.target.databaseId,
      kvNamespaceId: initialInventory.target.kvNamespaceId,
      iconsBucketName: initialInventory.target.iconsBucketName,
      publishCapability: false,
      compatibilityDate: "2026-06-25",
      compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
      requiredVarNames: ["APP_URL"],
      requiredSecretNames: [],
      customDomainHostname: new URL(initialInventory.target.origin).hostname,
      readbackListingPath: options.readbackListingPath,
    };
    const operation = validateForwardRepairOperation(
      await readPrivateJson(
        join(options.evidenceDirectory, FORWARD_REPAIR_OPERATION_FILE),
        options.evidenceDirectory,
      ),
      options.envelope,
      repairTarget,
    );
    if (
      !["version-uploaded", "deployed", "verified"].includes(
        String(operation.phase),
      ) ||
      !UUID.test(String(operation.versionId)) ||
      operation.versionId === initialInventory.target.versionId
    ) {
      return options.progress;
    }
    return {
      ...updateResource(options.progress, "worker", {
        id: String(operation.versionId),
        state: "present",
      }),
      completedSteps: [
        ...new Set([
          ...options.progress.completedSteps,
          `forward-repair-cleanup-recovery:${digestJson(forwardProgress)}`,
        ]),
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      return options.progress;
    }
    throw error;
  }
}

export async function resolveReplicaAttestationVerifiedAt(options: {
  path: string;
  evidenceDirectory: string;
  envelope: ReleaseEnvelope;
  config: ReplicaConfig;
  inventory: Inventory;
  failureRehearsalDigest: string;
  failureVerifiedAt: string;
}): Promise<string> {
  let retained: JsonObject;
  try {
    retained = await readPrivateJson<JsonObject>(
      options.path,
      options.evidenceDirectory,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      return options.failureVerifiedAt;
    }
    throw error;
  }
  assertExactObjectKeys(
    retained,
    [
      "kind",
      "status",
      "surfaceId",
      "releaseId",
      "sourceCommit",
      "controllerCommit",
      "replicaAdapterDigest",
      "replicaId",
      "accessPolicy",
      "createdAt",
      "verifiedAt",
      "expiresAt",
      "configFingerprint",
      "migrationPlanDigest",
      "targetInventoryDigest",
      "artifactDigests",
      "checks",
      "failureRehearsal",
      "data",
      "productionFallback",
    ],
    "replica_attestation",
  );
  assertExactObjectKeys(
    retained.failureRehearsal,
    ["status", "strategy", "bindingDigest"],
    "replica_attestation_failure_rehearsal",
  );
  assertExactObjectKeys(
    retained.data,
    [
      "source",
      "snapshotDigest",
      "snapshotCiphertextDigest",
      "provenanceDigest",
      "piiScan",
      "secretScan",
      "referentialIntegrity",
    ],
    "replica_attestation_data",
  );
  if (
    retained.kind !== "takos.release-safety-replica-attestation@v1" ||
    retained.status !== "verified" ||
    retained.surfaceId !== SURFACE_ID ||
    retained.releaseId !== options.envelope.releaseId ||
    retained.sourceCommit !== options.envelope.source.commit ||
    retained.controllerCommit !== options.envelope.controllerSource.commit ||
    retained.replicaAdapterDigest !==
      options.envelope.authority.replicaAdapterDigest ||
    retained.replicaId !== options.config.replicaId ||
    retained.accessPolicy !== "replica-only-no-production-fallback" ||
    retained.createdAt !== options.config.createdAt ||
    retained.expiresAt !== options.config.expiresAt ||
    retained.verifiedAt !== options.failureVerifiedAt ||
    !Number.isFinite(Date.parse(String(retained.verifiedAt))) ||
    retained.configFingerprint !== options.envelope.replica.configFingerprint ||
    retained.migrationPlanDigest !==
      options.envelope.replica.migrationPlanDigest ||
    retained.targetInventoryDigest !== digestJson(options.inventory) ||
    canonicalJson(retained.artifactDigests) !==
      canonicalJson(options.envelope.candidate.artifactDigests) ||
    retained.productionFallback !== false ||
    !isRecord(retained.failureRehearsal) ||
    retained.failureRehearsal.status !== "passed" ||
    retained.failureRehearsal.strategy !==
      "forward-repair-after-database-mutation" ||
    retained.failureRehearsal.bindingDigest !==
      options.failureRehearsalDigest ||
    !isRecord(retained.data) ||
    retained.data.source !== "encrypted-anonymized-production-snapshot" ||
    retained.data.snapshotDigest !==
      (options.envelope.replica.data as JsonObject).snapshotDigest ||
    retained.data.snapshotCiphertextDigest !==
      (options.envelope.replica.data as JsonObject).snapshotCiphertextDigest ||
    retained.data.provenanceDigest !==
      (options.envelope.replica.data as JsonObject).provenanceDigest ||
    retained.data.piiScan !== "passed" ||
    retained.data.secretScan !== "passed" ||
    retained.data.referentialIntegrity !== "passed" ||
    !Array.isArray(retained.checks) ||
    retained.checks.length !== REPLICA_CHECK_NAMES.length
  ) {
    throw new Error("replica_attestation_authority_mismatch");
  }
  for (const [index, check] of retained.checks.entries()) {
    assertExactObjectKeys(
      check,
      ["name", "status", "bindingDigest"],
      `replica_attestation_check_${index}`,
    );
    if (
      check.name !== options.inventory.checks[index]?.name ||
      check.status !== "passed" ||
      check.bindingDigest !== options.inventory.checks[index]?.bindingDigest
    ) {
      throw new Error("replica_attestation_check_mismatch");
    }
  }
  return String(retained.verifiedAt);
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

async function retainExactJson(
  path: string,
  value: JsonObject,
  evidenceDirectory: string,
): Promise<Uint8Array> {
  try {
    return await writePrivateJson(path, value);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("EEXIST")) {
      throw error;
    }
    const retained = await readPrivateFile(path, {
      expectedDirectory: evidenceDirectory,
    });
    if (!retained.equals(Buffer.from(`${canonicalJson(value)}\n`))) {
      throw new Error("replica_input_immutable_conflict");
    }
    return retained;
  }
}

const PRODUCTION_EXPORT_COLUMNS = [
  "id",
  "scope",
  "slug",
  "git",
  "ref",
  "path",
  "kind",
  "surface",
  "provider",
  "category",
  "tags",
  "suggested_name",
  "name_ja",
  "name_en",
  "description_ja",
  "description_en",
  "badge_ja",
  "badge_en",
  "icon_url",
  "inputs",
  "output_allowlist",
  "publisher_handle",
  "publisher_display_name",
  "status",
  "created_at",
  "updated_at",
] as const;

function sqlValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value !== "string") {
    throw new Error("replica_production_export_value_invalid");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function findExactProductionListing(value: unknown): JsonObject {
  const matches: JsonObject[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;
    if (candidate.id === "tako/takos") matches.push(candidate);
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  if (matches.length !== 1) {
    throw new Error("replica_production_export_canonical_listing_missing");
  }
  const listing = matches[0]!;
  assertExactObjectKeys(
    listing,
    PRODUCTION_EXPORT_COLUMNS,
    "replica_production_export_listing",
  );
  if (
    listing.id !== "tako/takos" ||
    listing.scope !== "tako" ||
    listing.slug !== "takos" ||
    listing.git !== "https://github.com/tako0614/takos.git" ||
    listing.status !== "visible" ||
    typeof listing.icon_url !== "string"
  ) {
    throw new Error("replica_production_export_listing_authority_mismatch");
  }
  for (const column of PRODUCTION_EXPORT_COLUMNS) {
    if (listing[column] !== null && typeof listing[column] !== "string") {
      throw new Error("replica_production_export_listing_value_invalid");
    }
  }
  assertNoReleaseCredentialOrPii(
    canonicalJson(listing),
    "replica_production_export_listing",
  );
  return listing;
}

function detectIconMediaType(bytes: Uint8Array): string {
  for (const mediaType of [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
  ]) {
    try {
      assertIconMediaType(bytes, mediaType, "replica_production_export_icon");
      return mediaType;
    } catch {
      // Try the next fixed safe image type.
    }
  }
  throw new Error("replica_production_export_icon_media_type_invalid");
}

async function readProductionIcon(options: {
  listing: JsonObject;
  policy: TargetPolicy;
  runner: WranglerRunner;
  cwd: string;
}): Promise<{
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sourceKind: "production-r2" | "public-https-reference";
  readonly sourceReferenceDigest: string;
}> {
  const iconUrl = new URL(String(options.listing.icon_url));
  if (
    iconUrl.protocol !== "https:" ||
    iconUrl.username ||
    iconUrl.password ||
    iconUrl.search ||
    iconUrl.hash
  ) {
    throw new Error("replica_production_export_icon_url_invalid");
  }
  const sourceReferenceDigest = digestJson({ href: iconUrl.href });
  if (iconUrl.origin === options.policy.origin.replace(/\/$/u, "")) {
    const match = /^\/icons\/([0-9a-f]{64})$/u.exec(iconUrl.pathname);
    if (!match) throw new Error("replica_production_export_r2_icon_invalid");
    const root = await mkdtemp(join(tmpdir(), "store-production-icon-"));
    await chmod(root, 0o700);
    try {
      const output = join(root, "icon.readback");
      options.runner(
        [
          "r2",
          "object",
          "get",
          `${options.policy.iconsBucketName}/icons/${match[1]}`,
          "--remote",
          "--file",
          output,
        ],
        { cwd: options.cwd },
      );
      const bytes = await readFile(output);
      if (sha256Bytes(bytes) !== `sha256:${match[1]}`) {
        throw new Error("replica_production_export_r2_icon_digest_mismatch");
      }
      const mediaType = detectIconMediaType(bytes);
      return {
        bytes,
        mediaType,
        sourceKind: "production-r2",
        sourceReferenceDigest,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  if (iconUrl.hostname !== "raw.githubusercontent.com") {
    throw new Error("replica_production_export_icon_host_not_allowed");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(iconUrl.href, {
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "image/png,image/jpeg,image/webp,image/svg+xml" },
    });
    if (!response.ok) {
      throw new Error(`replica_production_export_icon_http_${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 1024 * 1024) {
      throw new Error("replica_production_export_icon_too_large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) {
      throw new Error("replica_production_export_icon_size_invalid");
    }
    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    assertIconMediaType(bytes, mediaType, "replica_production_export_icon");
    assertNoReleaseCredentialOrPii(bytes, "replica_production_export_icon");
    return {
      bytes,
      mediaType,
      sourceKind: "public-https-reference",
      sourceReferenceDigest,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isInsidePath(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

/**
 * Release credentials and snapshot keys must remain operator-local: never in
 * the retained evidence tree and never anywhere below a Git worktree marker.
 */
export async function assertReleaseSecretFileLocation(
  pathInput: string,
  evidenceDirectory: string,
  label: string,
): Promise<string> {
  if (!isAbsolute(pathInput)) throw new Error(`${label}_path_not_absolute`);
  const path = await realpath(pathInput);
  const evidence = await realpath(evidenceDirectory);
  if (isInsidePath(path, evidence)) {
    throw new Error(`${label}_inside_evidence_forbidden`);
  }
  let directory = dirname(path);
  while (true) {
    try {
      const marker = await lstat(join(directory, ".git"));
      if (marker.isDirectory() || marker.isFile() || marker.isSymbolicLink()) {
        throw new Error(`${label}_inside_git_worktree_forbidden`);
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path;
}

async function assertCredentialFileLocations(
  accountEnvironment: string,
  tokenEnvironment: string,
  evidenceDirectory: string,
): Promise<void> {
  const accountPath = process.env[accountEnvironment];
  const tokenPath = process.env[tokenEnvironment];
  if (!accountPath || !tokenPath) {
    throw new Error("credential_file_reference_missing");
  }
  await assertReleaseSecretFileLocation(
    accountPath,
    evidenceDirectory,
    "release_account_credential",
  );
  await assertReleaseSecretFileLocation(
    tokenPath,
    evidenceDirectory,
    "release_token_credential",
  );
}

async function readSnapshotEncryptionKey(
  evidenceDirectory: string,
): Promise<Uint8Array> {
  const path = process.env[SNAPSHOT_KEY_ENV];
  if (!path?.startsWith("/")) {
    throw new Error("replica_snapshot_encryption_key_file_missing");
  }
  const authorizedPath = await assertReleaseSecretFileLocation(
    path,
    evidenceDirectory,
    "replica_snapshot_encryption_key",
  );
  const key = await readPrivateFile(authorizedPath, { maxBytes: 32 });
  if (key.byteLength !== 32) {
    throw new Error("replica_snapshot_encryption_key_invalid");
  }
  return key;
}

export interface SnapshotCryptoAuthority {
  readonly configFingerprint: string;
  readonly migrationPlanDigest: string;
  readonly productionTargetFingerprint: string;
}

function snapshotAad(
  envelope: ReleaseEnvelope,
  authority: SnapshotCryptoAuthority,
): Uint8Array {
  return Buffer.from(
    canonicalJson({
      kind: "takosumi.store-encrypted-replica-snapshot@v1",
      surfaceId: SURFACE_ID,
      releaseId: envelope.releaseId,
      sourceCommit: envelope.source.commit,
      controllerCommit: envelope.controllerSource.commit,
      replicaAdapterDigest: envelope.authority.replicaAdapterDigest,
      artifactDigests: envelope.candidate.artifactDigests,
      policyDigest: envelope.candidate.policyDigest,
      configFingerprint: authority.configFingerprint,
      migrationPlanDigest: authority.migrationPlanDigest,
      productionTargetFingerprint: authority.productionTargetFingerprint,
    }),
  );
}

export function encryptSnapshot(
  plaintext: Uint8Array,
  key: Uint8Array,
  envelope: ReleaseEnvelope,
  authority: SnapshotCryptoAuthority,
): JsonObject {
  const nonce = randomBytes(12);
  const aad = snapshotAad(envelope, authority);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    kind: "takosumi.store-encrypted-replica-snapshot@v1",
    algorithm: "AES-256-GCM",
    keyRef: "operator-local-store-replica-snapshot-v1",
    aadDigest: sha256Bytes(aad),
    nonceBase64: nonce.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    plaintextDigest: sha256Bytes(plaintext),
  };
}

export function decryptSnapshot(
  value: unknown,
  key: Uint8Array,
  envelope: ReleaseEnvelope,
  authority: SnapshotCryptoAuthority,
): Uint8Array {
  assertExactObjectKeys(
    value,
    [
      "kind",
      "algorithm",
      "keyRef",
      "aadDigest",
      "nonceBase64",
      "authTagBase64",
      "ciphertextBase64",
      "plaintextDigest",
    ],
    "replica_encrypted_snapshot",
  );
  if (
    value.kind !== "takosumi.store-encrypted-replica-snapshot@v1" ||
    value.algorithm !== "AES-256-GCM" ||
    value.keyRef !== "operator-local-store-replica-snapshot-v1"
  ) {
    throw new Error("replica_encrypted_snapshot_authority_mismatch");
  }
  const aad = snapshotAad(envelope, authority);
  if (value.aadDigest !== sha256Bytes(aad)) {
    throw new Error("replica_encrypted_snapshot_aad_mismatch");
  }
  const nonce = decodeBase64Exact(
    value.nonceBase64,
    "replica_encrypted_snapshot_nonce",
  );
  const authTag = decodeBase64Exact(
    value.authTagBase64,
    "replica_encrypted_snapshot_auth_tag",
  );
  const ciphertext = decodeBase64Exact(
    value.ciphertextBase64,
    "replica_encrypted_snapshot_ciphertext",
  );
  if (nonce.byteLength !== 12 || authTag.byteLength !== 16) {
    throw new Error("replica_encrypted_snapshot_parameter_invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (sha256Bytes(plaintext) !== value.plaintextDigest) {
      throw new Error("replica_encrypted_snapshot_plaintext_mismatch");
    }
    return plaintext;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "replica_encrypted_snapshot_plaintext_mismatch"
    ) {
      throw error;
    }
    throw new Error("replica_encrypted_snapshot_authentication_failed");
  }
}

export async function prepareReplicaInput(options: {
  envelope: ReleaseEnvelope;
  policy: TargetPolicy;
  manifest: StoreArtifactManifest;
  evidenceDirectory: string;
  runner: WranglerRunner;
  productionConfigPath: string;
}): Promise<{ readonly evidence: JsonObject; readonly bytes: Uint8Array }> {
  const subdomainPath =
    process.env.TAKOSUMI_RELEASE_REPLICA_WORKERS_SUBDOMAIN_FILE;
  if (!subdomainPath?.startsWith("/")) {
    throw new Error("replica_workers_subdomain_file_missing");
  }
  const workersSubdomain = (
    await readPrivateFile(subdomainPath, { maxBytes: 256 })
  )
    .toString("utf8")
    .trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(workersSubdomain)) {
    throw new Error("replica_workers_subdomain_invalid");
  }
  const replicaId = `store-${options.envelope.source.commit.slice(0, 8)}-${options.envelope.controllerSource.commit.slice(0, 6)}`;
  const workerName = `${replicaId}-worker`;
  const configPath = join(options.evidenceDirectory, REPLICA_CONFIG_FILE);
  let retainedConfig: ReplicaConfig | null = null;
  try {
    retainedConfig = (await readPrivateJson(
      configPath,
      options.evidenceDirectory,
    )) as ReplicaConfig;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
  }
  const createdAt = retainedConfig?.createdAt ?? new Date().toISOString();
  const expiresAt =
    retainedConfig?.expiresAt ??
    new Date(Date.parse(createdAt) + 6 * 60 * 60 * 1000).toISOString();
  const config: ReplicaConfig = {
    kind: "takosumi.store-release-replica-config@v1",
    surfaceId: SURFACE_ID,
    releaseId: options.envelope.releaseId,
    replicaId,
    createdAt,
    expiresAt,
    productionTarget: {
      accountId: options.policy.accountId,
      workerName: options.policy.workerName,
      databaseId: options.policy.databaseId,
      kvNamespaceId: options.policy.kvNamespaceId,
      iconsBucketName: options.policy.iconsBucketName,
      origin: options.policy.origin,
    },
    target: {
      accountId: options.policy.accountId,
      workerName,
      databaseName: `${replicaId}-db`,
      kvNamespaceName: `${replicaId}-kv`,
      iconsBucketName: `${replicaId}-icons`,
      origin: `https://${workerName}.${workersSubdomain}.workers.dev`,
    },
  };
  if (
    retainedConfig &&
    canonicalJson(retainedConfig) !== canonicalJson(config)
  ) {
    throw new Error("replica_input_retained_config_mismatch");
  }
  const configBytes = await retainExactJson(
    configPath,
    config,
    options.evidenceDirectory,
  );
  const snapshotCryptoAuthority: SnapshotCryptoAuthority = {
    configFingerprint: sha256Bytes(configBytes),
    migrationPlanDigest: options.manifest.digests.migrations,
    productionTargetFingerprint: digestJson(config.productionTarget),
  };
  const exportQuery = `SELECT ${PRODUCTION_EXPORT_COLUMNS.join(", ")} FROM listings WHERE id = 'tako/takos'`;
  const productionReadback = parseJsonOutput(
    options.runner(
      [
        "d1",
        "execute",
        options.policy.databaseName,
        "--remote",
        "--config",
        options.productionConfigPath,
        "--command",
        exportQuery,
        "--json",
      ],
      { cwd: options.evidenceDirectory },
    ),
    "replica_production_export",
  );
  const productionListing = findExactProductionListing(productionReadback);
  const productionIcon = await readProductionIcon({
    listing: productionListing,
    policy: options.policy,
    runner: options.runner,
    cwd: options.evidenceDirectory,
  });
  const iconBytes = productionIcon.bytes;
  const iconDigest = sha256Bytes(iconBytes);
  const iconKey = `icons/${iconDigest.slice("sha256:".length)}`;
  const sanitizedListing: JsonObject = {
    ...productionListing,
    icon_url: `{{TAKOSUMI_STORE_REPLICA_ORIGIN}}/${iconKey}`,
  };
  const snapshotSql = [
    "BEGIN;",
    `INSERT INTO listings (${PRODUCTION_EXPORT_COLUMNS.join(", ")})`,
    `VALUES (${PRODUCTION_EXPORT_COLUMNS.map((column) => sqlValue(sanitizedListing[column])).join(", ")});`,
    "COMMIT;",
  ].join("\n");
  const sqlBytes = Buffer.from(snapshotSql);
  const snapshot = {
    kind: "takosumi.store-sanitized-replica-bundle@v1",
    sqlBase64: sqlBytes.toString("base64"),
    sqlSha256: sha256Bytes(sqlBytes),
    icons: [
      {
        key: iconKey,
        mediaType: productionIcon.mediaType,
        bytesBase64: Buffer.from(iconBytes).toString("base64"),
        sha256: iconDigest,
      },
    ],
  };
  const snapshotPath = join(options.evidenceDirectory, REPLICA_SNAPSHOT_FILE);
  const snapshotPlaintext = Buffer.from(`${canonicalJson(snapshot)}\n`);
  const snapshotKey = await readSnapshotEncryptionKey(
    options.evidenceDirectory,
  );
  let snapshotCiphertextBytes: Uint8Array;
  try {
    snapshotCiphertextBytes = await readPrivateFile(snapshotPath, {
      expectedDirectory: options.evidenceDirectory,
      maxBytes: 64 * 1024 * 1024,
    });
    const retainedPlaintext = decryptSnapshot(
      JSON.parse(Buffer.from(snapshotCiphertextBytes).toString("utf8")),
      snapshotKey,
      options.envelope,
      snapshotCryptoAuthority,
    );
    if (!Buffer.from(retainedPlaintext).equals(snapshotPlaintext)) {
      throw new Error("replica_input_retained_snapshot_mismatch");
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
    snapshotCiphertextBytes = await writePrivateJson(
      snapshotPath,
      encryptSnapshot(
        snapshotPlaintext,
        snapshotKey,
        options.envelope,
        snapshotCryptoAuthority,
      ),
    );
  }
  const snapshotScan = scanSanitizedSnapshot(snapshotPlaintext, options.policy);
  const snapshotCiphertextDigest = sha256Bytes(snapshotCiphertextBytes);
  const encryptedSnapshot = JSON.parse(
    Buffer.from(snapshotCiphertextBytes).toString("utf8"),
  ) as JsonObject;
  const provenance = {
    kind: "takosumi.store-production-export-provenance@v1",
    status: "verified",
    surfaceId: SURFACE_ID,
    releaseId: options.envelope.releaseId,
    sourceCommit: options.envelope.source.commit,
    controllerCommit: options.envelope.controllerSource.commit,
    policyDigest: options.envelope.candidate.policyDigest,
    productionTargetFingerprint: digestJson(config.productionTarget),
    exportedAt: createdAt,
    source: {
      accountId: options.policy.accountId,
      databaseName: options.policy.databaseName,
      databaseId: options.policy.databaseId,
      queryDigest: sha256Bytes(Buffer.from(exportQuery)),
      rowDigest: digestJson(productionListing),
      rowCount: 1,
      iconSourceKind: productionIcon.sourceKind,
      iconSourceReferenceDigest: productionIcon.sourceReferenceDigest,
      iconDigest,
    },
    sanitization: {
      projection: "single-canonical-public-listing",
      includedColumns: PRODUCTION_EXPORT_COLUMNS,
      excludedTables: [
        "publishers",
        "sessions",
        "reports",
        "moderators",
        "durable_state",
      ],
      productionIdentityRewrite: "icon-url-to-replica-origin-placeholder",
      piiScan: "passed",
      secretScan: "passed",
      referentialIntegrity: "passed",
    },
    snapshotDigest: snapshotScan.snapshotDigest,
    snapshotCiphertextDigest,
    snapshotSqlDigest: snapshotScan.sqlDigest,
    snapshotScannerDigest: snapshotScan.scannerDigest,
    encryption: {
      algorithm: "AES-256-GCM",
      keyRef: "operator-local-store-replica-snapshot-v1",
      aadDigest: encryptedSnapshot.aadDigest,
      ciphertextDigest: snapshotCiphertextDigest,
      plaintextDigest: snapshotScan.snapshotDigest,
    },
  };
  const provenanceBytes = await retainExactJson(
    join(options.evidenceDirectory, PRODUCTION_EXPORT_PROVENANCE_FILE),
    provenance,
    options.evidenceDirectory,
  );
  const provenanceDigest = sha256Bytes(provenanceBytes);
  const evidence = {
    kind: "takosumi.store-release-replica-input@v1",
    status: "verified",
    surfaceId: SURFACE_ID,
    releaseId: options.envelope.releaseId,
    sourceCommit: options.envelope.source.commit,
    controllerCommit: options.envelope.controllerSource.commit,
    replicaAdapterDigest: options.envelope.authority.replicaAdapterDigest,
    replicaId,
    createdAt,
    expiresAt,
    configFile: REPLICA_CONFIG_FILE,
    snapshotFile: REPLICA_SNAPSHOT_FILE,
    snapshotCiphertextDigest,
    snapshotEncryption: "AES-256-GCM",
    provenanceFile: PRODUCTION_EXPORT_PROVENANCE_FILE,
    provenanceDigest,
    configFingerprint: sha256Bytes(configBytes),
    migrationPlanDigest: options.manifest.digests.migrations,
    snapshotDigest: snapshotScan.snapshotDigest,
    artifactDigests: options.envelope.candidate.artifactDigests,
    target: config.target,
    data: {
      source: "encrypted-anonymized-production-snapshot",
      piiScan: "passed",
      secretScan: "passed",
      referentialIntegrity: "passed",
      provenanceDigest,
    },
    productionFallback: false,
  };
  const bytes = await retainExactJson(
    join(options.evidenceDirectory, EVIDENCE_FILES["prepare-input"]),
    evidence,
    options.evidenceDirectory,
  );
  return { evidence, bytes };
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

function validateProductionExportProvenance(options: {
  value: unknown;
  bytes: Uint8Array;
  envelope: ReleaseEnvelope;
  config: ReplicaConfig;
  policy: TargetPolicy;
  snapshotScan: SanitizedSnapshotScan;
  snapshotCiphertextBytes: Uint8Array;
}): string {
  assertExactObjectKeys(
    options.value,
    [
      "kind",
      "status",
      "surfaceId",
      "releaseId",
      "sourceCommit",
      "controllerCommit",
      "policyDigest",
      "productionTargetFingerprint",
      "exportedAt",
      "source",
      "sanitization",
      "snapshotDigest",
      "snapshotCiphertextDigest",
      "snapshotSqlDigest",
      "snapshotScannerDigest",
      "encryption",
    ],
    "replica_production_export_provenance",
  );
  const provenance = options.value;
  assertExactObjectKeys(
    provenance.source,
    [
      "accountId",
      "databaseName",
      "databaseId",
      "queryDigest",
      "rowDigest",
      "rowCount",
      "iconSourceKind",
      "iconSourceReferenceDigest",
      "iconDigest",
    ],
    "replica_production_export_provenance_source",
  );
  assertExactObjectKeys(
    provenance.sanitization,
    [
      "projection",
      "includedColumns",
      "excludedTables",
      "productionIdentityRewrite",
      "piiScan",
      "secretScan",
      "referentialIntegrity",
    ],
    "replica_production_export_provenance_sanitization",
  );
  assertExactObjectKeys(
    provenance.encryption,
    ["algorithm", "keyRef", "aadDigest", "ciphertextDigest", "plaintextDigest"],
    "replica_production_export_provenance_encryption",
  );
  const encryptedSnapshot = JSON.parse(
    Buffer.from(options.snapshotCiphertextBytes).toString("utf8"),
  ) as JsonObject;
  const exportQuery = `SELECT ${PRODUCTION_EXPORT_COLUMNS.join(", ")} FROM listings WHERE id = 'tako/takos'`;
  const ciphertextDigest = sha256Bytes(options.snapshotCiphertextBytes);
  if (
    provenance.kind !== "takosumi.store-production-export-provenance@v1" ||
    provenance.status !== "verified" ||
    provenance.surfaceId !== SURFACE_ID ||
    provenance.releaseId !== options.envelope.releaseId ||
    provenance.sourceCommit !== options.envelope.source.commit ||
    provenance.controllerCommit !== options.envelope.controllerSource.commit ||
    provenance.policyDigest !== options.envelope.candidate.policyDigest ||
    provenance.productionTargetFingerprint !==
      digestJson(options.config.productionTarget) ||
    provenance.exportedAt !== options.config.createdAt ||
    !isRecord(provenance.source) ||
    provenance.source.accountId !== options.policy.accountId ||
    provenance.source.databaseName !== options.policy.databaseName ||
    provenance.source.databaseId !== options.policy.databaseId ||
    provenance.source.queryDigest !== sha256Bytes(Buffer.from(exportQuery)) ||
    provenance.source.rowCount !== 1 ||
    !new Set(["production-r2", "public-https-reference"]).has(
      String(provenance.source.iconSourceKind),
    ) ||
    !isRecord(provenance.sanitization) ||
    provenance.sanitization.projection !== "single-canonical-public-listing" ||
    canonicalJson(provenance.sanitization.includedColumns) !==
      canonicalJson(PRODUCTION_EXPORT_COLUMNS) ||
    canonicalJson(provenance.sanitization.excludedTables) !==
      canonicalJson([
        "publishers",
        "sessions",
        "reports",
        "moderators",
        "durable_state",
      ]) ||
    provenance.sanitization.productionIdentityRewrite !==
      "icon-url-to-replica-origin-placeholder" ||
    provenance.sanitization.piiScan !== "passed" ||
    provenance.sanitization.secretScan !== "passed" ||
    provenance.sanitization.referentialIntegrity !== "passed" ||
    provenance.snapshotDigest !== options.snapshotScan.snapshotDigest ||
    provenance.snapshotCiphertextDigest !== ciphertextDigest ||
    provenance.snapshotSqlDigest !== options.snapshotScan.sqlDigest ||
    provenance.snapshotScannerDigest !== options.snapshotScan.scannerDigest ||
    !isRecord(provenance.encryption) ||
    provenance.encryption.algorithm !== "AES-256-GCM" ||
    provenance.encryption.keyRef !==
      "operator-local-store-replica-snapshot-v1" ||
    provenance.encryption.aadDigest !== encryptedSnapshot.aadDigest ||
    provenance.encryption.ciphertextDigest !== ciphertextDigest ||
    provenance.encryption.plaintextDigest !==
      options.snapshotScan.snapshotDigest
  ) {
    throw new Error("replica_production_export_provenance_authority_mismatch");
  }
  for (const digest of [
    provenance.source.rowDigest,
    provenance.source.iconSourceReferenceDigest,
    provenance.source.iconDigest,
    provenance.encryption.aadDigest,
  ]) {
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      throw new Error("replica_production_export_provenance_digest_invalid");
    }
  }
  return sha256Bytes(options.bytes);
}

function validateReplicaInputEvidence(options: {
  value: unknown;
  envelope: ReleaseEnvelope;
  config: ReplicaConfig;
  manifest: StoreArtifactManifest;
  snapshotScan: SanitizedSnapshotScan;
  snapshotCiphertextDigest: string;
  provenanceDigest: string;
}): void {
  assertExactObjectKeys(
    options.value,
    [
      "kind",
      "status",
      "surfaceId",
      "releaseId",
      "sourceCommit",
      "controllerCommit",
      "replicaAdapterDigest",
      "replicaId",
      "createdAt",
      "expiresAt",
      "configFile",
      "snapshotFile",
      "snapshotCiphertextDigest",
      "snapshotEncryption",
      "provenanceFile",
      "provenanceDigest",
      "configFingerprint",
      "migrationPlanDigest",
      "snapshotDigest",
      "artifactDigests",
      "target",
      "data",
      "productionFallback",
    ],
    "replica_input_evidence",
  );
  assertExactObjectKeys(
    options.value.data,
    [
      "source",
      "piiScan",
      "secretScan",
      "referentialIntegrity",
      "provenanceDigest",
    ],
    "replica_input_evidence_data",
  );
  if (
    options.value.kind !== "takosumi.store-release-replica-input@v1" ||
    options.value.status !== "verified" ||
    options.value.surfaceId !== SURFACE_ID ||
    options.value.releaseId !== options.envelope.releaseId ||
    options.value.sourceCommit !== options.envelope.source.commit ||
    options.value.controllerCommit !==
      options.envelope.controllerSource.commit ||
    options.value.replicaAdapterDigest !==
      options.envelope.authority.replicaAdapterDigest ||
    options.value.replicaId !== options.config.replicaId ||
    options.value.createdAt !== options.config.createdAt ||
    options.value.expiresAt !== options.config.expiresAt ||
    options.value.configFile !== REPLICA_CONFIG_FILE ||
    options.value.snapshotFile !== REPLICA_SNAPSHOT_FILE ||
    options.value.snapshotCiphertextDigest !==
      options.snapshotCiphertextDigest ||
    options.value.snapshotEncryption !== "AES-256-GCM" ||
    options.value.provenanceFile !== PRODUCTION_EXPORT_PROVENANCE_FILE ||
    options.value.provenanceDigest !== options.provenanceDigest ||
    options.value.configFingerprint !==
      options.envelope.replica.configFingerprint ||
    options.value.migrationPlanDigest !== options.manifest.digests.migrations ||
    options.value.snapshotDigest !== options.snapshotScan.snapshotDigest ||
    canonicalJson(options.value.artifactDigests) !==
      canonicalJson(options.envelope.candidate.artifactDigests) ||
    canonicalJson(options.value.target) !==
      canonicalJson(options.config.target) ||
    !isRecord(options.value.data) ||
    options.value.data.source !== "encrypted-anonymized-production-snapshot" ||
    options.value.data.piiScan !== "passed" ||
    options.value.data.secretScan !== "passed" ||
    options.value.data.referentialIntegrity !== "passed" ||
    options.value.data.provenanceDigest !== options.provenanceDigest ||
    options.value.productionFallback !== false
  ) {
    throw new Error("replica_input_evidence_authority_mismatch");
  }
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
    const checks = replicaHealthChecks(target, options.envelope);
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

function findCanonicalReplicaListing(value: unknown): JsonObject | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCanonicalReplicaListing(entry);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.id === "tako/takos") return value;
  for (const child of Object.values(value)) {
    const found = findCanonicalReplicaListing(child);
    if (found) return found;
  }
  return null;
}

export async function verifyReplicaStoragePreserved(options: {
  inventory: Inventory;
  runner: WranglerRunner;
  cwd: string;
  manifest: StoreArtifactManifest;
  snapshotScan: SanitizedSnapshotScan;
  cloudflareReadClient: CloudflareReadClient;
}): Promise<string> {
  const target = options.inventory.target;
  const liveDatabaseId = exactD1DatabaseId(
    options.runner(["d1", "list", "--json"], { cwd: options.cwd }),
    target.databaseName,
    target.databaseId,
  );
  if (liveDatabaseId !== target.databaseId) {
    throw new Error("replica_forward_repair_d1_storage_missing");
  }
  const liveKvNamespaceId = exactKvNamespaceId(
    options.runner(["kv", "namespace", "list"], { cwd: options.cwd }),
    target.kvNamespaceName,
    target.kvNamespaceId,
  );
  if (liveKvNamespaceId !== target.kvNamespaceId) {
    throw new Error("replica_forward_repair_kv_storage_missing");
  }
  const buckets = await listR2Buckets(
    options.cloudflareReadClient,
    target.iconsBucketName,
  );
  if (buckets.length !== 1 || buckets[0]?.name !== target.iconsBucketName) {
    throw new Error("replica_forward_repair_r2_storage_missing");
  }
  const migrations = options.runner(
    [
      "d1",
      "migrations",
      "list",
      target.databaseName,
      "--remote",
      "--config",
      "wrangler.toml",
    ],
    { cwd: options.cwd },
  );
  assertMigrationReadback(migrations, options.manifest.migrations.length);
  const migrationLineage = parseJsonOutput(
    options.runner(
      [
        "d1",
        "execute",
        target.databaseName,
        "--remote",
        "--config",
        "wrangler.toml",
        "--command",
        "SELECT name FROM d1_migrations ORDER BY id",
        "--json",
      ],
      { cwd: options.cwd },
    ),
    "replica_forward_repair_migration_lineage",
  );
  if (!migrationLineageMatches(migrationLineage, options.manifest)) {
    throw new Error("replica_forward_repair_migration_lineage_mismatch");
  }
  const listingReadback = parseJsonOutput(
    options.runner(
      [
        "d1",
        "execute",
        target.databaseName,
        "--remote",
        "--config",
        "wrangler.toml",
        "--command",
        "SELECT id, icon_url FROM listings WHERE id = 'tako/takos'",
        "--json",
      ],
      { cwd: options.cwd },
    ),
    "replica_forward_repair_catalog_readback",
  );
  const listing = findCanonicalReplicaListing(listingReadback);
  const expectedIconUrl = `${target.origin.replace(/\/$/u, "")}/${options.snapshotScan.icons[0]?.key ?? ""}`;
  if (
    !listing ||
    listing.id !== "tako/takos" ||
    listing.icon_url !== expectedIconUrl
  ) {
    throw new Error("replica_forward_repair_catalog_canary_mismatch");
  }
  const remoteObjects = await listAllR2Objects(
    options.cloudflareReadClient,
    target.iconsBucketName,
  );
  const remoteKeys = remoteObjects.map((entry) => String(entry.key)).sort();
  const expectedKeys = options.snapshotScan.icons
    .map((icon) => icon.key)
    .sort();
  if (canonicalJson(remoteKeys) !== canonicalJson(expectedKeys)) {
    throw new Error("replica_forward_repair_r2_object_inventory_mismatch");
  }
  const readbackRoot = await mkdtemp(
    join(tmpdir(), "takosumi-store-replica-storage-readback-"),
  );
  await chmod(readbackRoot, 0o700);
  const icons: JsonObject[] = [];
  try {
    for (const [index, icon] of options.snapshotScan.icons.entries()) {
      const readback = join(readbackRoot, `${index}.readback`);
      options.runner(
        [
          "r2",
          "object",
          "get",
          `${target.iconsBucketName}/${icon.key}`,
          "--remote",
          "--file",
          readback,
        ],
        { cwd: options.cwd },
      );
      const digest = sha256Bytes(await readFile(readback));
      if (digest !== icon.sha256) {
        throw new Error("replica_forward_repair_icon_digest_mismatch");
      }
      icons.push({ key: icon.key, sha256: digest, mediaType: icon.mediaType });
    }
  } finally {
    await rm(readbackRoot, { recursive: true, force: true });
  }
  return digestJson({
    kind: "takosumi.store-replica-storage-preservation@v1",
    database: { name: target.databaseName, id: liveDatabaseId },
    kvNamespace: { name: target.kvNamespaceName, id: liveKvNamespaceId },
    r2Bucket: { name: target.iconsBucketName },
    migrationLineageDigest: digestJson(migrationLineage),
    catalogCanaryDigest: digestJson(listing),
    iconReadbackDigest: digestJson(icons),
  });
}

async function verifyForwardRepairResumeState(options: {
  envelope: ReleaseEnvelope;
  target: TargetPolicy;
  runner: WranglerRunner;
  cloudflareReadClient: CloudflareReadClient;
  cwd: string;
  operationPath: string;
  evidenceDirectory: string;
}): Promise<string> {
  let operation: JsonObject | null = null;
  try {
    operation = validateForwardRepairOperation(
      await readPrivateJson(options.operationPath, options.evidenceDirectory),
      options.envelope,
      options.target,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
  }
  const versionsResult = inspectRemote(
    options.runner,
    ["versions", "list", "--name", options.target.workerName, "--json"],
    options.cwd,
  );
  const versions =
    versionsResult.status === "not-found"
      ? []
      : parseJsonOutput(
          versionsResult.stdout,
          "replica_forward_repair_resume_versions",
        );
  if (!Array.isArray(versions)) {
    throw new Error("replica_forward_repair_resume_versions_invalid");
  }
  const subdomainPresent = await scriptSubdomainPresent(
    options.cloudflareReadClient,
    options.target.workerName,
  );
  if (
    !operation ||
    !["version-uploaded", "deployed", "verified"].includes(
      String(operation.phase),
    )
  ) {
    if (versions.length !== 0 || subdomainPresent) {
      throw new Error("replica_forward_repair_intervening_worker_present");
    }
    return digestJson({
      kind: "takosumi.store-replica-forward-repair-resume-readback@v1",
      state: "worker-absent",
      versions: [],
      subdomainPresent: false,
      operationDigest: operation ? digestJson(operation) : null,
    });
  }
  const expectedVersionId = String(operation.versionId);
  if (
    versions.length !== 1 ||
    !isRecord(versions[0]) ||
    versions[0].id !== expectedVersionId
  ) {
    throw new Error("replica_forward_repair_resume_version_mismatch");
  }
  const deploymentResult = inspectRemote(
    options.runner,
    [
      "deployments",
      "status",
      "--name",
      options.target.workerName,
      "--config",
      "wrangler.toml",
      "--json",
    ],
    options.cwd,
  );
  const deployment =
    deploymentResult.status === "not-found"
      ? { versions: [] }
      : parseJsonOutput(
          deploymentResult.stdout,
          "replica_forward_repair_resume_deployment",
        );
  const exactDeployment = deploymentHasExactVersionAtFullTraffic(
    deployment,
    expectedVersionId,
  );
  if (
    (["deployed", "verified"].includes(String(operation.phase)) &&
      !exactDeployment) ||
    (String(operation.phase) === "version-uploaded" &&
      !exactDeployment &&
      (!isRecord(deployment) ||
        !Array.isArray(deployment.versions) ||
        deployment.versions.length !== 0)) ||
    (subdomainPresent && !exactDeployment)
  ) {
    throw new Error("replica_forward_repair_resume_deployment_mismatch");
  }
  return digestJson({
    kind: "takosumi.store-replica-forward-repair-resume-readback@v1",
    state: exactDeployment ? "candidate-deployed" : "candidate-uploaded",
    versionId: expectedVersionId,
    deploymentDigest: digestJson(deployment),
    subdomainPresent,
    operationDigest: digestJson(operation),
  });
}

export async function rehearseForwardRepair(options: {
  envelope: ReleaseEnvelope;
  config: ReplicaConfig;
  artifactRoot: string;
  manifest: StoreArtifactManifest;
  runner: WranglerRunner;
  evidenceDirectory: string;
  snapshotScan: SanitizedSnapshotScan;
  readbackListingPath: string;
  cloudflareReadClient: CloudflareReadClient;
  initialInventory: Inventory;
}): Promise<Inventory> {
  const progressPath = join(
    options.evidenceDirectory,
    FORWARD_REPAIR_PROGRESS_FILE,
  );
  const operationPath = join(
    options.evidenceDirectory,
    FORWARD_REPAIR_OPERATION_FILE,
  );
  const inventoryPath = join(
    options.evidenceDirectory,
    EVIDENCE_FILES.rehearse,
  );
  const evidencePath = join(
    options.evidenceDirectory,
    FORWARD_REPAIR_EVIDENCE_FILE,
  );
  const initialInventoryDigest = digestJson(options.initialInventory);
  const removedVersionId = options.initialInventory.target.versionId;
  let progress: ForwardRepairProgress;
  try {
    progress = validateForwardRepairProgress(
      await readPrivateJson(progressPath, options.evidenceDirectory),
      options.envelope,
      options.config,
      options.initialInventory,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
    const initialRemoteEvidence = await attestReplicaRemote({
      envelope: options.envelope,
      inventory: options.initialInventory,
      artifactRoot: options.artifactRoot,
      manifest: options.manifest,
      runner: options.runner,
      snapshotScan: options.snapshotScan,
      readbackListingPath: options.readbackListingPath,
      cloudflareReadClient: options.cloudflareReadClient,
    });
    if (
      canonicalJson(initialRemoteEvidence) !==
      canonicalJson(options.initialInventory.remoteEvidence)
    ) {
      throw new Error("replica_pre_rehearsal_inventory_readback_mismatch");
    }
    progress = {
      kind: "takosumi.store-replica-forward-repair-progress@v1",
      status: "intent-recorded",
      surfaceId: SURFACE_ID,
      releaseId: options.envelope.releaseId,
      replicaId: options.config.replicaId,
      initialInventoryDigest,
      target: options.initialInventory.target,
      removedVersionId,
    };
    await writePrivateJson(progressPath, progress);
  }
  const releaseRoot = await mkdtemp(
    join(tmpdir(), "takosumi-store-replica-forward-repair-"),
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
        { target: options.initialInventory.target },
        options.initialInventory.target.databaseId,
        options.initialInventory.target.kvNamespaceId,
      ),
      { mode: 0o400, flag: "wx" },
    );
    const target: TargetPolicy = {
      configPath: "replica-generated.toml",
      accountId: options.initialInventory.accountId,
      workerName: options.initialInventory.target.workerName,
      origin: options.initialInventory.target.origin,
      databaseName: options.initialInventory.target.databaseName,
      databaseId: options.initialInventory.target.databaseId,
      kvNamespaceId: options.initialInventory.target.kvNamespaceId,
      iconsBucketName: options.initialInventory.target.iconsBucketName,
      publishCapability: false,
      compatibilityDate: "2026-06-25",
      compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
      requiredVarNames: ["APP_URL"],
      requiredSecretNames: [],
      customDomainHostname: new URL(options.initialInventory.target.origin)
        .hostname,
      readbackListingPath: options.readbackListingPath,
    };
    let workerAbsenceDigest: string;
    if (progress.status === "intent-recorded") {
      const versionPresent = workerVersionPresent(
        options.runner,
        releaseRoot,
        options.initialInventory.target.workerName,
        removedVersionId,
      );
      const subdomainPresent = await scriptSubdomainPresent(
        options.cloudflareReadClient,
        options.initialInventory.target.workerName,
      );
      if (versionPresent !== subdomainPresent) {
        throw new Error("replica_failure_injection_worker_state_ambiguous");
      }
      if (versionPresent) {
        options.runner(
          ["delete", options.initialInventory.target.workerName, "--force"],
          { cwd: releaseRoot },
        );
      }
      const versionAbsent = !workerVersionPresent(
        options.runner,
        releaseRoot,
        options.initialInventory.target.workerName,
      );
      const subdomainAbsent = !(await scriptSubdomainPresent(
        options.cloudflareReadClient,
        options.initialInventory.target.workerName,
      ));
      if (!versionAbsent || !subdomainAbsent) {
        throw new Error("replica_failure_injection_worker_still_present");
      }
      workerAbsenceDigest = digestJson({
        kind: "takosumi.store-replica-worker-absence@v1",
        workerName: options.initialInventory.target.workerName,
        removedVersionId,
        versionAbsent,
        subdomainAbsent,
      });
      const storagePreservationDigest = await verifyReplicaStoragePreserved({
        inventory: options.initialInventory,
        runner: options.runner,
        cwd: releaseRoot,
        manifest: options.manifest,
        snapshotScan: options.snapshotScan,
        cloudflareReadClient: options.cloudflareReadClient,
      });
      progress = {
        ...progress,
        status: "worker-absent",
        workerAbsenceDigest,
        storagePreservationDigest,
      };
      await writePrivateJson(progressPath, progress, { replace: true });
    }
    if (progress.status === "repaired") {
      const repairedInventory = validateInventory(
        await readPrivateJson(inventoryPath, options.evidenceDirectory),
        options.envelope,
        options.config,
        { requireRehearsal: true },
      );
      const failureEvidenceBytes = await readPrivateFile(evidencePath, {
        expectedDirectory: options.evidenceDirectory,
      });
      const failureRehearsalDigest = sha256Bytes(failureEvidenceBytes);
      if (
        repairedInventory.remoteEvidence.failureRehearsalDigest !==
          failureRehearsalDigest ||
        progress.recoveredVersionId !== repairedInventory.target.versionId ||
        progress.recoveredDeploymentDigest !==
          repairedInventory.remoteEvidence.deploymentDigest
      ) {
        throw new Error("replica_forward_repair_retained_evidence_mismatch");
      }
      validateForwardRepairEvidence(
        JSON.parse(failureEvidenceBytes.toString("utf8")),
        options.envelope,
        options.config,
        repairedInventory,
        options.initialInventory,
        progress,
      );
      return repairedInventory;
    }
    workerAbsenceDigest = String(progress.workerAbsenceDigest);
    const resumeReadbackDigest = await verifyForwardRepairResumeState({
      envelope: options.envelope,
      target,
      runner: options.runner,
      cloudflareReadClient: options.cloudflareReadClient,
      cwd: releaseRoot,
      operationPath,
      evidenceDirectory: options.evidenceDirectory,
    });
    const storagePreservationDigest = await verifyReplicaStoragePreserved({
      inventory: options.initialInventory,
      runner: options.runner,
      cwd: releaseRoot,
      manifest: options.manifest,
      snapshotScan: options.snapshotScan,
      cloudflareReadClient: options.cloudflareReadClient,
    });
    if (storagePreservationDigest !== progress.storagePreservationDigest) {
      throw new Error("replica_forward_repair_storage_preservation_drift");
    }
    const genericChecks = replicaHealthChecks(target, options.envelope);
    const repairRunner = ((
      args: readonly string[],
      runnerOptions: { cwd: string },
    ): string => {
      if (args[0] === "deployments" && args[1] === "status") {
        const result = inspectRemote(options.runner, args, runnerOptions.cwd);
        if (result.status === "not-found") return '{"versions":[]}';
        return result.stdout;
      }
      return options.runner(args, runnerOptions);
    }) as WranglerRunner;
    repairRunner.inspect = options.runner.inspect?.bind(options.runner);
    const readback = await deploySealedStore({
      runner: repairRunner,
      cwd: releaseRoot,
      target,
      envelope: options.envelope,
      manifest: options.manifest,
      candidateChecks: genericChecks,
      deployTriggers: true,
      readTopology: () =>
        readRuntimeTopology(
          options.cloudflareReadClient,
          target,
          "workers-dev",
        ),
      journal: {
        path: operationPath,
        environment: "replica-forward-repair",
        targetFingerprint: digestJson(target),
      },
    });
    if (readback.versionId === removedVersionId) {
      throw new Error("replica_forward_repair_reused_removed_version");
    }
    let verifiedAt = new Date().toISOString();
    try {
      const retained = await readPrivateJson<JsonObject>(
        evidencePath,
        options.evidenceDirectory,
      );
      if (typeof retained.verifiedAt !== "string") {
        throw new Error("replica_forward_repair_verified_at_invalid");
      }
      verifiedAt = retained.verifiedAt;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
        throw error;
      }
    }
    const failureEvidence = {
      kind: "takosumi.store-replica-forward-repair-rehearsal@v1",
      status: "passed",
      surfaceId: SURFACE_ID,
      releaseId: options.envelope.releaseId,
      replicaId: options.config.replicaId,
      sourceCommit: options.envelope.source.commit,
      strategy: "forward-repair-after-database-mutation",
      configFingerprint: options.envelope.replica.configFingerprint,
      migrationPlanDigest: options.envelope.replica.migrationPlanDigest,
      snapshotDigest: options.snapshotScan.snapshotDigest,
      initialInventoryDigest: digestJson(options.initialInventory),
      injectedFailure: "replica-worker-removed-after-schema",
      failureInjection: {
        removedVersionId,
        workerAbsenceDigest,
        resumeReadbackDigest,
        storagePreservationDigest,
      },
      forwardRepair: {
        versionDigest: digestJson(readback.version),
        deploymentDigest: digestJson(readback.deployments),
        migrationLineageDigest: digestJson(readback.migrationLineage),
        topologyDigest: digestJson(readback.topology),
        verifiedAt,
      },
      recoveredVersionId: readback.versionId,
      recoveredDeploymentDigest: digestJson(readback.deployments),
      verifiedAt,
    } as const;
    const failureEvidenceBytes = await retainExactJson(
      evidencePath,
      failureEvidence,
      options.evidenceDirectory,
    );
    const failureRehearsalDigest = sha256Bytes(failureEvidenceBytes);
    const checks = replicaHealthChecks(
      target,
      options.envelope,
      failureRehearsalDigest,
    );
    const repairedInventory: Inventory = {
      ...options.initialInventory,
      target: {
        ...options.initialInventory.target,
        versionId: readback.versionId,
      },
      checks,
      remoteEvidence: {
        versionDigest: digestJson(readback.version),
        deploymentDigest: digestJson(readback.deployments),
        migrationLineageDigest: digestJson(readback.migrationLineage),
        snapshotDigest: options.snapshotScan.snapshotDigest,
        snapshotSqlDigest: options.snapshotScan.sqlDigest,
        snapshotScannerDigest: options.snapshotScan.scannerDigest,
        iconReadbackDigest:
          options.initialInventory.remoteEvidence.iconReadbackDigest,
        topologyDigest: digestJson(readback.topology),
        preflightAbsenceDigest:
          options.initialInventory.remoteEvidence.preflightAbsenceDigest,
        failureRehearsalDigest,
      },
    };
    validateForwardRepairEvidence(
      failureEvidence,
      options.envelope,
      options.config,
      repairedInventory,
      options.initialInventory,
      progress,
    );
    validateInventory(repairedInventory, options.envelope, options.config, {
      requireRehearsal: true,
    });
    await retainExactJson(
      inventoryPath,
      repairedInventory,
      options.evidenceDirectory,
    );
    progress = {
      ...progress,
      status: "repaired",
      recoveredVersionId: readback.versionId,
      recoveredDeploymentDigest: digestJson(readback.deployments),
    };
    await writePrivateJson(progressPath, progress, { replace: true });
    return repairedInventory;
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
  failureRehearsalDigest?: string;
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
    const checks = replicaHealthChecks(
      target,
      options.envelope,
      options.failureRehearsalDigest,
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
      preflightAbsenceDigest:
        options.inventory.remoteEvidence.preflightAbsenceDigest,
      ...(options.failureRehearsalDigest
        ? { failureRehearsalDigest: options.failureRehearsalDigest }
        : {}),
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
  const evidenceDirectory = await realpath(envelope.evidence.directory);
  if (dirname(envelopePath) !== evidenceDirectory)
    throw new Error("replica_evidence_directory_mismatch");
  const artifact = await verifyArtifact(envelope.evidence.directory, envelope);
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
  if (action === "prepare-input") {
    await assertCredentialFileLocations(
      "TAKOSUMI_RELEASE_REPLICA_SOURCE_ACCOUNT_ID_FILE",
      "TAKOSUMI_RELEASE_REPLICA_SOURCE_API_TOKEN_FILE",
      evidenceDirectory,
    );
    const productionCredentials = await readCredentialFiles(
      "TAKOSUMI_RELEASE_REPLICA_SOURCE_ACCOUNT_ID_FILE",
      "TAKOSUMI_RELEASE_REPLICA_SOURCE_API_TOKEN_FILE",
      policy.policy.production.accountId,
    );
    const productionConfigPath = await realpath(
      join(parent.operatorRoot, policy.policy.production.configPath),
    );
    if (!productionConfigPath.startsWith(`${parent.operatorRoot}/`)) {
      throw new Error("replica_production_config_path_invalid");
    }
    const productionRunner =
      options.runner ??
      createWranglerRunner({
        wranglerEntrypoint: toolchain.wranglerEntrypoint,
        accountId: productionCredentials.accountId,
        apiToken: productionCredentials.apiToken,
      });
    const prepared = await prepareReplicaInput({
      envelope,
      policy: policy.policy.production,
      manifest: artifact.manifest,
      evidenceDirectory,
      runner: productionRunner,
      productionConfigPath,
    });
    return actionResult(
      action,
      envelope,
      prepared.bytes,
      digestJson(prepared.evidence),
    );
  }
  const configPath = process.env.TAKOSUMI_RELEASE_REPLICA_RUNTIME_CONFIG_FILE;
  const snapshotPath =
    process.env.TAKOSUMI_RELEASE_REPLICA_SANITIZED_SNAPSHOT_FILE;
  if (!configPath?.startsWith("/") || !snapshotPath?.startsWith("/")) {
    throw new Error("replica_config_or_snapshot_file_missing");
  }
  if (
    (await realpath(configPath)) !==
      join(evidenceDirectory, REPLICA_CONFIG_FILE) ||
    (await realpath(snapshotPath)) !==
      join(evidenceDirectory, REPLICA_SNAPSHOT_FILE)
  ) {
    throw new Error("replica_config_or_snapshot_path_not_fixed");
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
  const snapshotCiphertextBytes = await readPrivateFile(snapshotPath, {
    maxBytes: 64 * 1024 * 1024,
  });
  if (
    sha256Bytes(snapshotCiphertextBytes) !==
    (envelope.replica.data as JsonObject).snapshotCiphertextDigest
  ) {
    throw new Error("replica_snapshot_ciphertext_digest_mismatch");
  }
  const snapshotKey = await readSnapshotEncryptionKey(evidenceDirectory);
  const snapshotBytes = decryptSnapshot(
    JSON.parse(Buffer.from(snapshotCiphertextBytes).toString("utf8")),
    snapshotKey,
    envelope,
    {
      configFingerprint: envelope.replica.configFingerprint as string,
      migrationPlanDigest: envelope.replica.migrationPlanDigest as string,
      productionTargetFingerprint: digestJson(config.productionTarget),
    },
  );
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
  if (
    artifact.manifest.digests.migrations !==
    envelope.replica.migrationPlanDigest
  ) {
    throw new Error("replica_migration_plan_digest_mismatch");
  }
  const provenancePath = join(
    evidenceDirectory,
    PRODUCTION_EXPORT_PROVENANCE_FILE,
  );
  const provenanceBytes = await readPrivateFile(provenancePath, {
    expectedDirectory: evidenceDirectory,
  });
  const provenanceDigest = validateProductionExportProvenance({
    value: JSON.parse(Buffer.from(provenanceBytes).toString("utf8")),
    bytes: provenanceBytes,
    envelope,
    config,
    policy: policy.policy.production,
    snapshotScan,
    snapshotCiphertextBytes,
  });
  if (
    provenanceDigest !== (envelope.replica.data as JsonObject).provenanceDigest
  ) {
    throw new Error("replica_production_export_provenance_digest_mismatch");
  }
  const inputEvidenceBytes = await readPrivateFile(
    join(evidenceDirectory, EVIDENCE_FILES["prepare-input"]),
    { expectedDirectory: evidenceDirectory },
  );
  if (
    sha256Bytes(inputEvidenceBytes) !== envelope.replica.inputEvidenceDigest
  ) {
    throw new Error("replica_input_evidence_digest_mismatch");
  }
  validateReplicaInputEvidence({
    value: JSON.parse(Buffer.from(inputEvidenceBytes).toString("utf8")),
    envelope,
    config,
    manifest: artifact.manifest,
    snapshotScan,
    snapshotCiphertextDigest: sha256Bytes(snapshotCiphertextBytes),
    provenanceDigest,
  });
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
    snapshotCiphertextDigest: (envelope.replica.data as JsonObject)
      .snapshotCiphertextDigest,
    provenanceDigest: (envelope.replica.data as JsonObject).provenanceDigest,
    inputEvidenceDigest: envelope.replica.inputEvidenceDigest,
    target: config.target,
    productionFallback: false,
  };
  if (action === "plan") {
    const bytes = await writePrivateJson(
      join(evidenceDirectory, EVIDENCE_FILES.plan),
      plan,
    );
    return actionResult(action, envelope, bytes, digestJson(plan));
  }
  await assertCredentialFileLocations(
    "TAKOSUMI_RELEASE_REPLICA_ACCOUNT_ID_FILE",
    "TAKOSUMI_RELEASE_REPLICA_API_TOKEN_FILE",
    evidenceDirectory,
  );
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
  const progressPath = join(evidenceDirectory, PROGRESS_FILE);
  if (action === "rehearse") {
    const initialInventory = validateInventory(
      await readPrivateJson(
        join(evidenceDirectory, EVIDENCE_FILES.provision),
        evidenceDirectory,
      ),
      envelope,
      config,
    );
    const repairedInventory = await rehearseForwardRepair({
      envelope,
      config,
      artifactRoot: artifact.root,
      manifest: artifact.manifest,
      runner,
      evidenceDirectory,
      snapshotScan,
      readbackListingPath: policy.policy.production.readbackListingPath,
      cloudflareReadClient,
      initialInventory,
    });
    let progress = validateProgress(
      await readPrivateJson(progressPath, evidenceDirectory),
      envelope,
      config,
    );
    progress = updateResource(progress, "worker", {
      id: repairedInventory.target.versionId,
      state: "present",
    });
    progress = {
      ...progress,
      status: "provisioned",
      completedSteps: [
        ...new Set([
          ...progress.completedSteps,
          `forward-repair:${repairedInventory.remoteEvidence.failureRehearsalDigest}`,
        ]),
      ],
    };
    await writeProgress(progressPath, progress);
    const bytes = await retainExactJson(
      join(evidenceDirectory, EVIDENCE_FILES.rehearse),
      repairedInventory,
      evidenceDirectory,
    );
    return actionResult(action, envelope, bytes, digestJson(repairedInventory));
  }
  const inventoryPath = join(evidenceDirectory, EVIDENCE_FILES.rehearse);
  if (action === "cleanup-plan") {
    const inventory = validateInventory(
      await readPrivateJson(inventoryPath, evidenceDirectory),
      envelope,
      config,
      { requireRehearsal: true },
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
    const initialInventory = validateInventory(
      await readPrivateJson(
        join(evidenceDirectory, EVIDENCE_FILES.provision),
        evidenceDirectory,
      ),
      envelope,
      config,
    );
    const inventory = validateInventory(
      await readPrivateJson(inventoryPath, evidenceDirectory),
      envelope,
      config,
      { requireRehearsal: true },
    );
    const forwardProgress = validateForwardRepairProgress(
      await readPrivateJson(
        join(evidenceDirectory, FORWARD_REPAIR_PROGRESS_FILE),
        evidenceDirectory,
      ),
      envelope,
      config,
      initialInventory,
    );
    if (forwardProgress.status !== "repaired") {
      throw new Error("replica_forward_repair_progress_incomplete");
    }
    const failureEvidencePath = join(
      evidenceDirectory,
      FORWARD_REPAIR_EVIDENCE_FILE,
    );
    const failureEvidenceBytes = await readPrivateFile(failureEvidencePath, {
      expectedDirectory: evidenceDirectory,
    });
    const failureEvidenceDigest = sha256Bytes(failureEvidenceBytes);
    if (
      inventory.remoteEvidence.failureRehearsalDigest !== failureEvidenceDigest
    ) {
      throw new Error("replica_failure_rehearsal_digest_mismatch");
    }
    const failureEvidence = validateForwardRepairEvidence(
      JSON.parse(failureEvidenceBytes.toString("utf8")),
      envelope,
      config,
      inventory,
      initialInventory,
      forwardProgress,
    );
    const attestationPath = join(evidenceDirectory, EVIDENCE_FILES.attest);
    const verifiedAt = await resolveReplicaAttestationVerifiedAt({
      path: attestationPath,
      evidenceDirectory,
      envelope,
      config,
      inventory,
      failureRehearsalDigest: failureEvidenceDigest,
      failureVerifiedAt: failureEvidence.verifiedAt,
    });
    const liveRemoteEvidence = await attestReplicaRemote({
      envelope,
      inventory,
      artifactRoot: artifact.root,
      manifest: artifact.manifest,
      runner,
      snapshotScan,
      readbackListingPath: policy.policy.production.readbackListingPath,
      cloudflareReadClient,
      failureRehearsalDigest: failureEvidenceDigest,
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
      replicaId: config.replicaId,
      accessPolicy: "replica-only-no-production-fallback",
      createdAt: config.createdAt,
      verifiedAt,
      expiresAt: config.expiresAt,
      configFingerprint: sha256Bytes(configBytes),
      migrationPlanDigest: artifact.manifest.digests.migrations,
      targetInventoryDigest,
      artifactDigests: envelope.candidate.artifactDigests,
      checks: inventory.checks.map((check) => ({
        ...check,
        status: "passed",
      })),
      failureRehearsal: {
        status: "passed",
        strategy: "forward-repair-after-database-mutation",
        bindingDigest: failureEvidenceDigest,
      },
      data: {
        source: "encrypted-anonymized-production-snapshot",
        snapshotDigest: snapshotScan.snapshotDigest,
        snapshotCiphertextDigest: (envelope.replica.data as JsonObject)
          .snapshotCiphertextDigest,
        provenanceDigest: (envelope.replica.data as JsonObject)
          .provenanceDigest,
        piiScan: "passed",
        secretScan: "passed",
        referentialIntegrity: "passed",
      },
      productionFallback: false,
    };
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
      { requireRehearsal: true },
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
  if (!inventory && progress) {
    progress = await recoverForwardRepairCleanupProgress({
      progress,
      envelope,
      config,
      evidenceDirectory,
      readbackListingPath: policy.policy.production.readbackListingPath,
    });
    await writeProgress(progressPath, progress);
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
