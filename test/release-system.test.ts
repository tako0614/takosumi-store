import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REPLICA_CHECK_NAMES,
  assertVersionBindings,
  canonicalJson,
  deploymentHasExactVersionAtFullTraffic,
  sha256Bytes,
  validatePolicy,
  validateRealizedConfig,
  writePrivateJson,
  type ReleaseEnvelope,
  type StoreArtifactManifest,
  type StoreReleasePolicy,
  type TargetPolicy,
} from "../scripts/store-release-common.ts";
import { deploySealedStore } from "../scripts/store-release-fixed-adapter.ts";
import { scanSanitizedSnapshot } from "../scripts/store-release-replica-adapter.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function target(overrides: Partial<TargetPolicy> = {}): TargetPolicy {
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
    ...overrides,
  };
}

function policy(): StoreReleasePolicy {
  return {
    kind: "takosumi.store-release-policy@v1",
    surfaceId: "takosumi-store",
    production: target(),
    staging: target({
      configPath: "store/wrangler.staging.toml",
      workerName: "takosumi-store-staging",
      origin: "https://store-staging.takosumi.com",
      databaseName: "takosumi-store-staging-db",
      databaseId: "00000000-0000-4000-8000-000000000002",
      kvNamespaceId: "c".repeat(32),
      iconsBucketName: "takosumi-store-staging-icons",
      customDomainHostname: "store-staging.takosumi.com",
    }),
  };
}

function configToml(value: TargetPolicy): string {
  return `name = ${JSON.stringify(value.workerName)}
main = "src/backend/index.ts"
compatibility_date = ${JSON.stringify(value.compatibilityDate)}
compatibility_flags = ["global_fetch_strictly_public", "nodejs_compat"]

[vars]
APP_URL = ${JSON.stringify(value.origin)}
TAKOSUMI_ACCOUNTS_CLIENT_ID = "public-client"
TAKOSUMI_ACCOUNTS_ISSUER_URL = "https://accounts.takosumi.com"

[[d1_databases]]
binding = "DB"
database_name = ${JSON.stringify(value.databaseName)}
database_id = ${JSON.stringify(value.databaseId)}
migrations_dir = "migrations"

[[r2_buckets]]
binding = "ICONS"
bucket_name = ${JSON.stringify(value.iconsBucketName)}

[[kv_namespaces]]
binding = "KV"
id = ${JSON.stringify(value.kvNamespaceId)}

[assets]
directory = "./dist"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"

[[routes]]
pattern = ${JSON.stringify(value.customDomainHostname)}
custom_domain = true
`;
}

describe("Store release policy and realized config", () => {
  test("accepts only the official production identity and isolated staging", () => {
    expect(validatePolicy(policy())).toEqual(policy());
    expect(() =>
      validatePolicy({
        ...policy(),
        production: target({
          origin: "https://other.example",
          customDomainHostname: "other.example",
        }),
      }),
    ).toThrow("official_production_target_identity_invalid");
    expect(() =>
      validatePolicy({
        ...policy(),
        staging: target(),
      }),
    ).toThrow("staging_target_overlaps_production");
  });

  test("binds runtime, vars, DB, KV, R2, assets, and custom domain", () => {
    const production = target();
    expect(
      validateRealizedConfig(Buffer.from(configToml(production)), production),
    ).toBeTruthy();
    expect(() =>
      validateRealizedConfig(
        Buffer.from(
          configToml(production).replace(
            'TAKOSUMI_ACCOUNTS_CLIENT_ID = "public-client"',
            'EXTRA = "unreviewed"',
          ),
        ),
        production,
      ),
    ).toThrow("config_var_name_set_mismatch");
  });

  test("rejects extra remote bindings instead of trusting --keep-vars", () => {
    const production = target();
    const base = [
      { name: "DB", type: "d1", id: production.databaseId },
      {
        name: "KV",
        type: "kv_namespace",
        namespace_id: production.kvNamespaceId,
      },
      {
        name: "ICONS",
        type: "r2_bucket",
        bucket_name: production.iconsBucketName,
      },
      { name: "ASSETS", type: "assets" },
      ...production.requiredVarNames.map((name) => ({
        name,
        type: "plain_text",
      })),
      ...production.requiredSecretNames.map((name) => ({
        name,
        type: "secret_text",
      })),
    ];
    const version = {
      id: "10000000-0000-4000-8000-000000000001",
      resources: { bindings: base },
    };
    expect(() =>
      assertVersionBindings(
        version,
        "10000000-0000-4000-8000-000000000001",
        production,
      ),
    ).not.toThrow();
    expect(() =>
      assertVersionBindings(
        {
          ...version,
          resources: {
            bindings: [...base, { name: "OLD_SECRET", type: "secret_text" }],
          },
        },
        "10000000-0000-4000-8000-000000000001",
        production,
      ),
    ).toThrow("worker_version_binding_set_mismatch");
  });
});

