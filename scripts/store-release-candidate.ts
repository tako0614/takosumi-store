import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  ARTIFACT_DIRECTORY,
  ARTIFACT_MANIFEST_FILE,
  CANDIDATE_FILE,
  PRODUCTION_HEALTH_NAMES,
  REPOSITORY,
  STAGING_HEALTH_NAMES,
  SURFACE_ID,
  TAG,
  VERSION,
  artifactSetDigest,
  candidateHealthChecks,
  canonicalJson,
  digestFile,
  digestJson,
  ensurePrivateEvidenceDirectory,
  readPolicy,
  safeRelativePath,
  secureResolveInside,
  sha256Bytes,
  targetFingerprint,
  validateRealizedConfig,
  walkFiles,
  writePrivateJson,
  type StoreArtifactManifest,
  type StoreReleaseCandidate,
} from "./store-release-common.ts";

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: { maxBuffer?: number } = {},
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    env: {
      HOME: process.env.HOME ?? "/nonexistent",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "0",
      WRANGLER_SEND_METRICS: "false",
    },
  });
  if (result.status !== 0)
    throw new Error(`release_build_failed:${basename(command)}`);
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
  return run("/usr/bin/git", ["-C", cwd, ...args], cwd);
}

async function assertReleaseSource(root: string): Promise<{
  commit: string;
  builtAt: string;
  treeDigest: string;
}> {
  if (
    git(root, "remote", "get-url", "origin") !== REPOSITORY ||
    git(root, "status", "--porcelain=v1", "--untracked-files=all") !== "" ||
    git(root, "symbolic-ref", "--quiet", "--short", "HEAD") !== "main"
  ) {
    throw new Error("release_source_must_be_clean_canonical_main");
  }
  const commit = git(root, "rev-parse", "HEAD");
  if (git(root, "cat-file", "-t", `refs/tags/${TAG}`) !== "tag") {
    throw new Error("release_tag_must_be_annotated");
  }
  if (git(root, "rev-parse", `refs/tags/${TAG}^{}`) !== commit) {
    throw new Error("release_tag_commit_mismatch");
  }
  const verifyTag = spawnSync("/usr/bin/git", ["-C", root, "verify-tag", TAG], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (verifyTag.status !== 0) throw new Error("release_tag_signature_invalid");
  const remoteMain = git(
    root,
    "ls-remote",
    "--exit-code",
    "origin",
    "refs/heads/main",
  );
  if (!remoteMain.startsWith(`${commit}\t`))
    throw new Error("release_commit_not_pushed_to_main");
  const remoteTag = git(
    root,
    "ls-remote",
    "--exit-code",
    "--tags",
    "origin",
    `refs/tags/${TAG}`,
    `refs/tags/${TAG}^{}`,
  );
  if (!remoteTag.includes(`${commit}\trefs/tags/${TAG}^{}`)) {
    throw new Error("release_tag_not_pushed");
  }
  const sourcePackage = JSON.parse(
    await Bun.file(join(root, "package.json")).text(),
  ) as {
    version?: string;
  };
  if (sourcePackage.version !== VERSION)
    throw new Error("package_version_mismatch");
  const builtAt = new Date(
    Number(git(root, "show", "-s", "--format=%ct", commit)) * 1000,
  ).toISOString();
  const treeBytes = execFileSync("/usr/bin/git", [
    "-C",
    root,
    "ls-tree",
    "-r",
    "--full-tree",
    "HEAD",
  ]);
  return { commit, builtAt, treeDigest: sha256Bytes(treeBytes) };
}

async function buildOnce(
  root: string,
  destination: string,
): Promise<{ workerPath: string; assetsPath: string }> {
  run(process.execPath, ["run", "build"], root);
  const wrangler = resolve(root, "node_modules/wrangler/wrangler-dist/cli.js");
  const bundle = join(destination, "bundle");
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  run(
    process.execPath,
    [
      wrangler,
      "versions",
      "upload",
      "--dry-run",
      "--outdir",
      bundle,
      "--config",
      join(root, "wrangler.toml"),
    ],
    root,
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const workerPath = join(bundle, "index.js");
  const worker = await stat(workerPath);
  if (!worker.isFile() || worker.size === 0)
    throw new Error("worker_bundle_missing");
  const assetsPath = join(destination, "assets");
  await cp(join(root, "dist"), assetsPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return { workerPath, assetsPath };
}

async function assertReproducibleBuild(
  root: string,
  first: { workerPath: string; assetsPath: string },
  second: { workerPath: string; assetsPath: string },
): Promise<void> {
  const firstWorker = await readFile(first.workerPath);
  const secondWorker = await readFile(second.workerPath);
  const firstAssets = await walkFiles(first.assetsPath);
  const secondAssets = await walkFiles(second.assetsPath);
  if (
    !firstWorker.equals(secondWorker) ||
    canonicalJson(firstAssets) !== canonicalJson(secondAssets) ||
    git(root, "status", "--porcelain=v1", "--untracked-files=all") !== ""
  ) {
    throw new Error("release_build_is_not_reproducible");
  }
}

async function makeArtifact(options: {
  root: string;
  destination: string;
  build: { workerPath: string; assetsPath: string };
  source: { commit: string; builtAt: string; treeDigest: string };
  bunVersion: string;
  bunExecutableDigest: string;
  wranglerVersion: string;
  wranglerEntrypointDigest: string;
  wranglerPackageJsonDigest: string;
}): Promise<StoreArtifactManifest> {
  await mkdir(join(options.destination, "worker"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(options.destination, "migrations"), {
    recursive: true,
    mode: 0o700,
  });
  const workerTarget = join(options.destination, "worker/worker.mjs");
  await cp(options.build.workerPath, workerTarget, {
    errorOnExist: true,
    force: false,
  });
  await cp(options.build.assetsPath, join(options.destination, "assets"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await cp(
    join(options.root, "migrations"),
    join(options.destination, "migrations"),
    {
      recursive: true,
      errorOnExist: false,
      force: false,
    },
  );
  const worker = await digestFile(workerTarget, "worker/worker.mjs");
  const assets = await walkFiles(
    join(options.destination, "assets"),
    "assets/",
  );
  const migrations = await walkFiles(
    join(options.destination, "migrations"),
    "migrations/",
  );
  const expectedMigrations = [
    "0001_init.sql",
    "0002_accounts.sql",
    "0003_scope_slug.sql",
    "0004_tags.sql",
    "0005_install_experience.sql",
    "0006_source_identity.sql",
  ];
  if (
    JSON.stringify(migrations.map((entry) => basename(entry.path))) !==
    JSON.stringify(expectedMigrations)
  ) {
    throw new Error("release_migration_set_invalid");
  }
  const lockfileDigest = sha256Bytes(
    await readFile(join(options.root, "bun.lock")),
  );
  const sbomValue = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${options.source.commit.slice(0, 8)}-${options.source.commit.slice(8, 12)}-4${options.source.commit.slice(13, 16)}-8${options.source.commit.slice(17, 20)}-${options.source.commit.slice(20, 32)}`,
    version: 1,
    metadata: {
      timestamp: options.source.builtAt,
      component: {
        type: "application",
        name: "takosumi-store",
        version: VERSION,
      },
    },
    components: [
      {
        type: "file",
        name: "worker/worker.mjs",
        hashes: [{ alg: "SHA-256", content: worker.sha256.slice(7) }],
      },
      ...assets.map((file) => ({
        type: "file",
        name: file.path,
        hashes: [{ alg: "SHA-256", content: file.sha256.slice(7) }],
      })),
      ...migrations.map((file) => ({
        type: "file",
        name: file.path,
        hashes: [{ alg: "SHA-256", content: file.sha256.slice(7) }],
      })),
    ],
  };
  const sbomPath = join(options.destination, "sbom.cdx.json");
  await writeFile(sbomPath, `${canonicalJson(sbomValue)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const sbom = await digestFile(sbomPath, "sbom.cdx.json");
  const provenanceValue = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: worker.path, digest: { sha256: worker.sha256.slice(7) } },
      {
        name: "assets",
        digest: { sha256: artifactSetDigest(assets).slice(7) },
      },
      {
        name: "migrations",
        digest: { sha256: artifactSetDigest(migrations).slice(7) },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://takosumi.com/release/takosumi-store-worker@v1",
        externalParameters: {
          repository: REPOSITORY,
          commit: options.source.commit,
          tag: TAG,
        },
        internalParameters: {
          bun: options.bunVersion,
          wrangler: options.wranglerVersion,
        },
        resolvedDependencies: [
          {
            uri: `${REPOSITORY}@${options.source.commit}`,
            digest: { sha256: options.source.treeDigest.slice(7) },
          },
          { uri: "bun.lock", digest: { sha256: lockfileDigest.slice(7) } },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/tako0614/takosumi-store" },
        metadata: {
          invocationId: `${SURFACE_ID}-${VERSION}-${options.source.commit.slice(0, 12)}`,
        },
      },
    },
  };
  const provenancePath = join(options.destination, "provenance.intoto.jsonl");
  await writeFile(provenancePath, `${canonicalJson(provenanceValue)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const provenance = await digestFile(
    provenancePath,
    "provenance.intoto.jsonl",
  );
  const digests = {
    worker: worker.sha256,
    assets: artifactSetDigest(assets),
    migrations: artifactSetDigest(migrations),
    sbom: sbom.sha256,
    provenance: provenance.sha256,
    artifact: digestJson({ worker, assets, migrations, sbom, provenance }),
  };
  return {
    kind: "takosumi.store-release-artifact@v1",
    surfaceId: SURFACE_ID,
    repository: REPOSITORY,
    sourceCommit: options.source.commit,
    version: VERSION,
    tag: TAG,
    builtAt: options.source.builtAt,
    worker,
    assets,
    migrations,
    sbom,
    provenance,
    digests,
    toolchain: {
      bun: options.bunVersion,
      bunExecutableDigest: options.bunExecutableDigest,
      wrangler: options.wranglerVersion,
      wranglerEntrypointDigest: options.wranglerEntrypointDigest,
      wranglerPackageJsonDigest: options.wranglerPackageJsonDigest,
      lockfileDigest,
    },
  };
}

async function hardenArtifactTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await chmod(path, 0o700);
      await hardenArtifactTree(path);
    } else if (entry.isFile()) {
      await chmod(path, 0o600);
    } else {
      throw new Error("artifact_special_file_forbidden");
    }
  }
}

export async function buildStoreReleaseCandidate(options: {
  readonly sourceRoot: string;
  readonly operatorRoot: string;
  readonly evidenceDirectory: string;
}): Promise<{
  readonly candidatePath: string;
  readonly artifactManifestPath: string;
  readonly candidate: StoreReleaseCandidate;
}> {
  const root = await realpath(options.sourceRoot);
  const evidenceDirectory = await ensurePrivateEvidenceDirectory(
    options.evidenceDirectory,
  );
  const source = await assertReleaseSource(root);
  const policy = await readPolicy(options.operatorRoot);
  const productionConfigPath = await secureResolveInside(
    options.operatorRoot,
    safeRelativePath(
      policy.policy.production.configPath,
      "production_config_path",
    ),
  );
  const stagingConfigPath = await secureResolveInside(
    options.operatorRoot,
    safeRelativePath(policy.policy.staging.configPath, "staging_config_path"),
  );
  const productionConfig = await readFile(productionConfigPath);
  const stagingConfig = await readFile(stagingConfigPath);
  validateRealizedConfig(productionConfig, policy.policy.production);
  validateRealizedConfig(stagingConfig, policy.policy.staging);
  const productionConfigDigest = sha256Bytes(productionConfig);
  const stagingConfigDigest = sha256Bytes(stagingConfig);
  const temporary = await mkdtemp(
    join(tmpdir(), "takosumi-store-release-build-"),
  );
  await chmod(temporary, 0o700);
  try {
    const firstRoot = join(temporary, "first");
    const secondRoot = join(temporary, "second");
    await Promise.all([
      mkdir(firstRoot, { mode: 0o700 }),
      mkdir(secondRoot, { mode: 0o700 }),
    ]);
    const first = await buildOnce(root, firstRoot);
    const second = await buildOnce(root, secondRoot);
    await assertReproducibleBuild(root, first, second);
    const bunVersion = run(process.execPath, ["--version"], root);
    const bunExecutableDigest = sha256Bytes(await readFile(process.execPath));
    const wranglerEntrypoint = resolve(
      root,
      "node_modules/wrangler/wrangler-dist/cli.js",
    );
    const wranglerVersion = run(
      process.execPath,
      [wranglerEntrypoint, "--version"],
      root,
    );
    const wranglerEntrypointDigest = sha256Bytes(
      await readFile(wranglerEntrypoint),
    );
    const wranglerPackageJsonDigest = sha256Bytes(
      await readFile(join(root, "node_modules/wrangler/package.json")),
    );
    const artifactRoot = join(evidenceDirectory, ARTIFACT_DIRECTORY);
    await mkdir(artifactRoot, { mode: 0o700 });
    const manifest = await makeArtifact({
      root,
      destination: artifactRoot,
      build: first,
      source,
      bunVersion,
      bunExecutableDigest,
      wranglerVersion,
      wranglerEntrypointDigest,
      wranglerPackageJsonDigest,
    });
    await hardenArtifactTree(artifactRoot);
    const artifactManifestPath = join(artifactRoot, ARTIFACT_MANIFEST_FILE);
    await writePrivateJson(artifactManifestPath, manifest);
    const artifactDigests = [
      manifest.digests.worker,
      manifest.digests.assets,
      manifest.digests.migrations,
    ];
    const productionHealth = candidateHealthChecks(
      PRODUCTION_HEALTH_NAMES,
      policy.policy.production,
      artifactDigests,
      productionConfigDigest,
    );
    const stagingHealth = candidateHealthChecks(
      STAGING_HEALTH_NAMES,
      policy.policy.staging,
      artifactDigests,
      stagingConfigDigest,
    );
    const candidate: StoreReleaseCandidate = {
      kind: "takos.direct-deployment-release-candidate@v1",
      surfaceId: SURFACE_ID,
      repository: REPOSITORY,
      sourceCommit: source.commit,
      version: VERSION,
      builtAt: source.builtAt,
      artifactDigests,
      sbomDigests: [manifest.digests.sbom],
      provenanceDigests: [manifest.digests.provenance],
      configDigest: productionConfigDigest,
      policyDigest: policy.digest,
      toolchainDigest: digestJson(manifest.toolchain),
      targetFingerprint: targetFingerprint(
        policy.policy.production,
        productionConfigDigest,
        policy.digest,
      ),
      healthChecks: productionHealth,
      staging: {
        configDigest: stagingConfigDigest,
        targetFingerprint: targetFingerprint(
          policy.policy.staging,
          stagingConfigDigest,
          policy.digest,
        ),
        healthChecks: stagingHealth,
      },
    };
    const candidatePath = join(evidenceDirectory, CANDIDATE_FILE);
    await writePrivateJson(candidatePath, candidate);
    return { candidatePath, artifactManifestPath, candidate };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const evidenceDirectory = argument(args, "--evidence-directory");
  const operatorRoot = argument(args, "--operator-root");
  if (
    args.length !== 4 ||
    !evidenceDirectory?.startsWith("/") ||
    !operatorRoot?.startsWith("/")
  ) {
    throw new Error(
      "usage_requires_absolute_evidence_directory_and_operator_root",
    );
  }
  const result = await buildStoreReleaseCandidate({
    sourceRoot: resolve(import.meta.dir, ".."),
    operatorRoot,
    evidenceDirectory,
  });
  process.stdout.write(
    `${JSON.stringify({
      kind: "takosumi.store-release-candidate-build@v1",
      status: "built",
      surfaceId: SURFACE_ID,
      sourceCommit: result.candidate.sourceCommit,
      version: VERSION,
      candidatePath: result.candidatePath,
      artifactManifestPath: result.artifactManifestPath,
      artifactDigests: result.candidate.artifactDigests,
    })}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9_]+/u.test(error.message)
        ? error.message.match(/^[a-z0-9_]+/u)![0]
        : "store_release_candidate_failed";
    process.stderr.write(`takosumi-store candidate blocked: ${code}\n`);
    process.exitCode = 1;
  }
}
