import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  digestJson,
  sha256Bytes,
  writePrivateJson,
  type CloudflareReadClient,
  type ReleaseEnvelope,
  type StoreArtifactManifest,
} from "../scripts/store-release-common.ts";
import {
  assertInventoryDigest,
  destroyExact,
  exactD1DatabaseId,
  exactKvNamespaceId,
  assertProvisionedOperationIdentity,
  provisionedProgressResourceIds,
  resolveReplicaAttestationVerifiedAt,
  rehearseForwardRepair,
  recoverForwardRepairCleanupProgress,
  recoverCleanupProgress,
  recoverProvisionCleanupProgress,
  replicaDeployRunner,
  sealR2ObjectDeleteInventory,
  resolveProvisionRetryInventory,
  validateInventory,
  validateForwardRepairEvidence,
  validateProgress,
  verifyReplicaStoragePreserved,
  type Inventory,
  type Progress,
  type ReplicaConfig,
  type SanitizedSnapshotScan,
} from "../scripts/store-release-replica-adapter.ts";

const roots: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function authority(): {
  config: ReplicaConfig;
  envelope: ReleaseEnvelope;
  progress: Progress;
} {
  const target = {
    accountId: "a".repeat(32),
    workerName: "store-replica-review-1",
    databaseName: "store-db-replica-review-1",
    kvNamespaceName: "store-kv-replica-review-1",
    iconsBucketName: "store-icons-replica-review-1",
    origin: "https://store-replica-review-1.account.workers.dev",
  };
  const artifactDigests = [
    `sha256:${"1".repeat(64)}`,
    `sha256:${"2".repeat(64)}`,
    `sha256:${"3".repeat(64)}`,
  ];
  const config = {
    kind: "takosumi.store-release-replica-config@v1",
    surfaceId: "takosumi-store",
    releaseId: "store-review-release",
    replicaId: "replica-review-1",
    createdAt: "2026-07-22T00:00:00.000Z",
    expiresAt: "2026-07-23T00:00:00.000Z",
    productionTarget: {
      accountId: target.accountId,
      workerName: "takosumi-store",
      databaseId: "00000000-0000-4000-8000-000000000099",
      kvNamespaceId: "f".repeat(32),
      iconsBucketName: "takosumi-store-icons",
      origin: "https://store.takosumi.com",
    },
    target,
  } as const satisfies ReplicaConfig;
  const envelope = {
    releaseId: config.releaseId,
    source: { commit: "a".repeat(40) },
    candidate: { artifactDigests },
    replica: { id: config.replicaId },
  } as unknown as ReleaseEnvelope;
  const preflightAbsenceDigest = digestJson({
    kind: "takosumi.store-replica-preflight-absence@v1",
    target,
    worker: true,
    d1: true,
    kv: true,
    r2: true,
  });
  const progress: Progress = {
    kind: "takosumi.store-release-replica-progress@v1",
    status: "provisioned",
    surfaceId: "takosumi-store",
    releaseId: config.releaseId,
    replicaId: config.replicaId,
    accountId: target.accountId,
    target,
    artifactDigests,
    createdAt: config.createdAt,
    expiresAt: config.expiresAt,
    resources: [
      {
        type: "worker",
        name: target.workerName,
        id: "10000000-0000-4000-8000-000000000001",
        state: "present",
      },
      {
        type: "d1",
        name: target.databaseName,
        id: "10000000-0000-4000-8000-000000000002",
        state: "present",
      },
      {
        type: "kv",
        name: target.kvNamespaceName,
        id: "e".repeat(32),
        state: "present",
      },
      { type: "r2", name: target.iconsBucketName, state: "present" },
    ],
    preflightAbsenceDigest,
    completedSteps: ["provisioned"],
    productionFallback: false,
  };
  return { config, envelope, progress };
}

function snapshotScanFixture(
  icon: SanitizedSnapshotScan["icons"][number],
  overrides: Partial<SanitizedSnapshotScan> = {},
): SanitizedSnapshotScan {
  const iconUrl = `{{TAKOSUMI_STORE_REPLICA_ORIGIN}}/${icon.key}`;
  const listing = { id: "tako/takos", icon_url: iconUrl };
  return {
    snapshotDigest: `sha256:${"1".repeat(64)}`,
    sqlDigest: `sha256:${"2".repeat(64)}`,
    scannerDigest: `sha256:${"3".repeat(64)}`,
    sql: "INSERT INTO listings VALUES ('tako/takos')",
    listing,
    rowDigest: digestJson(listing),
    iconSourceReferenceDigest: digestJson({ href: iconUrl }),
    iconDigest: icon.sha256,
    source: {
      rowDigest: `sha256:${"4".repeat(64)}`,
      iconSourceKind: "public-https-reference",
      iconSourceReferenceDigest: `sha256:${"5".repeat(64)}`,
      iconDigest: icon.sha256,
    },
    icons: [icon],
    ...overrides,
  };
}

