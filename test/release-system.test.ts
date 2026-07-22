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
import {
  deploySealedStore,
  ensureStagingCanary,
} from "../scripts/store-release-fixed-adapter.ts";
import {
  assertReleaseSecretFileLocation,
  decryptSnapshot,
  encryptSnapshot,
  prepareReplicaInput,
  scanSanitizedSnapshot,
} from "../scripts/store-release-replica-adapter.ts";

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
  test("seeds the staging canary from a sealed content-addressed asset without overwriting conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "store-staging-canary-test-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "artifact/assets"), {
      recursive: true,
      mode: 0o700,
    });
    const icon = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    await writeFile(join(root, "artifact/assets/tako.png"), icon);
    const digest = sha256Bytes(icon);
    const staging = policy().staging;
    const iconUrl = `${staging.origin}/icons/${digest.slice(7)}`;
    const canaryRow = {
      id: "tako/takos",
      scope: "tako",
      slug: "takos",
      git: "https://github.com/tako0614/takos.git",
      ref: "",
      path: "deploy/opentofu",
      kind: "worker",
      surface: "service",
      provider: "cloudflare",
      category: "workspace",
      tags: '["workspace","ai"]',
      suggested_name: "takos",
      name_ja: "Takos",
      name_en: "Takos",
      description_ja: "AI workspace",
      description_en: "AI workspace",
      badge_ja: "Installable",
      badge_en: "Installable",
      icon_url: iconUrl,
      inputs: "[]",
      output_allowlist: "[]",
      publisher_handle: "tako",
      publisher_display_name: "Takos",
      status: "visible",
      created_at: "2026-07-22T00:00:00.000Z",
      updated_at: "2026-07-22T00:00:00.000Z",
    };
    const calls: string[][] = [];
    const runner = (args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "d1") {
        return JSON.stringify([
          {
            results: [canaryRow],
          },
        ]);
      }
      return "";
    };
    const result = await ensureStagingCanary({
      runner,
      cwd: root,
      target: staging,
      manifest: {
        assets: [
          {
            path: "assets/tako.png",
            sha256: digest,
            size: icon.byteLength,
          },
        ],
      } as unknown as StoreArtifactManifest,
    });
    expect(result).toEqual({
      id: "tako/takos",
      sourceGit: "https://github.com/tako0614/takos.git",
      sourcePath: "deploy/opentofu",
      iconDigest: digest,
    });
    expect(calls[0]).toContain(
      `${staging.iconsBucketName}/icons/${digest.slice(7)}`,
    );
    expect(calls[1]?.join(" ")).toContain("INSERT OR IGNORE INTO listings");
    expect(calls[1]?.join(" ")).not.toContain("ON CONFLICT");

    const conflictRunner = (args: readonly string[]): string =>
      args[0] === "d1"
        ? JSON.stringify([
            {
              results: [
                {
                  ...canaryRow,
                  status: "hidden",
                },
              ],
            },
          ])
        : "";
    await expect(
      ensureStagingCanary({
        runner: conflictRunner,
        cwd: root,
        target: staging,
        manifest: {
          assets: [
            {
              path: "assets/tako.png",
              sha256: digest,
              size: icon.byteLength,
            },
          ],
        } as unknown as StoreArtifactManifest,
      }),
    ).rejects.toThrow("staging_canary_readback_mismatch");
  });

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
      releaseId: "takosumi-store-0.1.11-attempt-1",
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

