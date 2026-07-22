import { describe, expect, test } from "bun:test";

import { assertSelfHostTarget } from "../scripts/self-host-deploy.ts";
import {
  validateRealizedConfig,
  type TargetPolicy,
} from "../scripts/store-release-common.ts";

const target: TargetPolicy = {
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

function realizedConfig(): string {
  return `name = "takosumi-store"
main = "src/backend/index.ts"
compatibility_date = "2026-06-25"
compatibility_flags = ["global_fetch_strictly_public", "nodejs_compat"]

[vars]
APP_URL = "https://store.takosumi.com"
TAKOSUMI_ACCOUNTS_CLIENT_ID = "public-client"
TAKOSUMI_ACCOUNTS_ISSUER_URL = "https://accounts.takosumi.com"

[[d1_databases]]
binding = "DB"
database_name = "takosumi-store-db"
database_id = "00000000-0000-4000-8000-000000000001"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "ICONS"
bucket_name = "takosumi-store-icons"

[[kv_namespaces]]
binding = "KV"
id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

[assets]
directory = "./dist"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"

[[routes]]
pattern = "store.takosumi.com"
custom_domain = true
`;
}

describe("realized Store release config closed-world validation", () => {
  test("accepts only the sealed worker and asset paths", () => {
    expect(
      validateRealizedConfig(Buffer.from(realizedConfig()), target),
    ).toBeTruthy();

    expect(() =>
      validateRealizedConfig(
        Buffer.from(realizedConfig().replace("./dist", "../dist")),
        target,
      ),
    ).toThrow("config_assets_directory_invalid");
    expect(() =>
      validateRealizedConfig(
        Buffer.from(
          realizedConfig().replace(
            'main = "src/backend/index.ts"',
            'main = "other-worker.ts"',
          ),
        ),
        target,
      ),
    ).toThrow("config_worker_entrypoint_mismatch");
  });

  test("rejects unknown top-level and nested keys", () => {
    const cases = [
      {
        input: realizedConfig().replace(
          'compatibility_flags = ["global_fetch_strictly_public", "nodejs_compat"]',
          'compatibility_flags = ["global_fetch_strictly_public", "nodejs_compat"]\nworkers_dev = true',
        ),
        error: "config_keys_invalid",
      },
      {
        input: realizedConfig().replace(
          'migrations_dir = "migrations"',
          'migrations_dir = "migrations"\npreview_database_id = "unreviewed"',
        ),
        error: "config_d1_binding_keys_invalid",
      },
      {
        input: realizedConfig().replace(
          'id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
          'id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\npreview_id = "unreviewed"',
        ),
        error: "config_kv_binding_keys_invalid",
      },
      {
        input: realizedConfig().replace(
          'bucket_name = "takosumi-store-icons"',
          'bucket_name = "takosumi-store-icons"\njurisdiction = "eu"',
        ),
        error: "config_icons_binding_keys_invalid",
      },
      {
        input: realizedConfig().replace(
          'not_found_handling = "single-page-application"',
          'not_found_handling = "single-page-application"\nhtml_handling = "auto-trailing-slash"',
        ),
        error: "config_assets_keys_invalid",
      },
      {
        input: realizedConfig().replace(
          "custom_domain = true",
          'custom_domain = true\nzone_name = "takosumi.com"',
        ),
        error: "config_route_keys_invalid",
      },
    ];

    for (const entry of cases) {
      expect(() =>
        validateRealizedConfig(Buffer.from(entry.input), target),
      ).toThrow(entry.error);
    }
  });

  test("requires one exact custom-domain route", () => {
    expect(() =>
      validateRealizedConfig(
        Buffer.from(
          realizedConfig().replace(
            'pattern = "store.takosumi.com"',
            'pattern = "store.takosumi.com/*"',
          ),
        ),
        target,
      ),
    ).toThrow("config_custom_domain_route_mismatch");
  });
});

function selfHostConfig(): Record<string, unknown> {
  return {
    name: "my-store",
    vars: { APP_URL: "https://store.example.com" },
    routes: [{ pattern: "store.example.com", custom_domain: true }],
    d1_databases: [{ database_name: "my-store-db", database_id: "opaque" }],
    kv_namespaces: [{ id: "opaque", title: "my-store-kv" }],
    r2_buckets: [{ bucket_name: "my-store-icons" }],
  };
}

describe("guarded self-host target identity", () => {
  test("allows a target with independent public identities", () => {
    expect(() => assertSelfHostTarget(selfHostConfig())).not.toThrow();
  });

  test("rejects every public/canonical official identity", () => {
    const cases: Record<string, unknown>[] = [
      { ...selfHostConfig(), name: "takosumi-store" },
      {
        ...selfHostConfig(),
        vars: { APP_URL: "https://store.takosumi.com/" },
      },
      {
        ...selfHostConfig(),
        routes: [{ pattern: "store.takosumi.com/*", custom_domain: true }],
      },
      { ...selfHostConfig(), route: "https://store.takosumi.com/*" },
      {
        ...selfHostConfig(),
        d1_databases: [{ database_name: "takosumi-store-db" }],
      },
      {
        ...selfHostConfig(),
        kv_namespaces: [{ id: "opaque", title: "takosumi-store-kv" }],
      },
      {
        ...selfHostConfig(),
        r2_buckets: [{ bucket_name: "takosumi-store-icons" }],
      },
    ];

    for (const config of cases) {
      expect(() => assertSelfHostTarget(config)).toThrow(
        "official_store_target_forbidden_in_self_host_wrapper",
      );
    }
  });
});
