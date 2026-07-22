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
  makeStagingConfig,
  provisionStoreStaging,
  quarantinedProgress,
  recoverExactlyOne,
  validateBootstrapPolicy,
  type BootstrapEnvelope,
  type BootstrapPolicy,
  type BootstrapProgress,
} from "../scripts/store-staging-bootstrap-adapter.ts";
import {
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
      const command = args.join(" ");
      if (command === "d1 list --json" || command === "kv namespace list")
        return "[]";
      if (command === `d1 create ${policy.staging.databaseName}`) {
        firstMutationObserved = true;
        throw new Error("simulated_lost_response");
      }
      throw new Error(`unexpected:${command}`);
    }) as WranglerRunner;
    runner.inspect = () => ({ status: "not-found", stdout: "" });
    const client: CloudflareReadClient = {
      accountId,
      async get(path) {
        if (path.endsWith("/r2/buckets") || path.endsWith("/workers/domains")) {
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
});
