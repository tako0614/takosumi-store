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
  ARTIFACT_DIRECTORY,
  ARTIFACT_MANIFEST_FILE,
  CANDIDATE_FILE,
  REPOSITORY,
  SURFACE_ID,
  TAG,
  VERSION,
  artifactSetDigest,
  digestFile,
  digestJson,
  sha256Bytes,
  verifyActualToolchain,
  verifyArtifact,
  writePrivateJson,
  type ReleaseEnvelope,
  type StoreArtifactManifest,
} from "../scripts/store-release-common.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  evidence: string;
  artifact: string;
  manifestPath: string;
  manifest: StoreArtifactManifest;
  envelope: ReleaseEnvelope;
}> {
  const evidence = await mkdtemp(join(tmpdir(), "store-artifact-integrity-"));
  temporaryRoots.push(evidence);
  await chmod(evidence, 0o700);
  const artifact = join(evidence, ARTIFACT_DIRECTORY);
  await Promise.all([
    mkdir(join(artifact, "worker"), { recursive: true, mode: 0o700 }),
    mkdir(join(artifact, "assets"), { recursive: true, mode: 0o700 }),
    mkdir(join(artifact, "migrations"), { recursive: true, mode: 0o700 }),
  ]);
  const files = new Map<string, Buffer>([
    ["worker/worker.mjs", Buffer.from("export default { fetch() {} };\n")],
    ["assets/index.html", Buffer.from("<main>sealed</main>\n")],
    ["assets/index-review.js", Buffer.from("console.log('sealed');\n")],
    ["sbom.cdx.json", Buffer.from('{"bomFormat":"CycloneDX"}\n')],
    ["provenance.intoto.jsonl", Buffer.from('{"_type":"statement"}\n')],
  ]);
  for (const name of [
    "0001_init.sql",
    "0002_accounts.sql",
    "0003_scope_slug.sql",
    "0004_tags.sql",
    "0005_install_experience.sql",
    "0006_source_identity.sql",
  ]) {
    files.set(`migrations/${name}`, Buffer.from(`-- ${name}\n`));
  }
  for (const [path, bytes] of files) {
    await writeFile(join(artifact, path), bytes, { mode: 0o600, flag: "wx" });
  }
  const record = (path: string) => digestFile(join(artifact, path), path);
  const worker = await record("worker/worker.mjs");
  const assets = await Promise.all(
    ["assets/index-review.js", "assets/index.html"].map(record),
  );
  assets.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const migrations = await Promise.all(
    [...files.keys()]
      .filter((path) => path.startsWith("migrations/"))
      .map(record),
  );
  migrations.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const sbom = await record("sbom.cdx.json");
  const provenance = await record("provenance.intoto.jsonl");
  const sourceRoot = join(import.meta.dir, "..");
  const wranglerEntrypoint = join(
    sourceRoot,
    "node_modules/wrangler/wrangler-dist/cli.js",
  );
  const wranglerPackageJson = join(
    sourceRoot,
    "node_modules/wrangler/package.json",
  );
  const wranglerPackage = JSON.parse(
    await readFile(wranglerPackageJson, "utf8"),
  ) as { version: string };
  const toolchain = {
    bun: Bun.version,
    bunExecutableDigest: sha256Bytes(await readFile(process.execPath)),
    wrangler: wranglerPackage.version,
    wranglerEntrypointDigest: sha256Bytes(await readFile(wranglerEntrypoint)),
    wranglerPackageJsonDigest: sha256Bytes(await readFile(wranglerPackageJson)),
    lockfileDigest: sha256Bytes(await readFile(join(sourceRoot, "bun.lock"))),
  };
  const components = { worker, assets, migrations, sbom, provenance };
  const manifest: StoreArtifactManifest = {
    kind: "takosumi.store-release-artifact@v1",
    surfaceId: SURFACE_ID,
    repository: REPOSITORY,
    sourceCommit: "d".repeat(40),
    version: VERSION,
    tag: TAG,
    builtAt: "2026-07-22T00:00:00.000Z",
    ...components,
    digests: {
      worker: worker.sha256,
      assets: artifactSetDigest(assets),
      migrations: artifactSetDigest(migrations),
      sbom: sbom.sha256,
      provenance: provenance.sha256,
      artifact: digestJson(components),
    },
    toolchain,
  };
  const manifestPath = join(artifact, ARTIFACT_MANIFEST_FILE);
  await writePrivateJson(manifestPath, manifest);
  const candidate = {
    kind: "takos.direct-deployment-release-candidate@v1",
    surfaceId: SURFACE_ID,
    repository: REPOSITORY,
    sourceCommit: manifest.sourceCommit,
    version: VERSION,
    artifactDigests: [
      manifest.digests.worker,
      manifest.digests.assets,
      manifest.digests.migrations,
    ],
    sbomDigests: [manifest.digests.sbom],
    provenanceDigests: [manifest.digests.provenance],
    toolchainDigest: digestJson(toolchain),
  };
  const candidateBytes = await writePrivateJson(
    join(evidence, CANDIDATE_FILE),
    candidate,
  );
  const envelope = {
    source: { commit: manifest.sourceCommit },
    candidate: {
      ...candidate,
      manifestDigest: sha256Bytes(candidateBytes),
    },
  } as unknown as ReleaseEnvelope;
  return { evidence, artifact, manifestPath, manifest, envelope };
}

describe("sealed Store artifacts", () => {
  test("recomputes every file, set, and aggregate digest", async () => {
    const value = await fixture();
    await expect(
      verifyArtifact(value.evidence, value.envelope),
    ).resolves.toMatchObject({
      manifest: value.manifest,
    });
  });

  test("rejects byte tampering, extra inventory, digest lies, and schema extensions", async () => {
    {
      const value = await fixture();
      await writeFile(join(value.artifact, "worker/worker.mjs"), "tampered\n");
      await expect(
        verifyArtifact(value.evidence, value.envelope),
      ).rejects.toThrow("artifact_file_digest_mismatch");
    }
    {
      const value = await fixture();
      await writeFile(join(value.artifact, "unsealed.txt"), "extra\n", {
        mode: 0o600,
      });
      await expect(
        verifyArtifact(value.evidence, value.envelope),
      ).rejects.toThrow("artifact_filesystem_inventory_mismatch");
    }
    {
      const value = await fixture();
      const changed = {
        ...value.manifest,
        digests: {
          ...value.manifest.digests,
          artifact: `sha256:${"0".repeat(64)}`,
        },
      };
      await writePrivateJson(value.manifestPath, changed, { replace: true });
      await expect(
        verifyArtifact(value.evidence, value.envelope),
      ).rejects.toThrow("artifact_component_digest_mismatch");
    }
    {
      const value = await fixture();
      await writePrivateJson(
        value.manifestPath,
        { ...value.manifest, unsignedExtension: true },
        { replace: true },
      );
      await expect(
        verifyArtifact(value.evidence, value.envelope),
      ).rejects.toThrow("artifact_manifest_keys_invalid");
    }
  });

  test("verifies the executable, lock, Wrangler bundle, metadata, and versions", async () => {
    const value = await fixture();
    const sourceRoot = join(import.meta.dir, "..");
    await expect(
      verifyActualToolchain(sourceRoot, value.manifest),
    ).resolves.toMatchObject({
      wranglerEntrypoint: expect.stringContaining("wrangler-dist/cli.js"),
    });
    await expect(
      verifyActualToolchain(sourceRoot, {
        ...value.manifest,
        toolchain: {
          ...value.manifest.toolchain,
          wranglerEntrypointDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).rejects.toThrow("release_wrangler_toolchain_mismatch");
  });
});
