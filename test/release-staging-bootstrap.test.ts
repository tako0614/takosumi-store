import { afterEach, describe, expect, test } from "bun:test";
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
  assertBootstrapAuthorityActive,
  assertStagingOnlyEnvironment,
  exactD1Id,
  exactDomain,
  exactKvId,
  exactR2,
  exactWorkerPresent,
  makeStagingConfig,
  planStoreStagingRecovery,
  provisionStoreStaging,
  quarantinedProgress,
  recoverExactlyOne,
  recoverWorkerVersion,
  validateBootstrapPolicy,
  type BootstrapEnvelope,
  type BootstrapPolicy,
  type BootstrapProgress,
} from "../scripts/store-staging-bootstrap-adapter.ts";
import {
  sha256Bytes,
  validateRealizedConfig,
  type CloudflareReadClient,
  type TargetPolicy,
  type WranglerRunner,
} from "../scripts/store-release-common.ts";

const accountId = "a".repeat(32);
const databaseId = "11111111-1111-4111-8111-111111111111";
const kvNamespaceId = "2".repeat(32);
const sourceCommit = "3".repeat(40);
const controllerCommit = "4".repeat(40);

const production: TargetPolicy = {
  configPath: "store/wrangler.production.toml",
  accountId,
  workerName: "takosumi-store",
  origin: "https://store.takosumi.com",
  databaseName: "takosumi-store-db",
  databaseId: "55555555-5555-4555-8555-555555555555",
  kvNamespaceId: "6".repeat(32),
  iconsBucketName: "takosumi-store-icons",
  publishCapability: true,
  compatibilityDate: "2026-07-22",
  compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
  requiredVarNames: [
    "APP_URL",
    "TAKOSUMI_ACCOUNTS_CLIENT_ID",
    "TAKOSUMI_ACCOUNTS_ISSUER_URL",
  ],
  requiredSecretNames: ["SESSION_HASH_SALT"],
  customDomainHostname: "store.takosumi.com",
  readbackListingPath: "/tcs/v1/listings/tako/takos",
};