describe("release mutation safety", () => {
  test("retains schema-applied authority when upload fails after D1 mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "store-release-journal-test-"));
    temporaryRoots.push(root);
    await chmod(root, 0o700);
    const journalPath = join(root, "output/operation.json");
    const migrationNames = [
      "0001_init.sql",
      "0002_accounts.sql",
      "0003_scope_slug.sql",
      "0004_tags.sql",
      "0005_install_experience.sql",
      "0006_source_identity.sql",
    ];
    const calls: string[][] = [];
    const runner = (args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "deployments") return "[]";
      if (args[0] === "d1" && args[1] === "migrations" && args[2] === "list") {
        return "No migrations to apply.";
      }
      if (args[0] === "d1" && args[1] === "execute") {
        return JSON.stringify([
          { results: migrationNames.map((name) => ({ name })) },
        ]);
      }
      if (args[0] === "versions" && args[1] === "upload") {
        throw new Error("injected_upload_failure");
      }
      return "";
    };
    const envelope = {
      releaseId: "takosumi-store-0.1.2-attempt-1",
      source: { commit: "d".repeat(40) },
      candidate: { artifactDigests: ["sha256:a", "sha256:b", "sha256:c"] },
    } as unknown as ReleaseEnvelope;
    const manifest = {
      migrations: migrationNames.map((name) => ({
        path: `migrations/${name}`,
      })),
    } as unknown as StoreArtifactManifest;
    await expect(
      deploySealedStore({
        runner,
        cwd: root,
        target: target(),
        envelope,
        manifest,
        candidateChecks: [],
        readTopology: async () => ({ mode: "test" }),
        journal: {
          path: journalPath,
          environment: "production",
          targetFingerprint: `sha256:${"e".repeat(64)}`,
        },
      }),
    ).rejects.toThrow("injected_upload_failure");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    expect(journal.phase).toBe("schema-applied");
    expect(journal.versionId).toBeNull();
    expect(journal.artifactDigests).toEqual(envelope.candidate.artifactDigests);
    expect(
      calls.some(
        (args) =>
          args[0] === "d1" && args[1] === "migrations" && args[2] === "apply",
      ),
    ).toBe(true);
  });

  test("requires exact deployment version at full traffic", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    expect(
      deploymentHasExactVersionAtFullTraffic(
        { versions: [{ version_id: id, percentage: 100 }] },
        id,
      ),
    ).toBe(true);
    expect(
      deploymentHasExactVersionAtFullTraffic(
        { versions: [{ version_id: id, percentage: 99 }] },
        id,
      ),
    ).toBe(false);
  });

  test("private evidence is create-only unless an explicit atomic replacement is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "store-release-private-test-"));
    temporaryRoots.push(root);
    await chmod(root, 0o700);
    const path = join(root, "evidence.json");
    await writePrivateJson(path, { status: "intent" });
    await expect(
      writePrivateJson(path, { status: "changed" }),
    ).rejects.toThrow();
    await writePrivateJson(path, { status: "advanced" }, { replace: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      status: "advanced",
    });
  });
});

