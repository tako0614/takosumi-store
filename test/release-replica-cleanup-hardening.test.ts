import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  digestJson,
  sha256Bytes,
  writePrivateJson,
  type CloudflareReadClient,
  type ReleaseEnvelope,
} from "../scripts/store-release-common.ts";
import {
  assertInventoryDigest,
  destroyExact,
  exactD1DatabaseId,
  exactKvNamespaceId,
  validateInventory,
  validateProgress,
  type Inventory,
  type Progress,
  type ReplicaConfig,
} from "../scripts/store-release-replica-adapter.ts";

const roots: string[] = [];

afterEach(async () => {
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

describe("replica cleanup authority", () => {
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
  });

  test("resumes partial cleanup and proves remote absence before terminal state", async () => {
    const value = authority();
    const evidence = await mkdtemp(join(tmpdir(), "store-replica-cleanup-"));
    roots.push(evidence);
    await chmod(evidence, 0o700);
    const progressPath = join(evidence, "worker-release-replica-progress.json");
    await writePrivateJson(progressPath, value.progress);
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
      d1: true,
      kv: true,
      r2: true,
      object: true,
      failKvOnce: true,
    };
    const calls: string[][] = [];
    const runner = ((args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "delete") state.worker = false;
      if (args[0] === "d1" && args[1] === "delete") state.d1 = false;
      if (args[0] === "kv" && args[1] === "namespace" && args[2] === "delete") {
        if (state.failKvOnce) {
          state.failKvOnce = false;
          throw new Error("injected_kv_delete_failure");
        }
        state.kv = false;
      }
      if (args[0] === "r2" && args[1] === "object" && args[2] === "delete")
        state.object = false;
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
      return "";
    }) as import("../scripts/store-release-common.ts").WranglerRunner;
    runner.inspect = (args) => {
      if (args[0] === "versions") {
        return state.worker
          ? {
              status: "ok",
              stdout: JSON.stringify([{ id: value.progress.resources[0]!.id }]),
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
            ? { status: "ok", result: { enabled: true }, resultInfo: null }
            : { status: "not-found" };
        }
        if (path.endsWith("/r2/buckets")) {
          return {
            status: "ok",
            result: {
              buckets: state.r2
                ? [{ name: value.config.target.iconsBucketName }]
                : [],
            },
            resultInfo: null,
          };
        }
        if (path.includes("/objects")) {
          return {
            status: "ok",
            result: { objects: state.object ? [{ key: icon.key }] : [] },
            resultInfo: null,
          };
        }
        throw new Error("unexpected_readback");
      },
    };
    const options = {
      inventory: value.progress,
      runner,
      cwd: evidence,
      progressPath,
      action: "destroy" as const,
      snapshotScan: {
        snapshotDigest: "",
        sqlDigest: "",
        scannerDigest: "",
        sql: "",
        icons: [icon],
      },
      cloudflareReadClient,
    };
    await expect(destroyExact(options)).rejects.toThrow(
      "injected_kv_delete_failure",
    );
    const partial = JSON.parse(await readFile(progressPath, "utf8"));
    expect(partial.status).toBe("destroying");
    expect(
      partial.resources.find(
        (entry: { type: string }) => entry.type === "worker",
      ).state,
    ).toBe("deleted");
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
  });
});