const rawPolicy = {
  kind: "takosumi.store-staging-bootstrap-policy@v1",
  surfaceId: "takosumi-store",
  production,
  staging: {
    configPath: "store/wrangler.staging.toml",
    accountId,
    workerName: "takosumi-store-staging",
    origin: "https://store-staging.takosumi.com",
    databaseName: "takosumi-store-staging-db",
    kvNamespaceName: "takosumi-store-staging-kv",
    iconsBucketName: "takosumi-store-staging-icons",
    compatibilityDate: "2026-07-22",
    compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
    vars: {
      APP_URL: "https://store-staging.takosumi.com",
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-store-staging",
      TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.takosumi.com",
    },
    requiredSecretNames: ["SESSION_HASH_SALT"],
    customDomainHostname: "store-staging.takosumi.com",
    readbackListingPath: "/tcs/v1/listings/tako/takos",
  },
  cleanupPolicy: "destroy-only-before-adoption-or-first-candidate",
};

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("fixed one-time Store staging bootstrap", () => {
  test("accepts only the exact non-production identities and emits a closed realized config", () => {
    const policy = validateBootstrapPolicy(rawPolicy);
    const config = Buffer.from(
      makeStagingConfig(policy.staging, databaseId, kvNamespaceId),
    );
    const realized = validateRealizedConfig(config, {
      ...policy.staging,
      databaseId,
      kvNamespaceId,
      publishCapability: true,
      requiredVarNames: Object.keys(policy.staging.vars).sort(),
    });
    expect(realized.name).toBe("takosumi-store-staging");
    expect(config.toString()).not.toContain("takosumi-store-db");
    expect(config.toString()).not.toContain('store.takosumi.com"');
  });

  test("rejects placeholders and any production identity overlap", () => {
    expect(() =>
      validateBootstrapPolicy({
        ...rawPolicy,
        staging: { ...rawPolicy.staging, workerName: "takosumi-store" },
      }),
    ).toThrow("bootstrap_staging_identity_invalid");
    expect(() =>
      validateBootstrapPolicy({
        ...rawPolicy,
        staging: {
          ...rawPolicy.staging,
          vars: {
            ...rawPolicy.staging.vars,
            TAKOSUMI_ACCOUNTS_CLIENT_ID: "changeme",
          },
        },
      }),
    ).toThrow("bootstrap_placeholder_forbidden");
  });

  test("lost-response recovery accepts exactly one owner and fails closed on ambiguity", () => {
    expect(
      recoverExactlyOne(
        [{ name: "wanted" }],
        (value) => value.name === "wanted",
        "d1",
      ),
    ).toEqual({ name: "wanted" });
    expect(recoverExactlyOne([], () => true, "d1")).toBeNull();
    expect(() =>
      recoverExactlyOne(
        [{ name: "wanted" }, { name: "wanted" }],
        (value) => value.name === "wanted",
        "d1",
      ),
    ).toThrow("d1_ambiguous");
  });

  test("reads D1 and paginated KV ownership directly from Cloudflare API", async () => {
    const reads: string[] = [];
    const client: CloudflareReadClient = {
      accountId,
      async get(path, query) {
        reads.push(`${path}?${new URLSearchParams(query).toString()}`);
        if (path.endsWith("/d1/database")) {
          return {
            status: "ok",
            result: [
              { uuid: databaseId, name: rawPolicy.staging.databaseName },
            ],
            resultInfo: null,
          };
        }
        if (path.endsWith("/storage/kv/namespaces")) {
          const page = Number(query?.page);
          return {
            status: "ok",
            result:
              page === 2
                ? [
                    {
                      id: kvNamespaceId,
                      title: rawPolicy.staging.kvNamespaceName,
                    },
                  ]
                : [],
            resultInfo: { total_pages: 2 },
          };
        }
        throw new Error(`unexpected_read:${path}`);
      },
    };
    expect(await exactD1Id(client, rawPolicy.staging.databaseName)).toBe(
      databaseId,
    );
    expect(await exactKvId(client, rawPolicy.staging.kvNamespaceName)).toBe(
      kvNamespaceId,
    );
    expect(reads).toEqual([
      `/accounts/${accountId}/d1/database?name=takosumi-store-staging-db&per_page=100`,
      `/accounts/${accountId}/storage/kv/namespaces?title=takosumi-store-staging-kv&per_page=100&page=1`,
      `/accounts/${accountId}/storage/kv/namespaces?title=takosumi-store-staging-kv&per_page=100&page=2`,
    ]);
  });

  test("fails closed when direct Cloudflare API ownership is ambiguous", async () => {
    const client: CloudflareReadClient = {
      accountId,
      async get(path, query) {
        if (path.endsWith("/d1/database")) {
          return {
            status: "ok",
            result: [
              { uuid: databaseId, name: rawPolicy.staging.databaseName },
              {
                uuid: "99999999-9999-4999-8999-999999999999",
                name: rawPolicy.staging.databaseName,
              },
            ],
            resultInfo: null,
          };
        }
        return {
          status: "ok",
          result: [
            { id: kvNamespaceId, title: rawPolicy.staging.kvNamespaceName },
            {
              id: "9".repeat(32),
              title: rawPolicy.staging.kvNamespaceName,
            },
          ],
          resultInfo: { total_pages: 1 },
        };
      },
    };
    await expect(
      exactD1Id(client, rawPolicy.staging.databaseName),
    ).rejects.toThrow("bootstrap_d1_name_ambiguous");
    await expect(
      exactKvId(client, rawPolicy.staging.kvNamespaceName),
    ).rejects.toThrow("bootstrap_kv_name_ambiguous");
  });

  test("reads Worker presence and operation-owned Version directly from Cloudflare API", async () => {
    let versions: Record<string, unknown>[] = [];
    const versionId = "99999999-9999-4999-8999-999999999999";
    const client: CloudflareReadClient = {
      accountId,
      async get(path) {
        if (path.endsWith("/settings")) return { status: "not-found" };
        if (path.endsWith("/versions")) {
          return {
            status: "ok",
            result: { items: versions },
            resultInfo: null,
          };
        }
        if (path.endsWith(`/versions/${versionId}`)) {
          return {
            status: "ok",
            result: {
              id: versionId,
              annotations: {
                "workers/message": "store-staging-bootstrap-test-0001",
                "workers/tag": "staging-bootstrap-v1",
              },
            },
            resultInfo: null,
          };
        }
        if (path.endsWith("/deployments")) {
          return {
            status: "ok",
            result: { deployments: [] },
            resultInfo: null,
          };
        }
        throw new Error(`unexpected_worker_read:${path}`);
      },
    };
    expect(await exactWorkerPresent(client, rawPolicy.staging.workerName)).toBe(
      false,
    );
    versions = [{ id: versionId }];
    expect(await exactWorkerPresent(client, rawPolicy.staging.workerName)).toBe(
      true,
    );
    expect(
      await recoverWorkerVersion(
        client,
        rawPolicy.staging.workerName,
        "store-staging-bootstrap-test-0001",
      ),
    ).toMatchObject({ id: versionId });
  });

  test("reads exact R2 and custom-domain present and absent states", async () => {
    let bucketPresent = false;
    let domainOwner: string | null = null;
    const client: CloudflareReadClient = {
      accountId,
      async get(path, query) {
        if (path.endsWith("/r2/buckets")) {
          expect(query).toEqual({
            name_contains: rawPolicy.staging.iconsBucketName,
            per_page: "1000",
          });
          return {
            status: "ok",
            result: {
              buckets: bucketPresent
                ? [{ name: rawPolicy.staging.iconsBucketName }]
                : [],
            },
            resultInfo: null,
          };
        }
        if (path.endsWith("/workers/domains")) {
          expect(query).toEqual({
            hostname: rawPolicy.staging.customDomainHostname,
          });
          return {
            status: "ok",
            result: domainOwner
              ? [
                  {
                    id: "domain-1",
                    hostname: rawPolicy.staging.customDomainHostname,
                    service: domainOwner,
                  },
                ]
              : [],
            resultInfo: null,
          };
        }
        throw new Error(`unexpected_topology_read:${path}`);
      },
    };
    expect(
      await exactR2(client, rawPolicy.staging.iconsBucketName),
    ).toBeFalse();
    expect(
      await exactDomain(
        client,
        rawPolicy.staging.customDomainHostname,
        rawPolicy.staging.workerName,
      ),
    ).toBeNull();
    bucketPresent = true;
    domainOwner = rawPolicy.staging.workerName;
    expect(await exactR2(client, rawPolicy.staging.iconsBucketName)).toBeTrue();
    expect(
      await exactDomain(
        client,
        rawPolicy.staging.customDomainHostname,
        rawPolicy.staging.workerName,
      ),
    ).toMatchObject({ service: rawPolicy.staging.workerName });
    domainOwner = "wrong-worker";
    await expect(
      exactDomain(
        client,
        rawPolicy.staging.customDomainHostname,
        rawPolicy.staging.workerName,
      ),
    ).rejects.toThrow("bootstrap_domain_owner_mismatch");
  });

  test("adoption permanently revokes cleanup and quarantine retains backing storage", () => {
    const progress: BootstrapProgress = {
      kind: "takosumi.store-staging-bootstrap-progress@v1",
      operationId: "store-staging-bootstrap-test-0001",
      status: "provisioned",
      resources: [
        { type: "d1", name: "db", state: "present" },
        { type: "kv", name: "kv", state: "present" },
        { type: "r2", name: "r2", state: "present" },
        { type: "worker", name: "worker", state: "present" },
        { type: "custom-domain", name: "domain", state: "present" },
      ],
      steps: [],
      productionFallback: false,
    };
    const quarantined = quarantinedProgress(progress);
    expect(quarantined.resources.map((resource) => resource.state)).toEqual([
      "retained-quarantined",
      "retained-quarantined",
      "retained-quarantined",
      "retained-quarantined",
      "disabled",
    ]);
    expect(() =>
      assertBootstrapAuthorityActive({ ...progress, status: "adopted" }),
    ).toThrow("bootstrap_authority_permanently_adopted");
  });

  test("rejects raw and non-staging credential environments", () => {
    process.env.CLOUDFLARE_API_TOKEN = "forbidden";
    try {
      expect(() => assertStagingOnlyEnvironment()).toThrow(
        "bootstrap_non_staging_credential_forbidden",
      );
    } finally {
      delete process.env.CLOUDFLARE_API_TOKEN;
    }
    process.env.TAKOSUMI_RELEASE_PRODUCTION_API_TOKEN_FILE = "/forbidden";
    try {
      expect(() => assertStagingOnlyEnvironment()).toThrow(
        "bootstrap_non_staging_credential_forbidden",
      );
    } finally {
      delete process.env.TAKOSUMI_RELEASE_PRODUCTION_API_TOKEN_FILE;
    }
  });

  test("records every create intent before the first mutation and marks an unknown response fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "store-bootstrap-test-"));
    temporary.push(root);
    const evidence = join(root, "evidence");
    await chmod(root, 0o700);
    await mkdir(evidence, { mode: 0o700 });
    const secretPath = join(root, "secret");
    await writeFile(secretPath, "x".repeat(64), { mode: 0o600 });
    const policy = validateBootstrapPolicy(rawPolicy) as BootstrapPolicy;
    let firstMutationObserved = false;
    const runner = ((args: readonly string[]) => {
      throw new Error(`unexpected:${args.join(" ")}`);
    }) as WranglerRunner;
    runner.inspect = () => ({ status: "not-found", stdout: "" });
    const client: CloudflareReadClient = {
      accountId,
      async get(path, query) {
        if (path.endsWith("/settings")) return { status: "not-found" };
        if (path.endsWith("/versions")) {
          return {
            status: "ok",
            result: { items: [] },
            resultInfo: null,
          };
        }
        if (path.endsWith("/deployments")) {
          return {
            status: "ok",
            result: { deployments: [] },
            resultInfo: null,
          };
        }
        if (
          path.endsWith("/d1/database") ||
          path.endsWith("/storage/kv/namespaces") ||
          path.endsWith("/r2/buckets") ||
          path.endsWith("/workers/domains")
        ) {
          return { status: "ok", result: [], resultInfo: null };
        }
        if (path === "/zones") {
          return {
            status: "ok",
            result: [
              {
                id: "zone-1",
                name: "takosumi.com",
                account: { id: accountId },
              },
            ],
            resultInfo: null,
          };
        }
        if (path === "/zones/zone-1/dns_records") {
          return { status: "ok", result: [], resultInfo: null };
        }
        throw new Error(`unexpected_read:${path}`);
      },
    };
    const envelope: BootstrapEnvelope = {
      kind: "takosumi.store-staging-bootstrap-envelope@v1",
      operationId: "store-staging-bootstrap-test-0001",
      surfaceId: "takosumi-store",
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      source: {
        repository: "https://github.com/tako0614/takosumi-store.git",
        commit: sourceCommit,
        clean: true,
        pushed: true,
      },
      controllerSource: {
        repository: "https://github.com/tako0614/takos-ecosystem.git",
        commit: controllerCommit,
        clean: true,
        pushed: true,
      },
      authority: {
        adapterDigest: `sha256:${"7".repeat(64)}`,
        operatorPolicyDigest: `sha256:${"8".repeat(64)}`,
      },
      evidence: {
        directory: evidence,
        permissions: "0700-directory/0600-files",
      },
      productionFallback: false,
    };
    await expect(
      provisionStoreStaging({
        envelope,
        policy,
        source: root,
        evidence,
        secretPath,
        runner,
        client,
        mutationClient: {
          async request(method, path) {
            expect(method).toBe("POST");
            expect(path).toEndWith("/d1/database");
            firstMutationObserved = true;
            throw new Error("simulated_lost_response");
          },
        },
      }),
    ).rejects.toThrow("simulated_lost_response");
    expect(firstMutationObserved).toBeTrue();
    const progress = JSON.parse(
      await readFile(
        join(evidence, "store-staging-bootstrap-progress.json"),
        "utf8",
      ),
    );
    expect(progress.steps).toContain(
      "all-create-intents-recorded-before-first-mutation",
    );
    expect(
      progress.resources.map((resource: { state: string }) => resource.state),
    ).toEqual([
      "presence-unknown",
      "intent-recorded",
      "intent-recorded",
      "intent-recorded",
      "intent-recorded",
    ]);
  });

  test("resumes exact partial storage from a progress digest without recreating owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "store-bootstrap-resume-test-"));
    temporary.push(root);
    const evidence = join(root, "evidence");
    await chmod(root, 0o700);
    await mkdir(evidence, { mode: 0o700 });
    const secretPath = join(root, "secret");
    await writeFile(secretPath, "x".repeat(64), { mode: 0o600 });
    const progress: BootstrapProgress = {
      kind: "takosumi.store-staging-bootstrap-progress@v1",
      operationId: "store-staging-bootstrap-test-0001",
      status: "provisioning",
      resources: [
        {
          type: "d1",
          name: rawPolicy.staging.databaseName,
          state: "present",
          id: databaseId,
        },
        {
          type: "kv",
          name: rawPolicy.staging.kvNamespaceName,
          state: "present",
          id: kvNamespaceId,
        },
        {
          type: "r2",
          name: rawPolicy.staging.iconsBucketName,
          state: "presence-unknown",
        },
        {
          type: "worker",
          name: rawPolicy.staging.workerName,
          state: "intent-recorded",
        },
        {
          type: "custom-domain",
          name: rawPolicy.staging.customDomainHostname,
          state: "intent-recorded",
        },
      ],
      steps: ["all-create-intents-recorded-before-first-mutation"],
      productionFallback: false,
    };
    const progressBytes = `${JSON.stringify(progress)}\n`;
    await writeFile(
      join(evidence, "store-staging-bootstrap-progress.json"),
      progressBytes,
      { mode: 0o600 },
    );
    const envelope: BootstrapEnvelope = {
      kind: "takosumi.store-staging-bootstrap-envelope@v1",
      operationId: progress.operationId,
      surfaceId: "takosumi-store",
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      source: {
        repository: "https://github.com/tako0614/takosumi-store.git",
        commit: sourceCommit,
        clean: true,
        pushed: true,
      },
      controllerSource: {
        repository: "https://github.com/tako0614/takos-ecosystem.git",
        commit: controllerCommit,
        clean: true,
        pushed: true,
      },
      authority: {
        adapterDigest: `sha256:${"7".repeat(64)}`,
        operatorPolicyDigest: `sha256:${"8".repeat(64)}`,
        recoveryProgressDigest: sha256Bytes(progressBytes),
      },
      evidence: {
        directory: evidence,
        permissions: "0700-directory/0600-files",
      },
      productionFallback: false,
    };
    const planClient: CloudflareReadClient = {
      accountId,
      async get(path, query) {
        if (path.endsWith("/settings")) return { status: "not-found" };
        if (path.endsWith("/versions")) {
          return {
            status: "ok",
            result: { items: [] },
            resultInfo: null,
          };
        }
        if (path.endsWith("/deployments")) {
          return {
            status: "ok",
            result: { deployments: [] },
            resultInfo: null,
          };
        }
        if (path.endsWith("/d1/database")) {
          return {
            status: "ok",
            result: [
              { uuid: databaseId, name: rawPolicy.staging.databaseName },
            ],
            resultInfo: null,
          };
        }
        if (path.endsWith("/storage/kv/namespaces")) {
          return {
            status: "ok",
            result: [
              { id: kvNamespaceId, title: rawPolicy.staging.kvNamespaceName },
            ],
            resultInfo: { total_pages: 1 },
          };
        }
        if (path.endsWith("/r2/buckets")) {
          expect(query).toEqual({
            name_contains: rawPolicy.staging.iconsBucketName,
            per_page: "1000",
          });
          return {
            status: "ok",
            result: { buckets: [{ name: rawPolicy.staging.iconsBucketName }] },
            resultInfo: null,
          };
        }
        if (path.endsWith("/workers/domains")) {
          return { status: "ok", result: [], resultInfo: null };
        }
        throw new Error(`unexpected_plan_read:${path}`);
      },
    };
    const planRunner = (() => {
      throw new Error("recovery_plan_must_not_mutate");
    }) as WranglerRunner;
    planRunner.inspect = () => ({ status: "not-found", stdout: "" });
    const recoveryPlan = await planStoreStagingRecovery({
      envelope,
      policy: validateBootstrapPolicy(rawPolicy),
      evidence,
      source: root,
      runner: planRunner,
      client: planClient,
    });
    expect(recoveryPlan.nextAbsentResource).toBe("worker");
    expect(recoveryPlan.productionFallback).toBeFalse();
    const client: CloudflareReadClient = {
      accountId,
      async get(path, query) {
        if (path.endsWith("/d1/database")) {
          return {
            status: "ok",
            result: [
              { uuid: databaseId, name: rawPolicy.staging.databaseName },
            ],
            resultInfo: null,
          };
        }
        if (path.endsWith("/storage/kv/namespaces")) {
          return {
            status: "ok",
            result: [
              { id: kvNamespaceId, title: rawPolicy.staging.kvNamespaceName },
            ],
            resultInfo: { total_pages: 1 },
          };
        }
        if (path.endsWith("/r2/buckets")) {
          expect(query).toEqual({
            name_contains: rawPolicy.staging.iconsBucketName,
            per_page: "1000",
          });
          return {
            status: "ok",
            result: { buckets: [] },
            resultInfo: null,
          };
        }
        throw new Error(`unexpected_read:${path}`);
      },
    };
    const runner = (() => {
      throw new Error("runner_must_not_recreate_recovered_storage");
    }) as WranglerRunner;
    await expect(
      provisionStoreStaging({
        envelope,
        policy: validateBootstrapPolicy(rawPolicy),
        source: root,
        evidence,
        secretPath,
        runner,
        client,
        mutationClient: {
          async request(method, path, body) {
            expect(method).toBe("POST");
            expect(path).toEndWith("/r2/buckets");
            expect(body).toEqual({ name: rawPolicy.staging.iconsBucketName });
            throw new Error("simulated_r2_permission_denied");
          },
        },
      }),
    ).rejects.toThrow("simulated_r2_permission_denied");
    const retained = JSON.parse(
      await readFile(
        join(evidence, "store-staging-bootstrap-progress.json"),
        "utf8",
      ),
    );
    expect(retained.resources.slice(0, 3)).toEqual([
      {
        type: "d1",
        name: rawPolicy.staging.databaseName,
        state: "present",
        id: databaseId,
      },
      {
        type: "kv",
        name: rawPolicy.staging.kvNamespaceName,
        state: "present",
        id: kvNamespaceId,
      },
      {
        type: "r2",
        name: rawPolicy.staging.iconsBucketName,
        state: "presence-unknown",
      },
    ]);
  });
});
