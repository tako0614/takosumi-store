import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  digestJson,
  sha256Bytes,
  writePrivateJson,
  type ReleaseEnvelope,
  type StoreArtifactManifest,
  type TargetPolicy,
} from "../scripts/store-release-common.ts";
import { deploySealedStore } from "../scripts/store-release-fixed-adapter.ts";

const roots: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const versionId = "10000000-0000-4000-8000-000000000001";
const migrationNames = [
  "0001_init.sql",
  "0002_accounts.sql",
  "0003_scope_slug.sql",
  "0004_tags.sql",
  "0005_install_experience.sql",
  "0006_source_identity.sql",
];
const iconBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const iconDigest = sha256Bytes(iconBytes).slice(7);
const staticBytes = Buffer.from("sealed-static");
const indexBytes = Buffer.from("<main>sealed</main>");

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

function versionReadback(value: TargetPolicy): unknown {
  return {
    id: versionId,
    resources: {
      bindings: [
        { name: "DB", type: "d1", id: value.databaseId },
        { name: "KV", type: "kv_namespace", namespace_id: value.kvNamespaceId },
        {
          name: "ICONS",
          type: "r2_bucket",
          bucket_name: value.iconsBucketName,
        },
        { name: "ASSETS", type: "assets" },
        ...value.requiredVarNames.map((name) => ({ name, type: "plain_text" })),
        ...value.requiredSecretNames.map((name) => ({
          name,
          type: "secret_text",
        })),
      ],
    },
  };
}

function installLiveFetchMock(): void {
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
          iconUrl: `https://store.takosumi.com/icons/${iconDigest}`,
        },
        { headers },
      );
    }
    if (url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        software: "takosumi-store",
        version: "0.1.10",
      });
    }
    if (url.pathname === "/readyz") {
      return Response.json({
        status: "ready",
        capabilities: { publish: true },
      });
    }
    if (url.pathname === "/.well-known/tcs") {
      return Response.json({
        server: {
          software: { name: "takosumi-store", version: "0.1.10" },
          baseUrl: "https://store.takosumi.com",
        },
      });
    }
    if (url.pathname === `/icons/${iconDigest}`) {
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
}

describe("release operation journal retry", () => {
  test("resumes monotonically from every retained phase", async () => {
    installLiveFetchMock();
    for (const phase of [
      "intent-recorded",
      "schema-applied",
      "version-uploaded",
      "deployed",
      "verified",
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `store-journal-${phase}-`));
      roots.push(root);
      await chmod(root, 0o700);
      const journalPath = join(root, "output/operation.json");
      const releaseTarget = target();
      const baselineDeployment = { versions: [] };
      const currentDeployment = {
        id: "20000000-0000-4000-8000-000000000001",
        versions: [{ version_id: versionId, percentage: 100 }],
      };
      let deployed = phase === "deployed" || phase === "verified";
      const calls: string[][] = [];
      const runner = (args: readonly string[]): string => {
        calls.push([...args]);
        if (args[0] === "deployments") {
          return JSON.stringify(
            deployed ? currentDeployment : baselineDeployment,
          );
        }
        if (
          args[0] === "d1" &&
          args[1] === "migrations" &&
          args[2] === "list"
        ) {
          return "No migrations to apply.";
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return JSON.stringify([
            { results: migrationNames.map((name) => ({ name })) },
          ]);
        }
        if (args[0] === "versions" && args[1] === "upload") {
          return `Version ID: ${versionId}`;
        }
        if (args[0] === "versions" && args[1] === "view") {
          return JSON.stringify(versionReadback(releaseTarget));
        }
        if (args[0] === "versions" && args[1] === "deploy") {
          deployed = true;
          return "";
        }
        return "";
      };
      const artifactDigests = ["sha256:a", "sha256:b", "sha256:c"];
      const envelope = {
        releaseId: "takosumi-store-0.1.10-retry",
        source: { commit: "d".repeat(40) },
        candidate: { artifactDigests },
      } as unknown as ReleaseEnvelope;
      const authority = {
        kind: "takosumi.store-release-operation@v1",
        environment: "production",
        surfaceId: "takosumi-store",
        releaseId: envelope.releaseId,
        sourceCommit: envelope.source.commit,
        artifactDigests,
        targetFingerprint: `sha256:${"e".repeat(64)}`,
        target: {
          accountId: releaseTarget.accountId,
          workerName: releaseTarget.workerName,
          databaseId: releaseTarget.databaseId,
          kvNamespaceId: releaseTarget.kvNamespaceId,
          iconsBucketName: releaseTarget.iconsBucketName,
          origin: releaseTarget.origin,
        },
        preDeploymentDigest: digestJson(baselineDeployment),
      };
      await writePrivateJson(journalPath, {
        ...authority,
        phase,
        versionId:
          phase === "intent-recorded" || phase === "schema-applied"
            ? null
            : versionId,
        updatedAt: "2026-07-22T00:00:00.000Z",
      });
      const manifest = {
        migrations: migrationNames.map((name) => ({
          path: `migrations/${name}`,
        })),
        assets: [
          {
            path: "assets/assets/index-review.js",
            sha256: sha256Bytes(staticBytes),
          },
          { path: "assets/index.html", sha256: sha256Bytes(indexBytes) },
        ],
      } as unknown as StoreArtifactManifest;
      await expect(
        deploySealedStore({
          runner,
          cwd: root,
          target: releaseTarget,
          envelope,
          manifest,
          candidateChecks: [],
          readTopology: async () => ({
            mode: "custom-domain",
            hostname: "store.takosumi.com",
            workerName: "takosumi-store",
          }),
          journal: {
            path: journalPath,
            environment: "production",
            targetFingerprint: authority.targetFingerprint,
          },
        }),
      ).resolves.toMatchObject({ versionId });
      const retained = JSON.parse(await readFile(journalPath, "utf8"));
      expect(retained.phase).toBe("verified");
      expect(retained.versionId).toBe(versionId);
      expect(
        calls.filter((args) => args[0] === "versions" && args[1] === "upload"),
      ).toHaveLength(
        phase === "intent-recorded" || phase === "schema-applied" ? 1 : 0,
      );
      expect(
        calls.filter((args) => args[0] === "versions" && args[1] === "deploy"),
      ).toHaveLength(phase === "deployed" || phase === "verified" ? 0 : 1);
    }
  });
});
