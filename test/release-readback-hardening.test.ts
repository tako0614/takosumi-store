import { describe, expect, test } from "bun:test";

import {
  assertVersionBindings,
  deploymentHasExactVersionAtFullTraffic,
  type TargetPolicy,
} from "../scripts/store-release-common.ts";

const VERSION_ID = "10000000-0000-4000-8000-000000000001";

function target(): TargetPolicy {
  return {
    configPath: "store/wrangler.production.toml",
    accountId: "a".repeat(32),
    workerName: "takosumi-store",
    origin: "https://store.takosumi.com",
    databaseName: "takosumi-store-db",
    databaseId: "00000000-0000-4000-8000-000000000001",
    kvNamespaceId: "b".repeat(32),
    iconsBucketName: "takosumi-store-icons",
    publishCapability: true,
    compatibilityDate: "2026-06-25",
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
}

function bindings(value: TargetPolicy): Record<string, unknown>[] {
  return [
    {
      name: "DB",
      type: "d1",
      id: value.databaseId,
      database_id: value.databaseId,
    },
    {
      name: "KV",
      type: "kv_namespace",
      namespace_id: value.kvNamespaceId,
    },
    {
      name: "ICONS",
      type: "r2_bucket",
      bucket_name: value.iconsBucketName,
    },
    { name: "ASSETS", type: "assets" },
    ...value.requiredVarNames.map((name) => ({
      name,
      type: "plain_text",
    })),
    ...value.requiredSecretNames.map((name) => ({
      name,
      type: "secret_text",
    })),
  ];
}

function version(
  value: TargetPolicy,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: VERSION_ID,
    resources: { bindings: bindings(value) },
    ...overrides,
  };
}

describe("Store Worker binding readback", () => {
  test("accepts exact DB, KV, and R2 identities on their binding records", () => {
    const expected = target();
    expect(() =>
      assertVersionBindings(version(expected), VERSION_ID, expected),
    ).not.toThrow();
  });

  test("rejects swapped or decoy identities outside the expected binding", () => {
    const expected = target();
    const base = bindings(expected);
    const cases = [
      base.map((binding) =>
        binding.name === "DB"
          ? {
              ...binding,
              id: "00000000-0000-4000-8000-000000000009",
              database_id: "00000000-0000-4000-8000-000000000009",
              decoy: expected.databaseId,
            }
          : binding,
      ),
      base.map((binding) =>
        binding.name === "KV"
          ? {
              ...binding,
              namespace_id: expected.databaseId,
              decoy: expected.kvNamespaceId,
            }
          : binding,
      ),
      base.map((binding) =>
        binding.name === "ICONS"
          ? {
              ...binding,
              bucket_name: "not-the-store-icons-bucket",
              decoy: expected.iconsBucketName,
            }
          : binding,
      ),
    ];

    for (const candidateBindings of cases) {
      expect(() =>
        assertVersionBindings(
          version(expected, {
            resources: { bindings: candidateBindings },
            decoys: {
              databaseId: expected.databaseId,
              kvNamespaceId: expected.kvNamespaceId,
              iconsBucketName: expected.iconsBucketName,
            },
          }),
          VERSION_ID,
          expected,
        ),
      ).toThrow("worker_version_binding_identity_mismatch");
    }
  });

  test("rejects a version-id decoy outside the top-level version record", () => {
    const expected = target();
    expect(() =>
      assertVersionBindings(
        version(expected, {
          id: "20000000-0000-4000-8000-000000000002",
          metadata: { expectedVersionId: VERSION_ID },
        }),
        VERSION_ID,
        expected,
      ),
    ).toThrow(`worker_version_binding_mismatch:${VERSION_ID}`);
  });
});

describe("Store Worker deployment readback", () => {
  const exact = {
    id: "deployment-id",
    versions: [{ version_id: VERSION_ID, percentage: 100 }],
  };

  test("accepts only the current deployment's single numeric 100 allocation", () => {
    expect(deploymentHasExactVersionAtFullTraffic(exact, VERSION_ID)).toBe(
      true,
    );
    expect(
      deploymentHasExactVersionAtFullTraffic(
        {
          ...exact,
          versions: [{ version_id: VERSION_ID, percentage: 1 }],
        },
        VERSION_ID,
      ),
    ).toBe(false);
    expect(
      deploymentHasExactVersionAtFullTraffic(
        {
          ...exact,
          versions: [{ version_id: VERSION_ID, percentage: "100" }],
        },
        VERSION_ID,
      ),
    ).toBe(false);
  });

  test("rejects aliases, nested decoys, and non-singleton allocations", () => {
    for (const value of [
      [exact],
      { deployment: exact },
      { versions: [{ versionId: VERSION_ID, percentage: 100 }] },
      { versions: [{ version_id: VERSION_ID, traffic: 100 }] },
      {
        versions: [
          { version_id: VERSION_ID, percentage: 100 },
          {
            version_id: "20000000-0000-4000-8000-000000000002",
            percentage: 0,
          },
        ],
      },
    ]) {
      expect(deploymentHasExactVersionAtFullTraffic(value, VERSION_ID)).toBe(
        false,
      );
    }
  });
});