describe("replica cleanup authority", () => {
  test("treats only exact absent fresh Worker heads as empty", () => {
    let directAbsentWorkerCalls = 0;
    const base = ((args: readonly string[]): string => {
      if (
        (args[0] === "deployments" && args[1] === "status") ||
        (args[0] === "versions" && args[1] === "list")
      ) {
        directAbsentWorkerCalls += 1;
        throw new Error("wrangler_nonzero_for_absent_worker");
      }
      return "forwarded";
    }) as import("../scripts/store-release-common.ts").WranglerRunner;
    base.inspect = (args) =>
      (args[0] === "deployments" && args[1] === "status") ||
      (args[0] === "versions" && args[1] === "list")
        ? { status: "not-found", stdout: "" }
        : { status: "failed", stdout: "" };
    const runner = replicaDeployRunner(base);
    expect(
      runner(["deployments", "status", "--name", "fresh-worker", "--json"], {
        cwd: "/tmp",
      }),
    ).toBe('{"versions":[]}');
    expect(
      runner(["versions", "list", "--name", "fresh-worker", "--json"], {
        cwd: "/tmp",
      }),
    ).toBe("[]");
    expect(directAbsentWorkerCalls).toBe(0);
    expect(runner(["versions", "upload"], { cwd: "/tmp" })).toBe("forwarded");

    base.inspect = () => ({ status: "failed", stdout: "permission denied" });
    expect(() =>
      replicaDeployRunner(base)(
        ["deployments", "status", "--name", "fresh-worker", "--json"],
        { cwd: "/tmp" },
      ),
    ).toThrow("replica_remote_inspection_failed");
  });

  test("atomically completes a multi-object R2 cleanup inventory", async () => {
    const value = authority();
    const root = await mkdtemp(join(tmpdir(), "store-r2-cleanup-seal-"));
    roots.push(root);
    await chmod(root, 0o700);
    const path = join(root, "worker-release-replica-mutation-journal.json");
    const empty = {
      kind: "takosumi.store-replica-mutation-journal@v1",
      surfaceId: "takosumi-store",
      releaseId: value.progress.releaseId,
      replicaId: value.progress.replicaId,
      accountId: value.progress.accountId,
      targetDigest: digestJson(value.progress.target),
      preflightAbsenceDigest: value.progress.preflightAbsenceDigest,
      operations: [],
      productionFallback: false,
    } as unknown as Parameters<
      typeof sealR2ObjectDeleteInventory
    >[0]["journal"];
    const options = {
      path,
      journal: empty,
      accountId: value.progress.accountId,
      bucketName: value.config.target.iconsBucketName,
      liveObjectKeys: ["icons/b", "icons/a"],
    };
    const sealed = await sealR2ObjectDeleteInventory(options);
    expect(sealed.descriptors.map((entry) => entry.objectKey)).toEqual([
      "icons/b",
      "icons/a",
    ]);
    expect(sealed.journal.operations).toHaveLength(2);

    const partial = {
      ...empty,
      operations: [sealed.journal.operations[0]!],
    };
    await writePrivateJson(path, partial, { replace: true });
    const resumed = await sealR2ObjectDeleteInventory({
      ...options,
      journal: partial,
    });
    expect(resumed.journal.operations).toHaveLength(2);
    expect(resumed.journal.operations[1]!.descriptor.objectKey).toBe("icons/a");

    const committedPartial = {
      ...partial,
      operations: [
        {
          ...partial.operations[0]!,
          phase: "committed" as const,
          receipt: {
            accountId: value.progress.accountId,
            resourceName: value.config.target.iconsBucketName,
            objectKey: "icons/b",
            liveReadbackDigest: `sha256:${"a".repeat(64)}`,
            recovery: "direct" as const,
            result: "exact-absent" as const,
            createdOnly: false,
          },
        },
      ],
    };
    await expect(
      sealR2ObjectDeleteInventory({
        ...options,
        journal: committedPartial,
      }),
    ).rejects.toThrow("replica_r2_cleanup_inventory_unsealed");
  });

  test("binds successful provision retries and forbids replica identity reuse", () => {
    const value = authority();
    const ids = provisionedProgressResourceIds(value.progress);
    expect(ids).toEqual({
      databaseId: String(value.progress.resources[1]!.id),
      kvNamespaceId: String(value.progress.resources[2]!.id),
      versionId: String(value.progress.resources[0]!.id),
    });
    expect(() =>
      provisionedProgressResourceIds({
        ...value.progress,
        status: "destroyed",
      }),
    ).toThrow("replica_terminal_identity_reuse_forbidden");
    expect(() =>
      provisionedProgressResourceIds({
        ...value.progress,
        status: "provisioning",
      }),
    ).toThrow("replica_partial_progress_requires_quarantine");
    const operation = { phase: "verified", versionId: ids.versionId };
    expect(() =>
      assertProvisionedOperationIdentity(
        operation,
        ids.versionId,
        ids.versionId,
      ),
    ).not.toThrow();
    for (const invalid of [
      { operation: { ...operation, phase: "deployed" }, owned: ids.versionId },
      {
        operation: { ...operation, versionId: "other" },
        owned: ids.versionId,
      },
      { operation, owned: "other" },
    ]) {
      expect(() =>
        assertProvisionedOperationIdentity(
          invalid.operation,
          ids.versionId,
          invalid.owned,
        ),
      ).toThrow("replica_provisioned_operation_authority_mismatch");
    }
    const draft = {
      kind: "takosumi.store-release-replica-inventory@v1",
      status: "verified",
      surfaceId: "takosumi-store",
      releaseId: value.progress.releaseId,
      replicaId: value.progress.replicaId,
      accountId: value.progress.accountId,
      target: {
        ...value.progress.target,
        databaseId: ids.databaseId,
        kvNamespaceId: ids.kvNamespaceId,
        versionId: ids.versionId,
      },
      artifactDigests: value.progress.artifactDigests,
      createdAt: value.progress.createdAt,
      expiresAt: value.progress.expiresAt,
      checks: [],
      remoteEvidence: { preflightAbsenceDigest: "old" },
      productionFallback: false,
    } as const satisfies Inventory;
    const liveRemoteEvidence = {
      preflightAbsenceDigest: value.progress.preflightAbsenceDigest,
      deploymentDigest: `sha256:${"8".repeat(64)}`,
    };
    const recovered = resolveProvisionRetryInventory({
      draft,
      liveRemoteEvidence,
      retainedInventory: null,
    });
    expect(recovered.remoteEvidence).toEqual(liveRemoteEvidence);
    expect(
      resolveProvisionRetryInventory({
        draft,
        liveRemoteEvidence,
        retainedInventory: recovered,
      }),
    ).toBe(recovered);
    expect(() =>
      resolveProvisionRetryInventory({
        draft,
        liveRemoteEvidence: {
          ...liveRemoteEvidence,
          deploymentDigest: `sha256:${"9".repeat(64)}`,
        },
        retainedInventory: recovered,
      }),
    ).toThrow("replica_retained_inventory_live_readback_mismatch");
  });

  test("rejects mutable progress redirected to a production identity", () => {
    const value = authority();
    expect(() =>
      validateProgress(value.progress, value.envelope, value.config),
    ).not.toThrow();
    expect(() =>
      validateProgress(
        {
          ...value.progress,
          target: {
            ...value.progress.target,
            workerName: value.config.productionTarget.workerName,
          },
        },
        value.envelope,
        value.config,
      ),
    ).toThrow("replica_progress_target_authority_mismatch");
    expect(() =>
      validateProgress(
        {
          ...value.progress,
          resources: value.progress.resources.map((resource) =>
            resource.type === "kv"
              ? { ...resource, id: value.config.productionTarget.kvNamespaceId }
              : resource,
          ),
        },
        value.envelope,
        value.config,
      ),
    ).toThrow("replica_progress_production_identity_forbidden");
    expect(() =>
      validateProgress(
        {
          ...value.progress,
          resources: value.progress.resources.map((resource) =>
            resource.type === "worker"
              ? { ...resource, state: "presence-unknown" }
              : resource,
          ),
          preflightAbsenceDigest: `sha256:${"0".repeat(64)}`,
        },
        value.envelope,
        value.config,
      ),
    ).toThrow("replica_progress_authority_mismatch");
    expect(() =>
      validateProgress(
        {
          ...value.progress,
          resources: [
            value.progress.resources[0],
            value.progress.resources[0],
            value.progress.resources[2],
            value.progress.resources[3],
          ],
        },
        value.envelope,
        value.config,
      ),
    ).toThrow("replica_progress_resource_mismatch");
  });

  test("refuses ambiguous exact-name remote ownership", () => {
    expect(() =>
      exactD1DatabaseId(
        JSON.stringify([
          { name: "replica-db", uuid: "10000000-0000-4000-8000-000000000001" },
          { name: "replica-db", uuid: "10000000-0000-4000-8000-000000000002" },
        ]),
        "replica-db",
      ),
    ).toThrow("replica_d1_inventory_ambiguous");
    expect(() =>
      exactKvNamespaceId(
        JSON.stringify([
          { title: "replica-kv", id: "a".repeat(32) },
          { title: "replica-kv", id: "b".repeat(32) },
        ]),
        "replica-kv",
      ),
    ).toThrow("replica_kv_namespace_inventory_ambiguous");
  });

  test("binds the exact inventory digest and rejects tampered inventory", () => {
    const value = authority();
    const digest = `sha256:${"9".repeat(64)}`;
    const inventory: Inventory = {
      kind: "takosumi.store-release-replica-inventory@v1",
      status: "verified",
      surfaceId: "takosumi-store",
      releaseId: value.config.releaseId,
      replicaId: value.config.replicaId,
      accountId: value.config.target.accountId,
      target: {
        ...value.config.target,
        databaseId: value.progress.resources[1]!.id!,
        kvNamespaceId: value.progress.resources[2]!.id!,
        versionId: value.progress.resources[0]!.id!,
      },
      artifactDigests: value.progress.artifactDigests,
      createdAt: value.config.createdAt,
      expiresAt: value.config.expiresAt,
      checks: [
        "fresh Store Worker exact Version, bindings, and asset readback",
        "fresh D1 migration lineage and sanitized catalog integrity",
        "TCS ServerInfo, listings, SPA, and API fallback behavior",
        "isolated target cleanup and forward-repair rehearsal",
      ].map((name) => ({ name, bindingDigest: digest })),
      remoteEvidence: {
        versionDigest: digest,
        deploymentDigest: digest,
        migrationLineageDigest: digest,
        snapshotDigest: digest,
        snapshotSqlDigest: digest,
        snapshotScannerDigest: digest,
        iconReadbackDigest: digest,
        topologyDigest: digest,
        preflightAbsenceDigest: value.progress.preflightAbsenceDigest,
      },
      productionFallback: false,
    };
    const boundEnvelope = {
      ...value.envelope,
      replica: {
        ...value.envelope.replica,
        targetInventoryDigest: digestJson(inventory),
      },
    } as ReleaseEnvelope;
    expect(() =>
      validateInventory(inventory, boundEnvelope, value.config),
    ).not.toThrow();
    expect(() => assertInventoryDigest(inventory, boundEnvelope)).not.toThrow();
    expect(() =>
      assertInventoryDigest(
        {
          ...inventory,
          remoteEvidence: { ...inventory.remoteEvidence, extra: digest },
        },
        boundEnvelope,
      ),
    ).toThrow("replica_target_inventory_digest_mismatch");
    expect(() =>
      validateInventory(
        {
          ...inventory,
          target: {
            ...inventory.target,
            databaseId: value.config.productionTarget.databaseId,
          },
        },
        boundEnvelope,
        value.config,
      ),
    ).toThrow("replica_inventory_authority_mismatch");

    const rehearsalDigest = `sha256:${"8".repeat(64)}`;
    const rehearsed = {
      ...inventory,
      checks: inventory.checks.map((check, index) =>
        index === inventory.checks.length - 1
          ? { ...check, bindingDigest: rehearsalDigest }
          : check,
      ),
      remoteEvidence: {
        ...inventory.remoteEvidence,
        failureRehearsalDigest: rehearsalDigest,
      },
    };
    expect(() =>
      validateInventory(rehearsed, boundEnvelope, value.config, {
        requireRehearsal: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateInventory(
        {
          ...rehearsed,
          checks: inventory.checks,
        },
        boundEnvelope,
        value.config,
        { requireRehearsal: true },
      ),
    ).toThrow("replica_inventory_rehearsal_check_binding_mismatch");
  });

  test("proves exact live D1, KV, R2, catalog, and icon preservation", async () => {
    const value = authority();
    const root = await mkdtemp(join(tmpdir(), "store-replica-storage-"));
    roots.push(root);
    await chmod(root, 0o700);
    const iconBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const iconDigest = sha256Bytes(iconBytes);
    const iconKey = `icons/${iconDigest.slice(7)}`;
    const migrationNames = [
      "0001_init.sql",
      "0002_accounts.sql",
      "0003_scope_slug.sql",
      "0004_tags.sql",
      "0005_install_experience.sql",
      "0006_source_identity.sql",
    ];
    const inventory = {
      kind: "takosumi.store-release-replica-inventory@v1",
      status: "verified",
      surfaceId: "takosumi-store",
      releaseId: value.config.releaseId,
      replicaId: value.config.replicaId,
      accountId: value.config.target.accountId,
      target: {
        ...value.config.target,
        databaseId: value.progress.resources[1]!.id!,
        kvNamespaceId: value.progress.resources[2]!.id!,
        versionId: value.progress.resources[0]!.id!,
      },
      artifactDigests: value.progress.artifactDigests,
      createdAt: value.config.createdAt,
      expiresAt: value.config.expiresAt,
      checks: [],
      remoteEvidence: {},
      productionFallback: false,
    } as const satisfies Inventory;
    const state = {
      databaseId: inventory.target.databaseId,
      kvNamespaceId: inventory.target.kvNamespaceId,
      bucketName: inventory.target.iconsBucketName,
      iconBytes,
    };
    const runner = ((args: readonly string[]): string => {
      if (args[0] === "d1" && args[1] === "list") {
        return JSON.stringify([
          { name: inventory.target.databaseName, uuid: state.databaseId },
        ]);
      }
      if (args[0] === "kv" && args[1] === "namespace") {
        return JSON.stringify([
          { title: inventory.target.kvNamespaceName, id: state.kvNamespaceId },
        ]);
      }
      if (args[0] === "d1" && args[1] === "migrations") {
        return "No migrations to apply.";
      }
      if (args[0] === "d1" && args[1] === "execute") {
        const command = args[args.indexOf("--command") + 1] ?? "";
        return command.includes("d1_migrations")
          ? JSON.stringify([
              { results: migrationNames.map((name) => ({ name })) },
            ])
          : JSON.stringify([
              {
                results: [
                  {
                    id: "tako/takos",
                    icon_url: `${inventory.target.origin}/${iconKey}`,
                  },
                ],
              },
            ]);
      }
      if (args[0] === "r2" && args[1] === "object" && args[2] === "get") {
        writeFileSync(args[args.indexOf("--file") + 1]!, state.iconBytes);
        return "";
      }
      throw new Error(`unexpected:${args.join(" ")}`);
    }) as Parameters<typeof verifyReplicaStoragePreserved>[0]["runner"];
    let objectRequests = 0;
    const client: CloudflareReadClient = {
      accountId: inventory.accountId,
      get: async (path, query) => {
        if (path.endsWith("/r2/buckets")) {
          return {
            status: "ok",
            result: { buckets: [{ name: state.bucketName }] },
            resultInfo: null,
          };
        }
        if (path.endsWith("/objects")) {
          objectRequests += 1;
          if (query?.cursor === "next-page") {
            return {
              status: "ok",
              result: [],
              resultInfo: null,
            };
          }
          return {
            status: "ok",
            result: [{ key: iconKey }],
            resultInfo: { cursor: "next-page" },
          };
        }
        return { status: "not-found" };
      },
    };
    const manifest = {
      migrations: migrationNames.map((name) => ({
        path: `migrations/${name}`,
      })),
    } as unknown as StoreArtifactManifest;
    const snapshotScan = snapshotScanFixture({
      key: iconKey,
      mediaType: "image/png",
      bytes: iconBytes,
      sha256: iconDigest,
    });
    const verify = () =>
      verifyReplicaStoragePreserved({
        inventory,
        runner,
        cwd: root,
        manifest,
        snapshotScan,
        cloudflareReadClient: client,
      });
    await expect(verify()).resolves.toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(objectRequests).toBe(2);

    state.databaseId = "20000000-0000-4000-8000-000000000099";
    await expect(verify()).rejects.toThrow(
      "replica_d1_inventory_identity_mismatch",
    );
    state.databaseId = inventory.target.databaseId;
    state.kvNamespaceId = "a".repeat(32);
    await expect(verify()).rejects.toThrow(
      "replica_kv_namespace_inventory_identity_mismatch",
    );
    state.kvNamespaceId = inventory.target.kvNamespaceId;
    state.bucketName = "substituted-bucket";
    await expect(verify()).rejects.toThrow(
      "replica_forward_repair_r2_storage_missing",
    );
    state.bucketName = inventory.target.iconsBucketName;
    state.iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await expect(verify()).rejects.toThrow(
      "replica_forward_repair_icon_digest_mismatch",
    );
  });

  test("reuses an exact retained attestation timestamp and rejects drift", async () => {
    const value = authority();
    const root = await mkdtemp(join(tmpdir(), "store-replica-attestation-"));
    roots.push(root);
    await chmod(root, 0o700);
    const path = join(root, "worker-release-replica-attestation.json");
    const failureDigest = `sha256:${"8".repeat(64)}`;
    const snapshotDigest = `sha256:${"7".repeat(64)}`;
    const configFingerprint = `sha256:${"6".repeat(64)}`;
    const migrationPlanDigest = `sha256:${"5".repeat(64)}`;
    const snapshotCiphertextDigest = `sha256:${"4".repeat(64)}`;
    const provenanceDigest = `sha256:${"3".repeat(64)}`;
    const checks = [
      "fresh Store Worker exact Version, bindings, and asset readback",
      "fresh D1 migration lineage and sanitized catalog integrity",
      "TCS ServerInfo, listings, SPA, and API fallback behavior",
      "isolated target cleanup and forward-repair rehearsal",
    ].map((name, index) => ({
      name,
      bindingDigest:
        index === 3 ? failureDigest : `sha256:${String(index + 1).repeat(64)}`,
    }));
    const inventory: Inventory = {
      kind: "takosumi.store-release-replica-inventory@v1",
      status: "verified",
      surfaceId: "takosumi-store",
      releaseId: value.config.releaseId,
      replicaId: value.config.replicaId,
      accountId: value.config.target.accountId,
      target: {
        ...value.config.target,
        databaseId: value.progress.resources[1]!.id!,
        kvNamespaceId: value.progress.resources[2]!.id!,
        versionId: value.progress.resources[0]!.id!,
      },
      artifactDigests: value.progress.artifactDigests,
      createdAt: value.config.createdAt,
      expiresAt: value.config.expiresAt,
      checks,
      remoteEvidence: { failureRehearsalDigest: failureDigest },
      productionFallback: false,
    };
    const envelope = {
      releaseId: value.config.releaseId,
      source: { commit: "a".repeat(40) },
      controllerSource: { commit: "b".repeat(40) },
      authority: { replicaAdapterDigest: `sha256:${"4".repeat(64)}` },
      candidate: { artifactDigests: inventory.artifactDigests },
      replica: {
        id: value.config.replicaId,
        configFingerprint,
        migrationPlanDigest,
        data: { snapshotDigest, snapshotCiphertextDigest, provenanceDigest },
      },
    } as unknown as ReleaseEnvelope;
    const verifiedAt = "2026-07-22T01:02:03.000Z";
    const resolve = () =>
      resolveReplicaAttestationVerifiedAt({
        path,
        evidenceDirectory: root,
        envelope,
        config: value.config,
        inventory,
        failureRehearsalDigest: failureDigest,
        failureVerifiedAt: verifiedAt,
      });
    await expect(resolve()).resolves.toBe(verifiedAt);
    const attestation = {
      kind: "takos.release-safety-replica-attestation@v1",
      status: "verified",
      surfaceId: "takosumi-store",
      releaseId: envelope.releaseId,
      sourceCommit: envelope.source.commit,
      controllerCommit: envelope.controllerSource.commit,
      replicaAdapterDigest: envelope.authority.replicaAdapterDigest,
      replicaId: value.config.replicaId,
      accessPolicy: "replica-only-no-production-fallback",
      createdAt: value.config.createdAt,
      verifiedAt,
      expiresAt: value.config.expiresAt,
      configFingerprint,
      migrationPlanDigest,
      targetInventoryDigest: digestJson(inventory),
      artifactDigests: inventory.artifactDigests,
      checks: checks.map((check) => ({ ...check, status: "passed" })),
      failureRehearsal: {
        status: "passed",
        strategy: "forward-repair-after-database-mutation",
        bindingDigest: failureDigest,
      },
      data: {
        source: "encrypted-anonymized-production-snapshot",
        snapshotDigest,
        snapshotCiphertextDigest,
        provenanceDigest,
        piiScan: "passed",
        secretScan: "passed",
        referentialIntegrity: "passed",
      },
      productionFallback: false,
    };
    await writePrivateJson(path, attestation);
    await expect(resolve()).resolves.toBe(verifiedAt);
    await writePrivateJson(
      path,
      { ...attestation, verifiedAt: "2026-07-22T01:02:04.000Z" },
      { replace: true },
    );
    await expect(resolve()).rejects.toThrow(
      "replica_attestation_authority_mismatch",
    );
  });

  test("resumes retained post-delete and post-deploy forward-repair phases", async () => {
    const value = authority();
    const root = await mkdtemp(join(tmpdir(), "store-replica-post-delete-"));
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "store-replica-artifact-"),
    );
    roots.push(root, artifactRoot);
    await Promise.all([chmod(root, 0o700), chmod(artifactRoot, 0o700)]);
    await Promise.all([
      mkdir(join(artifactRoot, "assets/assets"), { recursive: true }),
      mkdir(join(artifactRoot, "migrations"), { recursive: true }),
    ]);
    const workerBytes = Buffer.from(
      "export default {fetch(){return new Response('ok')}}",
    );
    const staticBytes = Buffer.from("sealed-static");
    const indexBytes = Buffer.from("<main>sealed</main>");
    const iconBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const iconDigest = sha256Bytes(iconBytes);
    const iconKey = `icons/${iconDigest.slice(7)}`;
    const migrationNames = [
      "0001_init.sql",
      "0002_accounts.sql",
      "0003_scope_slug.sql",
      "0004_tags.sql",
      "0005_install_experience.sql",
      "0006_source_identity.sql",
    ];
    await Promise.all([
      writeFile(join(artifactRoot, "worker.mjs"), workerBytes),
      writeFile(
        join(artifactRoot, "assets/assets/index-review.js"),
        staticBytes,
      ),
      writeFile(join(artifactRoot, "assets/index.html"), indexBytes),
      writeFile(join(artifactRoot, "assets/tako.png"), iconBytes),
      ...migrationNames.map((name) =>
        writeFile(join(artifactRoot, "migrations", name), "SELECT 1;"),
      ),
    ]);
    const initialVersionId = value.progress.resources[0]!.id!;
    const repairedVersionId = "20000000-0000-4000-8000-000000000002";
    const inventory: Inventory = {
      kind: "takosumi.store-release-replica-inventory@v1",
      status: "verified",
      surfaceId: "takosumi-store",
      releaseId: value.config.releaseId,
      replicaId: value.config.replicaId,
      accountId: value.config.target.accountId,
      target: {
        ...value.config.target,
        databaseId: value.progress.resources[1]!.id!,
        kvNamespaceId: value.progress.resources[2]!.id!,
        versionId: initialVersionId,
      },
      artifactDigests: value.progress.artifactDigests,
      createdAt: value.config.createdAt,
      expiresAt: value.config.expiresAt,
      checks: [
        "fresh Store Worker exact Version, bindings, and asset readback",
        "fresh D1 migration lineage and sanitized catalog integrity",
        "TCS ServerInfo, listings, SPA, and API fallback behavior",
        "isolated target cleanup and forward-repair rehearsal",
      ].map((name, index) => ({
        name,
        bindingDigest: `sha256:${String(index + 1).repeat(64)}`,
      })),
      remoteEvidence: {
        versionDigest: `sha256:${"1".repeat(64)}`,
        deploymentDigest: `sha256:${"2".repeat(64)}`,
        migrationLineageDigest: `sha256:${"3".repeat(64)}`,
        snapshotDigest: `sha256:${"4".repeat(64)}`,
        snapshotSqlDigest: `sha256:${"5".repeat(64)}`,
        snapshotScannerDigest: `sha256:${"6".repeat(64)}`,
        iconReadbackDigest: `sha256:${"7".repeat(64)}`,
        topologyDigest: `sha256:${"8".repeat(64)}`,
        preflightAbsenceDigest: value.progress.preflightAbsenceDigest,
      },
      productionFallback: false,
    };
    const configFingerprint = `sha256:${"9".repeat(64)}`;
    const manifest = {
      worker: {
        path: "worker.mjs",
        sha256: sha256Bytes(workerBytes),
        size: workerBytes.byteLength,
      },
      migrations: migrationNames.map((name) => ({
        path: `migrations/${name}`,
      })),
      assets: [
        {
          path: "assets/assets/index-review.js",
          sha256: sha256Bytes(staticBytes),
          size: staticBytes.byteLength,
        },
        {
          path: "assets/index.html",
          sha256: sha256Bytes(indexBytes),
          size: indexBytes.byteLength,
        },
        {
          path: "assets/tako.png",
          sha256: iconDigest,
          size: iconBytes.byteLength,
        },
      ],
    } as unknown as StoreArtifactManifest;
    const envelope = {
      releaseId: value.config.releaseId,
      source: { commit: "a".repeat(40) },
      controllerSource: { commit: "b".repeat(40) },
      authority: { replicaAdapterDigest: `sha256:${"a".repeat(64)}` },
      candidate: { artifactDigests: inventory.artifactDigests },
      replica: {
        id: value.config.replicaId,
        configFingerprint,
        migrationPlanDigest: `sha256:${"b".repeat(64)}`,
        data: { snapshotDigest: inventory.remoteEvidence.snapshotDigest },
      },
    } as unknown as ReleaseEnvelope;
    await writePrivateJson(
      join(root, "worker-release-replica-inventory.json"),
      inventory,
    );
    const snapshotScan = snapshotScanFixture(
      {
        key: iconKey,
        mediaType: "image/png",
        bytes: iconBytes,
        sha256: iconDigest,
      },
      {
        snapshotDigest: String(inventory.remoteEvidence.snapshotDigest),
        sqlDigest: String(inventory.remoteEvidence.snapshotSqlDigest),
        scannerDigest: String(inventory.remoteEvidence.snapshotScannerDigest),
      },
    );
    let workerPresent = false;
    let deployed = false;
    let scriptEnabled = false;
    const calls: string[][] = [];
    const versionReadback = {
      id: repairedVersionId,
      annotations: {
        "workers/message": envelope.releaseId,
        "workers/tag": "0.1.13",
      },
      resources: {
        bindings: [
          {
            name: "DB",
            type: "d1",
            id: inventory.target.databaseId,
            database_id: inventory.target.databaseId,
          },
          {
            name: "KV",
            type: "kv_namespace",
            namespace_id: inventory.target.kvNamespaceId,
          },
          {
            name: "ICONS",
            type: "r2_bucket",
            bucket_name: inventory.target.iconsBucketName,
          },
          { name: "ASSETS", type: "assets" },
          { name: "APP_URL", type: "plain_text" },
        ],
      },
    };
    const deployment = {
      id: "30000000-0000-4000-8000-000000000003",
      versions: [{ version_id: repairedVersionId, percentage: 100 }],
    };
    const runner = ((args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "d1" && args[1] === "list") {
        return JSON.stringify([
          {
            name: inventory.target.databaseName,
            uuid: inventory.target.databaseId,
          },
        ]);
      }
      if (args[0] === "kv" && args[1] === "namespace") {
        return JSON.stringify([
          {
            title: inventory.target.kvNamespaceName,
            id: inventory.target.kvNamespaceId,
          },
        ]);
      }
      if (args[0] === "d1" && args[1] === "migrations") {
        return args[2] === "list" ? "No migrations to apply." : "";
      }
      if (args[0] === "d1" && args[1] === "execute") {
        const command = args[args.indexOf("--command") + 1] ?? "";
        return command.includes("d1_migrations")
          ? JSON.stringify([
              { results: migrationNames.map((name) => ({ name })) },
            ])
          : JSON.stringify([
              {
                results: [
                  {
                    id: "tako/takos",
                    icon_url: `${inventory.target.origin}/${iconKey}`,
                  },
                ],
              },
            ]);
      }
      if (args[0] === "r2" && args[1] === "object" && args[2] === "get") {
        writeFileSync(args[args.indexOf("--file") + 1]!, iconBytes);
        return "";
      }
      if (args[0] === "versions" && args[1] === "upload") {
        workerPresent = true;
        return `Version ID: ${repairedVersionId}`;
      }
      if (args[0] === "versions" && args[1] === "view") {
        return JSON.stringify(versionReadback);
      }
      if (args[0] === "versions" && args[1] === "deploy") {
        deployed = true;
        return "";
      }
      if (args[0] === "triggers") {
        scriptEnabled = true;
        return "";
      }
      throw new Error(`unexpected:${args.join(" ")}`);
    }) as Parameters<typeof rehearseForwardRepair>[0]["runner"];
    runner.inspect = (args) => {
      calls.push([...args]);
      if (args[0] === "versions" && args[1] === "list") {
        return workerPresent
          ? {
              status: "ok",
              stdout: JSON.stringify([{ id: repairedVersionId }]),
            }
          : { status: "not-found", stdout: "" };
      }
      if (args[0] === "deployments") {
        return workerPresent
          ? {
              status: "ok",
              stdout: JSON.stringify(deployed ? deployment : { versions: [] }),
            }
          : { status: "not-found", stdout: "" };
      }
      return { status: "failed", stdout: "" };
    };
    const client: CloudflareReadClient = {
      accountId: inventory.accountId,
      get: async (path) => {
        if (path.endsWith("/r2/buckets")) {
          return {
            status: "ok",
            result: { buckets: [{ name: inventory.target.iconsBucketName }] },
            resultInfo: null,
          };
        }
        if (path.endsWith("/objects")) {
          return {
            status: "ok",
            result: [{ key: iconKey }],
            resultInfo: null,
          };
        }
        if (path.endsWith("/workers/subdomain")) {
          return {
            status: "ok",
            result: { subdomain: "account" },
            resultInfo: null,
          };
        }
        if (
          path.includes(
            `/workers/scripts/${inventory.target.workerName}/subdomain`,
          )
        ) {
          return scriptEnabled
            ? {
                status: "ok",
                result: { enabled: true, previews_enabled: false },
                resultInfo: null,
              }
            : { status: "not-found" };
        }
        return { status: "not-found" };
      },
    };
    const storagePreservationDigest = await verifyReplicaStoragePreserved({
      inventory,
      runner,
      cwd: root,
      manifest,
      snapshotScan,
      cloudflareReadClient: client,
    });
    const workerAbsentProgress = {
      kind: "takosumi.store-replica-forward-repair-progress@v1",
      status: "worker-absent",
      surfaceId: "takosumi-store",
      releaseId: envelope.releaseId,
      replicaId: value.config.replicaId,
      initialInventoryDigest: digestJson(inventory),
      target: inventory.target,
      removedVersionId: initialVersionId,
      workerAbsenceDigest: digestJson({
        kind: "takosumi.store-replica-worker-absence@v1",
        workerName: inventory.target.workerName,
        removedVersionId: initialVersionId,
        versionAbsent: true,
        subdomainAbsent: true,
      }),
      storagePreservationDigest,
    } as const;
    const forwardProgressPath = join(
      root,
      "worker-release-replica-forward-repair-progress.json",
    );
    await writePrivateJson(forwardProgressPath, {
      ...workerAbsentProgress,
      target: {
        ...workerAbsentProgress.target,
        workerName: value.config.productionTarget.workerName,
      },
    });
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers();
      if (url.pathname === "/tcs/v1/listings/tako/takos") {
        headers.set("access-control-allow-origin", "*");
        headers.set("access-control-allow-methods", "GET, OPTIONS");
        if (init?.method === "OPTIONS")
          return new Response(null, { status: 204, headers });
        return Response.json(
          {
            id: "tako/takos",
            scope: "tako",
            slug: "takos",
            source: { git: "https://github.com/tako0614/takos.git" },
            iconUrl: `${inventory.target.origin}/${iconKey}`,
          },
          { headers },
        );
      }
      if (url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          software: "takosumi-store",
          version: "0.1.13",
        });
      }
      if (url.pathname === "/readyz") {
        return Response.json({
          status: "ready",
          capabilities: { publish: false },
        });
      }
      if (url.pathname === "/.well-known/tcs") {
        return Response.json({
          server: {
            software: { name: "takosumi-store", version: "0.1.13" },
            baseUrl: inventory.target.origin,
          },
        });
      }
      if (url.pathname === `/${iconKey}`) {
        return new Response(iconBytes, {
          headers: { "content-type": "image/png" },
        });
      }
      if (url.pathname === "/tcs/v1/release-safety-not-found") {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      if (url.pathname === "/assets/index-review.js")
        return new Response(staticBytes);
      if (url.pathname.startsWith("/release-safety/")) {
        return new Response(indexBytes, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("missing", { status: 500 });
    }) as typeof fetch;
    const run = () =>
      rehearseForwardRepair({
        envelope,
        config: value.config,
        artifactRoot,
        manifest,
        runner,
        evidenceDirectory: root,
        snapshotScan,
        readbackListingPath: "/tcs/v1/listings/tako/takos",
        cloudflareReadClient: client,
        initialInventory: inventory,
      });
    await expect(run()).rejects.toThrow(
      "replica_forward_repair_progress_authority_mismatch",
    );
    await writePrivateJson(forwardProgressPath, workerAbsentProgress, {
      replace: true,
    });
    workerPresent = true;
    deployed = true;
    scriptEnabled = true;
    await expect(run()).rejects.toThrow(
      "replica_forward_repair_intervening_worker_present",
    );
    workerPresent = false;
    deployed = false;
    scriptEnabled = false;
    const repairTarget = {
      configPath: "replica-generated.toml",
      accountId: inventory.accountId,
      workerName: inventory.target.workerName,
      origin: inventory.target.origin,
      databaseName: inventory.target.databaseName,
      databaseId: inventory.target.databaseId,
      kvNamespaceId: inventory.target.kvNamespaceId,
      iconsBucketName: inventory.target.iconsBucketName,
      publishCapability: false,
      compatibilityDate: "2026-06-25",
      compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
      requiredVarNames: ["APP_URL"],
      requiredSecretNames: [],
      customDomainHostname: new URL(inventory.target.origin).hostname,
      readbackListingPath: "/tcs/v1/listings/tako/takos",
    };
    await writePrivateJson(
      join(root, "worker-release-replica-forward-repair-operation.json"),
      {
        kind: "takosumi.store-release-operation@v1",
        environment: "replica-forward-repair",
        surfaceId: "takosumi-store",
        releaseId: envelope.releaseId,
        sourceCommit: envelope.source.commit,
        artifactDigests: envelope.candidate.artifactDigests,
        targetFingerprint: digestJson(repairTarget),
        target: {
          accountId: repairTarget.accountId,
          workerName: repairTarget.workerName,
          databaseId: repairTarget.databaseId,
          kvNamespaceId: repairTarget.kvNamespaceId,
          iconsBucketName: repairTarget.iconsBucketName,
          origin: repairTarget.origin,
        },
        preDeploymentDigest: digestJson({ versions: [] }),
        phase: "trigger-deployed",
        versionId: repairedVersionId,
        preUploadVersionIds: [],
        updatedAt: "2026-07-22T01:02:03.000Z",
      },
    );
    workerPresent = true;
    deployed = true;
    scriptEnabled = true;
    const triggerPhaseCleanup = await recoverForwardRepairCleanupProgress({
      progress: value.progress,
      envelope,
      config: value.config,
      evidenceDirectory: root,
      readbackListingPath: "/tcs/v1/listings/tako/takos",
      runner,
      cwd: root,
    });
    expect(
      triggerPhaseCleanup.resources.find(
        (resource) => resource.type === "worker",
      )?.id,
    ).toBe(repairedVersionId);
    const repaired = await run();
    expect(repaired.target.versionId).toBe(repairedVersionId);
    expect(repaired.checks[3]!.bindingDigest).toBe(
      String(repaired.remoteEvidence.failureRehearsalDigest),
    );
    expect(calls.filter((args) => args[0] === "delete")).toHaveLength(0);
    expect(
      calls.filter((args) => args[0] === "versions" && args[1] === "upload"),
    ).toHaveLength(0);
    expect(
      calls.filter((args) => args[0] === "versions" && args[1] === "deploy"),
    ).toHaveLength(0);
    expect(calls.filter((args) => args[0] === "triggers")).toHaveLength(0);
    const repeated = await run();
    expect(canonicalJson(repeated)).toBe(canonicalJson(repaired));
    expect(
      calls.filter((args) => args[0] === "versions" && args[1] === "upload"),
    ).toHaveLength(0);
    const mutationJournal = JSON.parse(
      await readFile(
        join(root, "worker-release-replica-mutation-journal.json"),
        "utf8",
      ),
    ) as {
      operations: Array<{
        descriptor: { id: string; kind: string };
        phase: string;
        receipt?: { resourceId?: string; createdOnly: boolean };
      }>;
    };
    for (const [id, kind] of [
      ["rehearsal:worker:repair-upload", "worker-repair-upload"],
      ["rehearsal:worker:repair-deploy", "worker-repair-deploy"],
      ["rehearsal:worker:repair-trigger", "worker-repair-trigger-deploy"],
    ]) {
      const operation = mutationJournal.operations.find(
        (entry) => entry.descriptor.id === id,
      );
      expect(operation?.descriptor.kind).toBe(kind);
      expect(operation?.phase).toBe("committed");
    }
    const repairedUpload = mutationJournal.operations.find(
      (entry) => entry.descriptor.kind === "worker-repair-upload",
    );
    expect(repairedUpload?.receipt?.resourceId).toBe(repairedVersionId);
    expect(repairedUpload?.receipt?.createdOnly).toBe(true);
    await writePrivateJson(
      join(root, "worker-release-replica-provision-operation.json"),
      {
        kind: "takosumi.store-release-operation@v1",
        environment: "replica-provision",
        surfaceId: "takosumi-store",
        releaseId: envelope.releaseId,
        sourceCommit: envelope.source.commit,
        artifactDigests: envelope.candidate.artifactDigests,
        targetFingerprint: digestJson(repairTarget),
        target: {
          accountId: repairTarget.accountId,
          workerName: repairTarget.workerName,
          databaseId: repairTarget.databaseId,
          kvNamespaceId: repairTarget.kvNamespaceId,
          iconsBucketName: repairTarget.iconsBucketName,
          origin: repairTarget.origin,
        },
        preDeploymentDigest: digestJson({ versions: [] }),
        phase: "verified",
        versionId: initialVersionId,
        preUploadVersionIds: [],
        updatedAt: "2026-07-22T01:02:02.000Z",
      },
    );
    await expect(
      recoverProvisionCleanupProgress({
        progress: value.progress,
        envelope,
        config: value.config,
        evidenceDirectory: root,
        readbackListingPath: "/tcs/v1/listings/tako/takos",
        runner,
        cwd: root,
      }),
    ).rejects.toThrow("replica_worker_inventory_not_exclusive");
    const cleanupProgress = await recoverCleanupProgress({
      progress: value.progress,
      envelope,
      config: value.config,
      evidenceDirectory: root,
      readbackListingPath: "/tcs/v1/listings/tako/takos",
      runner,
      cwd: root,
    });
    expect(
      cleanupProgress.resources.find((resource) => resource.type === "worker")
        ?.id,
    ).toBe(repairedVersionId);
    expect(
      cleanupProgress.completedSteps.some((step) =>
        step.startsWith("forward-repair-cleanup-recovery:"),
      ),
    ).toBe(true);
    const failureEvidence = JSON.parse(
      await readFile(
        join(root, "worker-release-replica-forward-repair-rehearsal.json"),
        "utf8",
      ),
    );
    const repairedProgress = JSON.parse(
      await readFile(forwardProgressPath, "utf8"),
    );
    expect(() =>
      validateForwardRepairEvidence(
        failureEvidence,
        envelope,
        value.config,
        repaired,
        inventory,
        repairedProgress,
      ),
    ).not.toThrow();
    for (const tampered of [
      {
        ...failureEvidence,
        initialInventoryDigest: `sha256:${"0".repeat(64)}`,
      },
      {
        ...failureEvidence,
        forwardRepair: {
          ...failureEvidence.forwardRepair,
          versionDigest: `sha256:${"0".repeat(64)}`,
        },
      },
      {
        ...failureEvidence,
        failureInjection: {
          ...failureEvidence.failureInjection,
          storagePreservationDigest: `sha256:${"0".repeat(64)}`,
        },
      },
    ]) {
      expect(() =>
        validateForwardRepairEvidence(
          tampered,
          envelope,
          value.config,
          repaired,
          inventory,
          repairedProgress,
        ),
      ).toThrow("replica_forward_repair_evidence_authority_mismatch");
    }
  });

  test("recovers an initial provision upload intent for cleanup", async () => {
    const value = authority();
    const evidence = await mkdtemp(
      join(tmpdir(), "store-replica-provision-recovery-"),
    );
    roots.push(evidence);
    await chmod(evidence, 0o700);
    const workerVersionId = value.progress.resources.find(
      (resource) => resource.type === "worker",
    )!.id!;
    const databaseId = value.progress.resources.find(
      (resource) => resource.type === "d1",
    )!.id!;
    const kvNamespaceId = value.progress.resources.find(
      (resource) => resource.type === "kv",
    )!.id!;
    const target = {
      configPath: "replica-generated.toml",
      accountId: value.config.target.accountId,
      workerName: value.config.target.workerName,
      origin: value.config.target.origin,
      databaseName: value.config.target.databaseName,
      databaseId,
      kvNamespaceId,
      iconsBucketName: value.config.target.iconsBucketName,
      publishCapability: false,
      compatibilityDate: "2026-06-25",
      compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
      requiredVarNames: ["APP_URL"],
      requiredSecretNames: [],
      customDomainHostname: new URL(value.config.target.origin).hostname,
      readbackListingPath: "/tcs/v1/listings/tako/takos",
    };
    await writePrivateJson(
      join(evidence, "worker-release-replica-provision-operation.json"),
      {
        kind: "takosumi.store-release-operation@v1",
        environment: "replica-provision",
        surfaceId: "takosumi-store",
        releaseId: value.envelope.releaseId,
        sourceCommit: value.envelope.source.commit,
        artifactDigests: value.envelope.candidate.artifactDigests,
        targetFingerprint: digestJson(target),
        target: {
          accountId: target.accountId,
          workerName: target.workerName,
          databaseId: target.databaseId,
          kvNamespaceId: target.kvNamespaceId,
          iconsBucketName: target.iconsBucketName,
          origin: target.origin,
        },
        preDeploymentDigest: digestJson({ versions: [] }),
        phase: "upload-intent-recorded",
        versionId: null,
        preUploadVersionIds: [],
        updatedAt: "2026-07-22T01:02:03.000Z",
      },
    );
    let ambiguous = false;
    let foreignAnnotation = false;
    const runner = ((args: readonly string[]): string => {
      if (args[0] === "versions" && args[1] === "view") {
        return JSON.stringify({
          id: workerVersionId,
          annotations: {
            "workers/message": foreignAnnotation
              ? "foreign-release"
              : value.envelope.releaseId,
            "workers/tag": "0.1.13",
          },
          resources: {
            bindings: [
              {
                name: "DB",
                type: "d1",
                id: databaseId,
                database_id: databaseId,
              },
              {
                name: "KV",
                type: "kv_namespace",
                namespace_id: kvNamespaceId,
              },
              {
                name: "ICONS",
                type: "r2_bucket",
                bucket_name: target.iconsBucketName,
              },
              { name: "ASSETS", type: "assets" },
              { name: "APP_URL", type: "plain_text" },
            ],
          },
        });
      }
      throw new Error(`unexpected_runner:${args.join(" ")}`);
    }) as import("../scripts/store-release-common.ts").WranglerRunner;
    runner.inspect = (args) => {
      if (args[0] === "versions" && args[1] === "list") {
        return {
          status: "ok",
          stdout: JSON.stringify([
            { id: workerVersionId },
            ...(ambiguous
              ? [{ id: "90000000-0000-4000-8000-000000000009" }]
              : []),
          ]),
        };
      }
      return { status: "failed", stdout: "" };
    };
    const partial: Progress = {
      ...value.progress,
      status: "provisioning",
      resources: value.progress.resources.map((resource) =>
        resource.type === "worker"
          ? { ...resource, id: undefined, state: "presence-unknown" as const }
          : resource,
      ),
    };
    const recovered = await recoverProvisionCleanupProgress({
      progress: partial,
      envelope: value.envelope,
      config: value.config,
      evidenceDirectory: evidence,
      readbackListingPath: target.readbackListingPath,
      runner,
      cwd: evidence,
    });
    expect(
      recovered.resources.find((resource) => resource.type === "worker")?.id,
    ).toBe(workerVersionId);
    expect(
      recovered.completedSteps.some((step) =>
        step.startsWith("provision-cleanup-recovery:"),
      ),
    ).toBe(true);
    ambiguous = true;
    await expect(
      recoverProvisionCleanupProgress({
        progress: partial,
        envelope: value.envelope,
        config: value.config,
        evidenceDirectory: evidence,
        readbackListingPath: target.readbackListingPath,
        runner,
        cwd: evidence,
      }),
    ).rejects.toThrow("replica_worker_upload_recovery_ambiguous");
    ambiguous = false;
    foreignAnnotation = true;
    await expect(
      recoverProvisionCleanupProgress({
        progress: partial,
        envelope: value.envelope,
        config: value.config,
        evidenceDirectory: evidence,
        readbackListingPath: target.readbackListingPath,
        runner,
        cwd: evidence,
      }),
    ).rejects.toThrow("replica_worker_owned_version_annotation_mismatch");
  });

  test("resumes partial cleanup and proves remote absence before terminal state", async () => {
    const value = authority();
    const evidence = await mkdtemp(join(tmpdir(), "store-replica-cleanup-"));
    roots.push(evidence);
    await chmod(evidence, 0o700);
    const progressPath = join(evidence, "worker-release-replica-progress.json");
    await writePrivateJson(progressPath, value.progress);
    const createReceipt = (
      name: string,
      resourceId?: string,
      liveReadbackDigest = `sha256:${"a".repeat(64)}`,
    ): Record<string, unknown> => ({
      accountId: value.progress.accountId,
      resourceName: name,
      ...(resourceId ? { resourceId } : {}),
      liveReadbackDigest,
      commandReceiptDigest: `sha256:${"b".repeat(64)}`,
      recovery: "direct",
      result: "exact-present",
      createdOnly: true,
    });
    const createOperation = (
      id: string,
      kind: "worker-upload" | "d1-create" | "kv-create" | "r2-create",
      resourceType: "worker" | "d1" | "kv" | "r2",
      name: string,
      resourceId?: string,
      liveReadbackDigest?: string,
    ): Record<string, unknown> => ({
      descriptor: {
        id,
        kind,
        resourceType,
        resourceName: name,
        expectedDigest: `sha256:${"c".repeat(64)}`,
      },
      phase: "committed",
      receipt: createReceipt(name, resourceId, liveReadbackDigest),
    });
    await writePrivateJson(
      join(evidence, "worker-release-replica-mutation-journal.json"),
      {
        kind: "takosumi.store-replica-mutation-journal@v1",
        surfaceId: "takosumi-store",
        releaseId: value.progress.releaseId,
        replicaId: value.progress.replicaId,
        accountId: value.progress.accountId,
        targetDigest: digestJson(value.progress.target),
        preflightAbsenceDigest: value.progress.preflightAbsenceDigest,
        operations: [
          createOperation(
            "provision:d1:create",
            "d1-create",
            "d1",
            value.config.target.databaseName,
            value.progress.resources[1]!.id,
          ),
          createOperation(
            "provision:kv:create",
            "kv-create",
            "kv",
            value.config.target.kvNamespaceName,
            value.progress.resources[2]!.id,
          ),
          createOperation(
            "provision:r2:create",
            "r2-create",
            "r2",
            value.config.target.iconsBucketName,
            undefined,
            digestJson({
              accountId: value.config.target.accountId,
              name: value.config.target.iconsBucketName,
              bucket: { name: value.config.target.iconsBucketName },
            }),
          ),
          createOperation(
            "provision:worker:upload",
            "worker-upload",
            "worker",
            value.config.target.workerName,
            value.progress.resources[0]!.id,
          ),
        ],
        productionFallback: false,
      },
    );
    const iconBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const icon = {
      key: `icons/${sha256Bytes(iconBytes).slice(7)}`,
      sha256: sha256Bytes(iconBytes),
      mediaType: "image/png",
      bytes: iconBytes,
    };
    const state = {
      worker: true,
      deployed: true,
      scriptEnabled: true,
      d1: true,
      kv: true,
      r2: true,
      object: true,
      failObjectOnce: true,
      failKvOnce: true,
      failD1Once: true,
      foreignVersion: false,
      r2Replacement: false,
    };
    const calls: string[][] = [];
    const runner = ((args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "delete") state.worker = false;
      if (args[0] === "d1" && args[1] === "delete") {
        if (state.failD1Once) {
          state.failD1Once = false;
          throw new Error("injected_d1_delete_failure");
        }
        state.d1 = false;
      }
      if (args[0] === "kv" && args[1] === "namespace" && args[2] === "delete") {
        if (state.failKvOnce) {
          state.failKvOnce = false;
          state.kv = false;
          throw new Error("injected_kv_delete_failure");
        }
        state.kv = false;
      }
      if (args[0] === "r2" && args[1] === "object" && args[2] === "delete") {
        state.object = false;
        if (state.failObjectOnce) {
          state.failObjectOnce = false;
          throw new Error("injected_r2_object_delete_response_loss");
        }
      }
      if (args[0] === "r2" && args[1] === "bucket" && args[2] === "delete")
        state.r2 = false;
      if (args[0] === "d1" && args[1] === "list") {
        return JSON.stringify(
          state.d1
            ? [
                {
                  name: value.config.target.databaseName,
                  uuid: value.progress.resources[1]!.id,
                },
              ]
            : [],
        );
      }
      if (args[0] === "kv" && args[1] === "namespace" && args[2] === "list") {
        return JSON.stringify(
          state.kv
            ? [
                {
                  title: value.config.target.kvNamespaceName,
                  id: value.progress.resources[2]!.id,
                },
              ]
            : [],
        );
      }
      if (args[0] === "kv" && args[1] === "key" && args[2] === "list") {
        return "[]";
      }
      if (args[0] === "versions" && args[1] === "view") {
        return JSON.stringify({
          id: value.progress.resources[0]!.id,
          annotations: {
            "workers/message": value.envelope.releaseId,
            "workers/tag": "0.1.13",
          },
          resources: {
            bindings: [
              {
                name: "DB",
                type: "d1",
                id: value.progress.resources[1]!.id,
                database_id: value.progress.resources[1]!.id,
              },
              {
                name: "KV",
                type: "kv_namespace",
                namespace_id: value.progress.resources[2]!.id,
              },
              {
                name: "ICONS",
                type: "r2_bucket",
                bucket_name: value.config.target.iconsBucketName,
              },
              { name: "ASSETS", type: "assets" },
              { name: "APP_URL", type: "plain_text" },
            ],
          },
        });
      }
      return "";
    }) as import("../scripts/store-release-common.ts").WranglerRunner;
    runner.inspect = (args) => {
      if (args[0] === "deployments") {
        return state.deployed
          ? {
              status: "ok",
              stdout: JSON.stringify({
                versions: [
                  {
                    version_id: value.progress.resources[0]!.id,
                    percentage: 100,
                  },
                ],
              }),
            }
          : { status: "not-found", stdout: "" };
      }
      if (args[0] === "versions") {
        return state.worker
          ? {
              status: "ok",
              stdout: JSON.stringify([
                { id: value.progress.resources[0]!.id },
                ...(state.foreignVersion
                  ? [{ id: "90000000-0000-4000-8000-000000000009" }]
                  : []),
              ]),
            }
          : { status: "not-found", stdout: "" };
      }
      if (args[0] === "r2" && args[1] === "object" && args[2] === "get") {
        if (!state.object) return { status: "not-found", stdout: "" };
        const file = args[args.indexOf("--file") + 1]!;
        writeFileSync(file, iconBytes);
        return { status: "ok", stdout: "" };
      }
      return { status: "failed", stdout: "" };
    };
    const cloudflareReadClient: CloudflareReadClient = {
      accountId: value.config.target.accountId,
      async get(path) {
        if (path.includes("/workers/scripts/")) {
          return state.worker
            ? {
                status: "ok",
                result: { enabled: state.scriptEnabled },
                resultInfo: null,
              }
            : { status: "not-found" };
        }
        if (path.endsWith("/r2/buckets")) {
          return {
            status: "ok",
            result: {
              buckets: state.r2
                ? [
                    {
                      name: value.config.target.iconsBucketName,
                      ...(state.r2Replacement
                        ? { creation_date: "2026-07-22T02:00:00.000Z" }
                        : {}),
                    },
                  ]
                : [],
            },
            resultInfo: null,
          };
        }
        if (path.includes("/objects")) {
          return {
            status: "ok",
            result: state.object ? [{ key: icon.key }] : [],
            resultInfo: null,
          };
        }
        throw new Error("unexpected_readback");
      },
    };
    const options = {
      inventory: value.progress,
      envelope: value.envelope,
      runner,
      cwd: evidence,
      progressPath,
      action: "destroy" as const,
      snapshotScan: snapshotScanFixture(icon, {
        snapshotDigest: "",
        sqlDigest: "",
        scannerDigest: "",
        sql: "",
      }),
      cloudflareReadClient,
      readbackListingPath: "/tcs/v1/listings/tako/takos",
    };
    state.r2Replacement = true;
    await expect(destroyExact(options)).rejects.toThrow(
      "replica_mutation_committed_readback_mismatch",
    );
    expect(calls.filter((args) => args[0] === "delete")).toHaveLength(0);
    state.r2Replacement = false;
    state.foreignVersion = true;
    await expect(destroyExact(options)).rejects.toThrow(
      "replica_worker_inventory_not_exclusive",
    );
    expect(calls.filter((args) => args[0] === "delete")).toHaveLength(0);
    state.foreignVersion = false;
    state.scriptEnabled = true;
    await expect(destroyExact(options)).rejects.toThrow(
      "injected_d1_delete_failure",
    );
    const partial = JSON.parse(await readFile(progressPath, "utf8"));
    expect(partial.status).toBe("destroying");
    expect(
      partial.resources.find(
        (entry: { type: string }) => entry.type === "worker",
      ).state,
    ).toBe("deleted");
    expect(
      partial.resources.find((entry: { type: string }) => entry.type === "r2")
        .state,
    ).toBe("deleted");
    const partialJournal = JSON.parse(
      await readFile(
        join(evidence, "worker-release-replica-mutation-journal.json"),
        "utf8",
      ),
    );
    expect(
      partialJournal.operations.find(
        (entry: { descriptor: { id: string } }) =>
          entry.descriptor.id === "cleanup:kv:delete",
      ),
    ).toMatchObject({
      phase: "committed",
      receipt: { recovery: "lost-response", result: "exact-absent" },
    });
    expect(
      partialJournal.operations.find(
        (entry: { descriptor: { kind: string } }) =>
          entry.descriptor.kind === "r2-object-delete",
      ),
    ).toMatchObject({
      phase: "committed",
      receipt: { recovery: "lost-response", result: "exact-absent" },
    });
    await expect(
      destroyExact({ ...options, inventory: partial }),
    ).resolves.toBeUndefined();
    const terminal = JSON.parse(await readFile(progressPath, "utf8"));
    expect(terminal.status).toBe("destroyed");
    expect(
      terminal.resources.every(
        (entry: { state: string }) => entry.state === "deleted",
      ),
    ).toBe(true);
    expect(calls.filter((args) => args[0] === "delete")).toHaveLength(1);
    expect(
      calls.find((args) => args[0] === "d1" && args[1] === "delete")?.[2],
    ).toBe(value.progress.resources[1]!.id);
  });
});