describe("encrypted production replica snapshot", () => {
  test("authenticates ciphertext, AAD, and key without retaining plaintext", () => {
    const plaintext = Buffer.from(
      'production-derived-public-catalog-marker:{"id":"tako/takos"}',
    );
    const key = Buffer.alloc(32, 0x11);
    const authority = {
      configFingerprint: `sha256:${"1".repeat(64)}`,
      migrationPlanDigest: `sha256:${"2".repeat(64)}`,
      productionTargetFingerprint: `sha256:${"3".repeat(64)}`,
    };
    const envelope = {
      releaseId: "store-encrypted-snapshot-test",
      source: { commit: "a".repeat(40) },
      controllerSource: { commit: "b".repeat(40) },
      authority: { replicaAdapterDigest: `sha256:${"4".repeat(64)}` },
      candidate: {
        artifactDigests: [`sha256:${"5".repeat(64)}`],
        policyDigest: `sha256:${"6".repeat(64)}`,
      },
    } as unknown as ReleaseEnvelope;
    const encrypted = encryptSnapshot(plaintext, key, envelope, authority);
    const independentlyEncrypted = encryptSnapshot(
      plaintext,
      key,
      envelope,
      authority,
    );
    expect(independentlyEncrypted.nonceBase64).not.toBe(encrypted.nonceBase64);
    const retainedBytes = Buffer.from(`${canonicalJson(encrypted)}\n`);
    expect(retainedBytes.includes(plaintext)).toBe(false);
    expect(
      Buffer.from(decryptSnapshot(encrypted, key, envelope, authority)).equals(
        plaintext,
      ),
    ).toBe(true);
    expect(() =>
      decryptSnapshot(encrypted, Buffer.alloc(32, 0x22), envelope, authority),
    ).toThrow("replica_encrypted_snapshot_authentication_failed");
    expect(() =>
      decryptSnapshot(
        encrypted,
        key,
        {
          ...envelope,
          source: { commit: "c".repeat(40) },
        } as ReleaseEnvelope,
        authority,
      ),
    ).toThrow("replica_encrypted_snapshot_aad_mismatch");
    const ciphertext = Buffer.from(
      String(encrypted.ciphertextBase64),
      "base64",
    );
    ciphertext[0] = ciphertext[0]! ^ 0x01;
    expect(() =>
      decryptSnapshot(
        { ...encrypted, ciphertextBase64: ciphertext.toString("base64") },
        key,
        envelope,
        authority,
      ),
    ).toThrow("replica_encrypted_snapshot_authentication_failed");
  });

  test("prepares a retry-stable ciphertext bundle from one read-only public production row", async () => {
    const base = await mkdtemp(join(tmpdir(), "store-replica-input-test-"));
    temporaryRoots.push(base);
    await chmod(base, 0o700);
    const root = join(base, "evidence");
    const secretRoot = join(base, "operator-secrets");
    await mkdir(root, { mode: 0o700 });
    await mkdir(secretRoot, { mode: 0o700 });
    const keyPath = join(secretRoot, "snapshot.key");
    const subdomainPath = join(secretRoot, "workers-subdomain");
    await writeFile(keyPath, Buffer.alloc(32, 0x31), { mode: 0o600 });
    await writeFile(subdomainPath, "example\n", { mode: 0o600 });
    const previousKey = process.env.TAKOSUMI_RELEASE_REPLICA_SNAPSHOT_KEY_FILE;
    const previousSubdomain =
      process.env.TAKOSUMI_RELEASE_REPLICA_WORKERS_SUBDOMAIN_FILE;
    process.env.TAKOSUMI_RELEASE_REPLICA_SNAPSHOT_KEY_FILE = keyPath;
    process.env.TAKOSUMI_RELEASE_REPLICA_WORKERS_SUBDOMAIN_FILE = subdomainPath;
    const previousFetch = globalThis.fetch;
    const iconBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    globalThis.fetch = (async () =>
      new Response(iconBytes, {
        headers: {
          "content-type": "image/png",
          "content-length": String(iconBytes.byteLength),
        },
      })) as unknown as typeof fetch;
    const listing = {
      id: "tako/takos",
      scope: "tako",
      slug: "takos",
      git: "https://github.com/tako0614/takos.git",
      ref: "HEAD",
      path: "deploy/opentofu",
      kind: "capsule",
      surface: "workspace",
      provider: null,
      category: "productivity",
      tags: "[]",
      suggested_name: "takos",
      name_ja: "Takos",
      name_en: "Takos",
      description_ja: "AI workspace",
      description_en: "AI workspace",
      badge_ja: null,
      badge_en: null,
      icon_url:
        "https://raw.githubusercontent.com/tako0614/takos/HEAD/web/public/logo.png",
      inputs: "{}",
      output_allowlist: "[]",
      publisher_handle: "tako0614",
      publisher_display_name: "Takos",
      status: "visible",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    const calls: string[][] = [];
    const runner = (args: readonly string[]): string => {
      calls.push([...args]);
      return JSON.stringify([{ results: [listing] }]);
    };
    const envelope = {
      releaseId: "takosumi-store-0.1.11-input-test",
      source: { commit: "a".repeat(40) },
      controllerSource: { commit: "b".repeat(40) },
      authority: { replicaAdapterDigest: `sha256:${"c".repeat(64)}` },
      candidate: {
        artifactDigests: [`sha256:${"d".repeat(64)}`],
        policyDigest: `sha256:${"e".repeat(64)}`,
      },
    } as unknown as ReleaseEnvelope;
    const manifest = {
      digests: { migrations: `sha256:${"f".repeat(64)}` },
    } as unknown as StoreArtifactManifest;
    try {
      const first = await prepareReplicaInput({
        envelope,
        policy: target(),
        manifest,
        evidenceDirectory: root,
        runner,
        productionConfigPath: "/operator/store/wrangler.production.toml",
      });
      const retained = await readFile(
        join(root, "worker-release-replica-sanitized-snapshot.json"),
      );
      const second = await prepareReplicaInput({
        envelope,
        policy: target(),
        manifest,
        evidenceDirectory: root,
        runner,
        productionConfigPath: "/operator/store/wrangler.production.toml",
      });
      expect(canonicalJson(second.evidence)).toBe(
        canonicalJson(first.evidence),
      );
      expect(
        Buffer.from(
          await readFile(
            join(root, "worker-release-replica-sanitized-snapshot.json"),
          ),
        ).equals(retained),
      ).toBe(true);
      expect(retained.includes(Buffer.from("tako/takos"))).toBe(false);
      expect(calls).toHaveLength(2);
      for (const args of calls) {
        expect(args.slice(0, 3)).toEqual([
          "d1",
          "execute",
          "takosumi-store-db",
        ]);
        const query = args[args.indexOf("--command") + 1]!;
        expect(query).toStartWith("SELECT ");
        expect(query).toContain("WHERE id = 'tako/takos'");
        expect(query).not.toMatch(
          /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/iu,
        );
      }
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) {
        delete process.env.TAKOSUMI_RELEASE_REPLICA_SNAPSHOT_KEY_FILE;
      } else {
        process.env.TAKOSUMI_RELEASE_REPLICA_SNAPSHOT_KEY_FILE = previousKey;
      }
      if (previousSubdomain === undefined) {
        delete process.env.TAKOSUMI_RELEASE_REPLICA_WORKERS_SUBDOMAIN_FILE;
      } else {
        process.env.TAKOSUMI_RELEASE_REPLICA_WORKERS_SUBDOMAIN_FILE =
          previousSubdomain;
      }
    }
  });

  test("rejects release keys retained with evidence or inside a Git worktree", async () => {
    const base = await mkdtemp(join(tmpdir(), "store-secret-location-test-"));
    temporaryRoots.push(base);
    await chmod(base, 0o700);
    const evidence = join(base, "evidence");
    const external = join(base, "operator-secrets");
    await mkdir(evidence, { mode: 0o700 });
    await mkdir(external, { mode: 0o700 });
    const evidenceKey = join(evidence, "snapshot.key");
    const externalKey = join(external, "snapshot.key");
    const repoKey = join(import.meta.dir, `.replica-key-test-${process.pid}`);
    await writeFile(evidenceKey, Buffer.alloc(32), { mode: 0o600 });
    await writeFile(externalKey, Buffer.alloc(32), { mode: 0o600 });
    await writeFile(repoKey, Buffer.alloc(32), { mode: 0o600 });
    try {
      await expect(
        assertReleaseSecretFileLocation(
          evidenceKey,
          evidence,
          "replica_snapshot_encryption_key",
        ),
      ).rejects.toThrow(
        "replica_snapshot_encryption_key_inside_evidence_forbidden",
      );
      await expect(
        assertReleaseSecretFileLocation(
          repoKey,
          evidence,
          "replica_snapshot_encryption_key",
        ),
      ).rejects.toThrow(
        "replica_snapshot_encryption_key_inside_git_worktree_forbidden",
      );
      expect(
        await assertReleaseSecretFileLocation(
          externalKey,
          evidence,
          "replica_snapshot_encryption_key",
        ),
      ).toBe(externalKey);
    } finally {
      await rm(repoKey, { force: true });
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