describe("fresh replica evidence", () => {
  test("uses the controller's exact four replica checks", () => {
    expect(REPLICA_CHECK_NAMES).toEqual([
      "fresh Store Worker exact Version, bindings, and asset readback",
      "fresh D1 migration lineage and sanitized catalog integrity",
      "TCS ServerInfo, listings, SPA, and API fallback behavior",
      "isolated target cleanup and forward-repair rehearsal",
    ]);
  });

  test("rejects snapshots containing production identity or credential literals", () => {
    const production = target();
    const icon = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const iconDigest = sha256Bytes(icon);
    const bundle = (
      sql: string,
      icons: unknown[] = [
        {
          key: `icons/${iconDigest.slice(7)}`,
          mediaType: "image/png",
          bytesBase64: icon.toString("base64"),
          sha256: iconDigest,
        },
      ],
    ) => {
      const sqlBytes = Buffer.from(sql);
      return Buffer.from(
        JSON.stringify({
          kind: "takosumi.store-sanitized-replica-bundle@v1",
          sqlBase64: sqlBytes.toString("base64"),
          sqlSha256: sha256Bytes(sqlBytes),
          icons,
        }),
      );
    };
    const safe = bundle(
      `BEGIN; INSERT INTO listings(id, icon_url) VALUES ('tako/takos', '{{TAKOSUMI_STORE_REPLICA_ORIGIN}}/icons/${iconDigest.slice(7)}'); COMMIT;`,
    );
    const proof = scanSanitizedSnapshot(safe, production);
    expect(proof.snapshotDigest).toBe(sha256Bytes(safe));
    expect(proof.scannerDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() =>
      scanSanitizedSnapshot(
        bundle(
          `INSERT INTO listings(id, icon_url) VALUES ('tako/takos', '${production.databaseId}/icons/${iconDigest.slice(7)}'); -- {{TAKOSUMI_STORE_REPLICA_ORIGIN}}`,
        ),
        production,
      ),
    ).toThrow("replica_snapshot_contains_production_identity");
    expect(() =>
      scanSanitizedSnapshot(
        bundle(
          `INSERT INTO listings(id, icon_url, secret) VALUES ('tako/takos', '{{TAKOSUMI_STORE_REPLICA_ORIGIN}}/icons/${iconDigest.slice(7)}', 'sk_live_not_allowed');`,
        ),
        production,
      ),
    ).toThrow("replica_snapshot_credential_literal_detected");
    expect(() =>
      scanSanitizedSnapshot(
        bundle(
          `INSERT INTO listings(id, icon_url) VALUES ('tako/takos', '{{TAKOSUMI_STORE_REPLICA_ORIGIN}}/icons/${iconDigest.slice(7)}');`,
          [],
        ),
        production,
      ),
    ).toThrow("replica_snapshot_bundle_shape_invalid");
    for (const table of ["publishers", "sessions", "reports"]) {
      expect(() =>
        scanSanitizedSnapshot(
          bundle(
            `INSERT INTO ${table}(id) VALUES ('private-row'); -- tako/takos {{TAKOSUMI_STORE_REPLICA_ORIGIN}} icons/${iconDigest.slice(7)}`,
          ),
          production,
        ),
      ).toThrow("replica_snapshot_non_public_catalog_mutation");
    }
    for (const pii of [
      "person@example.com",
      "192.0.2.44",
      "2001:db8:85a3::8a2e:370:7334",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature12345678",
      "cookie='private-session-value'",
    ]) {
      expect(() =>
        scanSanitizedSnapshot(
          bundle(
            `INSERT INTO listings(id, icon_url, description_en) VALUES ('tako/takos', '{{TAKOSUMI_STORE_REPLICA_ORIGIN}}/icons/${iconDigest.slice(7)}', '${pii}');`,
          ),
          production,
        ),
      ).toThrow("replica_snapshot_pii_literal_detected");
    }
  });
});

describe("deploy entrypoint custody", () => {
  test("keeps raw Wrangler deployment out of the supported Store paths", async () => {
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const deployDocs = await readFile(
      join(import.meta.dir, "..", "docs", "deploy.md"),
      "utf8",
    );

    expect(packageJson.scripts?.deploy).toBeUndefined();
    expect(packageJson.scripts?.["deploy:self-host"]).toBe(
      "bun scripts/self-host-deploy.ts",
    );
    expect(deployDocs).not.toContain("bunx wrangler deploy");
    expect(deployDocs).not.toContain("An official deployment can use");
    expect(deployDocs).toContain("bun run deploy:self-host");
  });
});
