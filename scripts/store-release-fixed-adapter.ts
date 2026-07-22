import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CANONICAL_CANARY_SOURCE_GIT,
  PRODUCTION_ATTESTATION_FILE,
  STAGING_ATTESTATION_FILE,
  SURFACE_ID,
  VERSION,
  assertMigrationReadback,
  assertVersionBindings,
  canonicalJson,
  createWranglerRunner,
  deploymentHasExactVersionAtFullTraffic,
  digestJson,
  parseJsonOutput,
  parseVersionId,
  readCredentialFiles,
  createCloudflareReadClient,
  readPolicy,
  readRuntimeTopology,
  runLiveChecks,
  secureResolveInside,
  sha256Bytes,
  targetFingerprint,
  validateEnvelope,
  validateRealizedConfig,
  verifyActualToolchain,
  verifyArtifact,
  verifySourceAuthority,
  writePrivateJson,
  readPrivateJson,
  readPrivateFile,
  type HealthCheck,
  type JsonObject,
  type ReleaseEnvelope,
  type StoreArtifactManifest,
  type TargetPolicy,
  type WranglerRunner,
} from "./store-release-common.ts";

export type ReleaseEnvironment = "staging" | "production";

interface Authorization {
  readonly envelope: ReleaseEnvelope;
  readonly sourceCheckout: string;
  readonly operatorRoot: string;
}

interface DeploymentReadback {
  readonly versionId: string;
  readonly version: unknown;
  readonly deployments: unknown;
  readonly migrations: string;
  readonly migrationLineage: unknown;
  readonly healthChecks: readonly HealthCheck[];
  readonly topology: JsonObject;
}

const OPERATION_PHASES = [
  "intent-recorded",
  "schema-applied",
  "version-uploaded",
  "deployed",
  "verified",
] as const;
type OperationPhase = (typeof OPERATION_PHASES)[number];

function operationPhaseRank(value: string): number {
  return OPERATION_PHASES.indexOf(value as OperationPhase);
}

export interface AdapterOptions {
  readonly environment: ReleaseEnvironment;
  readonly envelopePath: string;
  readonly wrapperPath: string;
  readonly runner?: WranglerRunner;
  readonly skipParentVerification?: boolean;
}

function sha256FileSync(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function safeControllerEnvironment(
  entries: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? "/nonexistent",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    ...entries,
  };
}

async function authorizeParent(
  environment: ReleaseEnvironment,
  envelopePathInput: string,
  options: { skipChildVerification: boolean },
): Promise<Authorization> {
  const envelopePath = await realpath(envelopePathInput);
  const parentEnvelope = process.env.TAKOS_RELEASE_SAFETY_ENVELOPE;
  const sourceInput = process.env.TAKOS_RELEASE_SAFETY_SOURCE_CHECKOUT;
  const operatorRootInput = process.env.TAKOS_RELEASE_SAFETY_OPERATOR_ROOT;
  const controllerInput = process.env.TAKOS_RELEASE_SAFETY_CONTROLLER;
  if (
    parentEnvelope !== envelopePath ||
    !sourceInput?.startsWith("/") ||
    !operatorRootInput?.startsWith("/") ||
    !controllerInput?.startsWith("/")
  ) {
    throw new Error("store_release_parent_authority_missing");
  }
  const sourceCheckout = await realpath(sourceInput);
  const operatorRoot = await realpath(operatorRootInput);
  const controller = await realpath(controllerInput);
  if (environment === "production") {
    const authorizationPath =
      process.env.TAKOS_RELEASE_SAFETY_AUTHORIZATION_PATH;
    const authorizationDigest =
      process.env.TAKOS_RELEASE_SAFETY_AUTHORIZATION_DIGEST;
    if (
      process.env.TAKOS_RELEASE_SAFETY_PARENT_AUTHORIZED !==
        `${SURFACE_ID}@v1` ||
      !authorizationPath?.startsWith("/") ||
      !/^sha256:[0-9a-f]{64}$/u.test(authorizationDigest ?? "")
    ) {
      throw new Error("store_release_production_parent_authority_missing");
    }
    if (!options.skipChildVerification) {
      const result = spawnSync(
        process.execPath,
        [
          controller,
          "child-verify",
          "--surface",
          SURFACE_ID,
          "--envelope",
          envelopePath,
          "--source-checkout",
          sourceCheckout,
          "--authorization",
          authorizationPath,
          "--operator-root",
          operatorRoot,
        ],
        {
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 60_000,
          env: safeControllerEnvironment({
            TAKOS_RELEASE_SAFETY_PARENT_AUTHORIZED: `${SURFACE_ID}@v1`,
            TAKOS_RELEASE_SAFETY_ENVELOPE: envelopePath,
            TAKOS_RELEASE_SAFETY_SOURCE_CHECKOUT: sourceCheckout,
            TAKOS_RELEASE_SAFETY_AUTHORIZATION_PATH: authorizationPath,
            TAKOS_RELEASE_SAFETY_AUTHORIZATION_DIGEST: authorizationDigest!,
            TAKOS_RELEASE_SAFETY_OPERATOR_ROOT: operatorRoot,
          }),
        },
      );
      if (result.status !== 0)
        throw new Error("store_release_child_verification_failed");
    }
  } else {
    const envelopeDigest =
      process.env.TAKOS_RELEASE_SAFETY_STAGING_ENVELOPE_DIGEST;
    if (
      process.env.TAKOS_RELEASE_SAFETY_STAGING_PARENT_AUTHORIZED !==
        `${SURFACE_ID}:staging@v1` ||
      !/^sha256:[0-9a-f]{64}$/u.test(envelopeDigest ?? "") ||
      sha256FileSync(envelopePath) !== envelopeDigest
    ) {
      throw new Error("store_release_staging_parent_authority_missing");
    }
    if (!options.skipChildVerification) {
      const result = spawnSync(
        process.execPath,
        [
          controller,
          "child-stage-verify",
          "--surface",
          SURFACE_ID,
          "--envelope",
          envelopePath,
          "--source-checkout",
          sourceCheckout,
          "--operator-root",
          operatorRoot,
        ],
        {
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 60_000,
          env: safeControllerEnvironment({
            TAKOS_RELEASE_SAFETY_STAGING_PARENT_AUTHORIZED: `${SURFACE_ID}:staging@v1`,
            TAKOS_RELEASE_SAFETY_STAGING_ENVELOPE_DIGEST: envelopeDigest!,
            TAKOS_RELEASE_SAFETY_ENVELOPE: envelopePath,
            TAKOS_RELEASE_SAFETY_SOURCE_CHECKOUT: sourceCheckout,
            TAKOS_RELEASE_SAFETY_OPERATOR_ROOT: operatorRoot,
          }),
        },
      );
      if (result.status !== 0)
        throw new Error("store_staging_child_verification_failed");
    }
  }
  const bytes = await readFile(envelopePath);
  if (bytes.byteLength > 1024 * 1024)
    throw new Error("release_envelope_too_large");
  return {
    envelope: validateEnvelope(JSON.parse(bytes.toString("utf8"))),
    sourceCheckout,
    operatorRoot,
  };
}

async function materializeRelease(options: {
  readonly root: string;
  readonly manifest: StoreArtifactManifest;
  readonly configBytes: Uint8Array;
  readonly destination: string;
}): Promise<void> {
  await Promise.all([
    mkdir(join(options.destination, "artifact"), {
      recursive: true,
      mode: 0o700,
    }),
    mkdir(join(options.destination, "artifact/assets"), {
      recursive: true,
      mode: 0o700,
    }),
    mkdir(join(options.destination, "migrations"), {
      recursive: true,
      mode: 0o700,
    }),
  ]);
  await cp(
    join(options.root, options.manifest.worker.path),
    join(options.destination, "artifact/worker.mjs"),
    {
      errorOnExist: true,
      force: false,
    },
  );
  await cp(
    join(options.root, "assets"),
    join(options.destination, "artifact/assets"),
    {
      recursive: true,
      errorOnExist: false,
      force: false,
    },
  );
  await cp(
    join(options.root, "migrations"),
    join(options.destination, "migrations"),
    {
      recursive: true,
      errorOnExist: false,
      force: false,
    },
  );
  await writeFile(
    join(options.destination, "wrangler.toml"),
    options.configBytes,
    {
      mode: 0o400,
      flag: "wx",
    },
  );
}

export function migrationLineageMatches(
  value: unknown,
  manifest: StoreArtifactManifest,
): boolean {
  const expected = manifest.migrations.map((migration) =>
    migration.path.split("/").at(-1),
  );
  const names: string[] = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        if (
          key === "name" &&
          typeof child === "string" &&
          /^[0-9]{4}_.*[.]sql$/u.test(child)
        ) {
          names.push(child);
        } else visit(child);
      }
    }
  };
  visit(value);
  return (
    JSON.stringify([...new Set(names)].sort()) ===
    JSON.stringify([...expected].sort())
  );
}

const STAGING_CANARY_ASSET_PATH = "assets/tako.png";
const STAGING_CANARY_TIMESTAMP = "2026-07-22T00:00:00.000Z";

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function findCanaryRow(value: unknown): JsonObject | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCanaryRow(entry);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const object = value as JsonObject;
  if (object.id === "tako/takos") return object;
  for (const child of Object.values(object)) {
    const found = findCanaryRow(child);
    if (found) return found;
  }
  return null;
}

/**
 * Materialize the one fixed public canary required by the staging readback.
 *
 * This is deliberately staging-only, content-addressed, and insert-only. A
 * conflicting retained row blocks the release instead of being overwritten.
 */
export async function ensureStagingCanary(options: {
  readonly runner: WranglerRunner;
  readonly cwd: string;
  readonly target: TargetPolicy;
  readonly manifest: StoreArtifactManifest;
}): Promise<JsonObject> {
  const asset = options.manifest.assets.find(
    (entry) => entry.path === STAGING_CANARY_ASSET_PATH,
  );
  if (!asset) throw new Error("staging_canary_asset_missing");
  const iconPath = join(options.cwd, "artifact", asset.path);
  const iconBytes = await readFile(iconPath);
  const iconDigest = sha256Bytes(iconBytes);
  if (iconDigest !== asset.sha256 || iconBytes.byteLength !== asset.size) {
    throw new Error("staging_canary_asset_digest_mismatch");
  }
  const iconKey = `icons/${iconDigest.slice("sha256:".length)}`;
  const iconUrl = `${options.target.origin.replace(/\/$/u, "")}/${iconKey}`;
  options.runner(
    [
      "r2",
      "object",
      "put",
      `${options.target.iconsBucketName}/${iconKey}`,
      "--remote",
      "--force",
      "--config",
      "wrangler.toml",
      "--file",
      `artifact/${asset.path}`,
      "--content-type",
      "image/png",
      "--cache-control",
      "public, max-age=31536000, immutable",
    ],
    { cwd: options.cwd },
  );
  const values: Record<string, string> = {
    id: "tako/takos",
    scope: "tako",
    slug: "takos",
    git: CANONICAL_CANARY_SOURCE_GIT,
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
    created_at: STAGING_CANARY_TIMESTAMP,
    updated_at: STAGING_CANARY_TIMESTAMP,
  };
  const columns = Object.keys(values);
  const command = [
    `INSERT OR IGNORE INTO listings (${columns.join(", ")}) VALUES (${columns
      .map((column) => sqlLiteral(values[column]!))
      .join(", ")});`,
    `SELECT ${columns.join(", ")} FROM listings WHERE id = 'tako/takos';`,
  ].join(" ");
  const readback = parseJsonOutput(
    options.runner(
      [
        "d1",
        "execute",
        options.target.databaseName,
        "--remote",
        "--config",
        "wrangler.toml",
        "--command",
        command,
        "--json",
      ],
      { cwd: options.cwd },
    ),
    "staging_canary_readback",
  );
  const row = findCanaryRow(readback);
  if (!row || columns.some((column) => row[column] !== values[column])) {
    throw new Error("staging_canary_readback_mismatch");
  }
  return {
    id: row.id,
    sourceGit: row.git,
    sourcePath: row.path,
    iconDigest,
  };
}

export async function deploySealedStore(options: {
  readonly runner: WranglerRunner;
  readonly cwd: string;
  readonly target: TargetPolicy;
  readonly envelope: ReleaseEnvelope;
  readonly manifest: StoreArtifactManifest;
  readonly candidateChecks: ReleaseEnvelope["candidate"]["healthChecks"];
  readonly deployTriggers?: boolean;
  readonly readTopology: () => Promise<JsonObject>;
  readonly journal?: {
    readonly path: string;
    readonly environment: string;
    readonly targetFingerprint: string;
  };
}): Promise<DeploymentReadback> {
  const config = "wrangler.toml";
  const preTopology = options.deployTriggers
    ? null
    : await options.readTopology();
  const deploymentStatusArgs = [
    "deployments",
    "status",
    "--name",
    options.target.workerName,
    "--config",
    config,
    "--json",
  ] as const;
  const liveBefore = options.journal
    ? parseJsonOutput(
        options.runner(deploymentStatusArgs, { cwd: options.cwd }),
        "worker_predeployment_readback",
      )
    : null;
  const liveBeforeDigest = digestJson(liveBefore);
  let retainedJournal: JsonObject | null = null;
  if (options.journal) {
    try {
      retainedJournal = await readPrivateJson<JsonObject>(
        options.journal.path,
        dirname(options.journal.path),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT"))
        throw error;
    }
  }
  const preDeploymentDigest =
    typeof retainedJournal?.preDeploymentDigest === "string"
      ? retainedJournal.preDeploymentDigest
      : liveBeforeDigest;
  const journalAuthority = options.journal
    ? {
        kind: "takosumi.store-release-operation@v1",
        environment: options.journal.environment,
        surfaceId: SURFACE_ID,
        releaseId: options.envelope.releaseId,
        sourceCommit: options.envelope.source.commit,
        artifactDigests: options.envelope.candidate.artifactDigests,
        targetFingerprint: options.journal.targetFingerprint,
        target: {
          accountId: options.target.accountId,
          workerName: options.target.workerName,
          databaseId: options.target.databaseId,
          kvNamespaceId: options.target.kvNamespaceId,
          iconsBucketName: options.target.iconsBucketName,
          origin: options.target.origin,
        },
        preDeploymentDigest,
      }
    : null;
  let journal: JsonObject | null = null;
  if (options.journal && journalAuthority) {
    try {
      journal =
        retainedJournal ??
        (await readPrivateJson<JsonObject>(
          options.journal.path,
          dirname(options.journal.path),
        ));
      const retainedAuthority = { ...journal };
      for (const key of ["phase", "versionId", "updatedAt"])
        delete retainedAuthority[key];
      if (
        canonicalJson(retainedAuthority) !== canonicalJson(journalAuthority)
      ) {
        throw new Error("release_operation_journal_authority_mismatch");
      }
      if (operationPhaseRank(String(journal.phase)) < 0) {
        throw new Error("release_operation_journal_phase_invalid");
      }
      const phase = String(journal.phase);
      const versionRequired = operationPhaseRank(phase) >= 2;
      if (
        versionRequired !== (typeof journal.versionId === "string") ||
        (versionRequired &&
          !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(String(journal.versionId)))
      ) {
        throw new Error("release_operation_journal_version_invalid");
      }
      if (
        ["intent-recorded", "schema-applied", "version-uploaded"].includes(
          phase,
        ) &&
        liveBeforeDigest !== preDeploymentDigest
      ) {
        throw new Error("release_deployment_head_changed_before_promotion");
      }
      if (
        ["deployed", "verified"].includes(phase) &&
        (typeof journal.versionId !== "string" ||
          !deploymentHasExactVersionAtFullTraffic(
            liveBefore,
            journal.versionId,
          ))
      ) {
        throw new Error("release_resumed_deployment_readback_mismatch");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        journal = {
          ...journalAuthority,
          phase: "intent-recorded",
          versionId: null,
          updatedAt: new Date().toISOString(),
        };
        await writePrivateJson(options.journal.path, journal);
      } else {
        throw error;
      }
    }
  }
  const retainPhase = async (
    phase: OperationPhase,
    versionId: string | null,
  ): Promise<void> => {
    if (!options.journal || !journalAuthority) return;
    const currentPhase = String(journal?.phase ?? "");
    const currentRank = operationPhaseRank(currentPhase);
    const requestedRank = operationPhaseRank(phase);
    if (currentRank < 0 || requestedRank < 0) {
      throw new Error("release_operation_journal_phase_invalid");
    }
    const currentVersion =
      typeof journal?.versionId === "string" ? journal.versionId : null;
    if (currentVersion && versionId && currentVersion !== versionId) {
      throw new Error("release_operation_journal_version_changed");
    }
    if (requestedRank < currentRank) return;
    if (requestedRank === currentRank) {
      if (requestedRank >= 2 && currentVersion !== versionId) {
        throw new Error("release_operation_journal_version_mismatch");
      }
      return;
    }
    if (requestedRank !== currentRank + 1) {
      throw new Error("release_operation_journal_phase_skip");
    }
    if (requestedRank >= 2 !== (typeof versionId === "string")) {
      throw new Error("release_operation_journal_version_invalid");
    }
    journal = {
      ...journalAuthority,
      phase,
      versionId,
      updatedAt: new Date().toISOString(),
    };
    await writePrivateJson(options.journal.path, journal, { replace: true });
  };
  options.runner(
    [
      "d1",
      "migrations",
      "apply",
      options.target.databaseName,
      "--remote",
      "--config",
      config,
    ],
    { cwd: options.cwd },
  );
  await retainPhase(
    "schema-applied",
    typeof journal?.versionId === "string" ? journal.versionId : null,
  );
  const migrations = options.runner(
    [
      "d1",
      "migrations",
      "list",
      options.target.databaseName,
      "--remote",
      "--config",
      config,
    ],
    { cwd: options.cwd },
  );
  assertMigrationReadback(migrations, options.manifest.migrations.length);
  const lineageOutput = options.runner(
    [
      "d1",
      "execute",
      options.target.databaseName,
      "--remote",
      "--config",
      config,
      "--command",
      "SELECT name FROM d1_migrations ORDER BY id",
      "--json",
    ],
    { cwd: options.cwd },
  );
  const migrationLineage = parseJsonOutput(
    lineageOutput,
    "d1_migration_lineage",
  );
  if (!migrationLineageMatches(migrationLineage, options.manifest)) {
    throw new Error("d1_migration_lineage_mismatch");
  }
  if (options.journal?.environment === "staging") {
    await ensureStagingCanary({
      runner: options.runner,
      cwd: options.cwd,
      target: options.target,
      manifest: options.manifest,
    });
  }
  let versionId =
    typeof journal?.versionId === "string" ? journal.versionId : null;
  if (!versionId) {
    const upload = options.runner(
      [
        "versions",
        "upload",
        "artifact/worker.mjs",
        "--no-bundle",
        "--assets",
        "artifact/assets",
        "--config",
        config,
        "--tag",
        VERSION,
        "--message",
        options.envelope.releaseId,
      ],
      { cwd: options.cwd },
    );
    versionId = parseVersionId(upload);
    await retainPhase("version-uploaded", versionId);
  }
  const version = parseJsonOutput(
    options.runner(
      [
        "versions",
        "view",
        versionId,
        "--name",
        options.target.workerName,
        "--config",
        config,
        "--json",
      ],
      { cwd: options.cwd },
    ),
    "worker_version_readback",
  );
  assertVersionBindings(version, versionId, options.target);
  const phaseBeforeDeploy = String(journal?.phase ?? "");
  const prePromotion = options.journal
    ? parseJsonOutput(
        options.runner(deploymentStatusArgs, { cwd: options.cwd }),
        "worker_prepromotion_readback",
      )
    : null;
  if (["deployed", "verified"].includes(phaseBeforeDeploy)) {
    if (!deploymentHasExactVersionAtFullTraffic(prePromotion, versionId)) {
      throw new Error("worker_resumed_deployment_readback_mismatch");
    }
  } else {
    if (options.journal && digestJson(prePromotion) !== preDeploymentDigest) {
      throw new Error("worker_deployment_head_changed_during_release");
    }
    options.runner(
      [
        "versions",
        "deploy",
        `${versionId}@100%`,
        "--name",
        options.target.workerName,
        "--config",
        config,
        "--yes",
        "--message",
        options.envelope.releaseId,
      ],
      { cwd: options.cwd },
    );
    await retainPhase("deployed", versionId);
  }
  const deployments = parseJsonOutput(
    options.runner(deploymentStatusArgs, { cwd: options.cwd }),
    "worker_deployment_readback",
  );
  if (!deploymentHasExactVersionAtFullTraffic(deployments, versionId)) {
    throw new Error("worker_deployment_readback_mismatch");
  }
  if (options.deployTriggers) {
    options.runner(
      [
        "triggers",
        "deploy",
        "--name",
        options.target.workerName,
        "--config",
        config,
      ],
      { cwd: options.cwd },
    );
  }
  const postTopology = await options.readTopology();
  if (
    preTopology &&
    canonicalJson(preTopology) !== canonicalJson(postTopology)
  ) {
    throw new Error("runtime_topology_changed_during_release");
  }
  const healthChecks = await runLiveChecks({
    target: options.target,
    manifest: options.manifest,
    artifactRoot: options.cwd,
    candidateChecks: options.candidateChecks,
  });
  await retainPhase("verified", versionId);
  return {
    versionId,
    version,
    deployments,
    migrations,
    migrationLineage,
    healthChecks,
    topology: postTopology,
  };
}

export async function runStoreReleaseAdapter(
  options: AdapterOptions,
): Promise<JsonObject> {
  const authorization = await authorizeParent(
    options.environment,
    options.envelopePath,
    {
      skipChildVerification: options.skipParentVerification === true,
    },
  );
  const { envelope, sourceCheckout, operatorRoot } = authorization;
  await verifySourceAuthority(sourceCheckout, envelope);
  const wrapperDigest = sha256Bytes(await readFile(options.wrapperPath));
  const expectedAdapterDigest =
    options.environment === "production"
      ? envelope.authority.adapterDigest
      : envelope.authority.stagingAdapterDigest;
  if (wrapperDigest !== expectedAdapterDigest)
    throw new Error("release_adapter_digest_mismatch");
  const policy = await readPolicy(operatorRoot);
  if (
    policy.digest !== envelope.authority.operatorPolicyDigest ||
    policy.digest !== envelope.candidate.policyDigest
  ) {
    throw new Error("release_policy_digest_mismatch");
  }
  const target = policy.policy[options.environment];
  const configPath = await secureResolveInside(operatorRoot, target.configPath);
  const configBytes = await readFile(configPath);
  validateRealizedConfig(configBytes, target);
  const configDigest = sha256Bytes(configBytes);
  const expectedConfigDigest =
    options.environment === "production"
      ? envelope.candidate.configDigest
      : envelope.candidate.staging.configDigest;
  const expectedTargetFingerprint =
    options.environment === "production"
      ? envelope.candidate.targetFingerprint
      : envelope.candidate.staging.targetFingerprint;
  if (
    configDigest !== expectedConfigDigest ||
    targetFingerprint(target, configDigest, policy.digest) !==
      expectedTargetFingerprint
  ) {
    throw new Error("release_config_or_target_fingerprint_mismatch");
  }
  const artifact = await verifyArtifact(envelope.evidence.directory, envelope);
  if (
    digestJson(artifact.manifest.toolchain) !==
    envelope.candidate.toolchainDigest
  ) {
    throw new Error("release_toolchain_digest_mismatch");
  }
  const toolchain = await verifyActualToolchain(
    sourceCheckout,
    artifact.manifest,
  );
  const credentials =
    options.environment === "production"
      ? await readCredentialFiles(
          "TAKOSUMI_RELEASE_ACCOUNT_ID_FILE",
          "TAKOSUMI_RELEASE_API_TOKEN_FILE",
          target.accountId,
        )
      : await readCredentialFiles(
          "TAKOSUMI_RELEASE_STAGING_ACCOUNT_ID_FILE",
          "TAKOSUMI_RELEASE_STAGING_API_TOKEN_FILE",
          target.accountId,
        );
  const cloudflareReadClient = createCloudflareReadClient(credentials);
  const wranglerEntrypoint = toolchain.wranglerEntrypoint;
  const releaseRoot = await mkdtemp(
    join(tmpdir(), `takosumi-store-${options.environment}-release-`),
  );
  await chmod(releaseRoot, 0o700);
  try {
    await materializeRelease({
      root: artifact.root,
      manifest: artifact.manifest,
      configBytes,
      destination: releaseRoot,
    });
    const runner =
      options.runner ??
      createWranglerRunner({
        wranglerEntrypoint,
        accountId: credentials.accountId,
        apiToken: credentials.apiToken,
      });
    const candidateChecks =
      options.environment === "production"
        ? envelope.candidate.healthChecks
        : envelope.candidate.staging.healthChecks;
    const operationJournalPath = join(
      envelope.evidence.directory,
      options.environment === "production"
        ? "output/takosumi-store-operation.json"
        : "store-release-staging-operation.json",
    );
    const readback = await deploySealedStore({
      runner,
      cwd: releaseRoot,
      target,
      envelope,
      manifest: artifact.manifest,
      candidateChecks,
      readTopology: () =>
        readRuntimeTopology(cloudflareReadClient, target, "custom-domain"),
      journal: {
        path: operationJournalPath,
        environment: options.environment,
        targetFingerprint: expectedTargetFingerprint,
      },
    });
    const attestationFile =
      options.environment === "production"
        ? PRODUCTION_ATTESTATION_FILE
        : STAGING_ATTESTATION_FILE;
    const attestationPath = join(envelope.evidence.directory, attestationFile);
    let retainedAttestation: JsonObject | null = null;
    try {
      retainedAttestation = await readPrivateJson<JsonObject>(
        attestationPath,
        dirname(attestationPath),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT"))
        throw error;
    }
    const readbackAt =
      typeof retainedAttestation?.readbackAt === "string"
        ? retainedAttestation.readbackAt
        : new Date().toISOString();
    const attestationBase = {
      kind:
        options.environment === "production"
          ? "takosumi.store-release-attestation@v1"
          : "takosumi.store-staging-release-attestation@v1",
      surfaceId: SURFACE_ID,
      releaseId: envelope.releaseId,
      sourceCommit: envelope.source.commit,
      controllerCommit: envelope.controllerSource.commit,
      controllerDigest: envelope.authority.controllerDigest,
      manifestDigest: envelope.candidate.provenanceDigests[0],
      policyDigest: envelope.candidate.policyDigest,
      targetFingerprint: expectedTargetFingerprint,
      versionId: readback.versionId,
      artifactDigests: envelope.candidate.artifactDigests,
      readbackAt,
      healthChecks: readback.healthChecks,
      remoteEvidence: {
        versionDigest: digestJson(readback.version),
        deploymentDigest: digestJson(readback.deployments),
        migrationReadbackDigest: sha256Bytes(readback.migrations),
        migrationLineageDigest: digestJson(readback.migrationLineage),
        topologyDigest: digestJson(readback.topology),
        operationJournalDigest: sha256Bytes(
          await readPrivateFile(operationJournalPath, {
            expectedDirectory: dirname(operationJournalPath),
          }),
        ),
      },
    };
    const attestation =
      options.environment === "production"
        ? {
            ...attestationBase,
            adapterDigest: envelope.authority.adapterDigest,
          }
        : {
            ...attestationBase,
            stagingAdapterDigest: envelope.authority.stagingAdapterDigest,
          };
    let attestationBytes: Uint8Array;
    try {
      attestationBytes = await writePrivateJson(attestationPath, attestation);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("EEXIST"))
        throw error;
      const retained = await readPrivateFile(attestationPath, {
        expectedDirectory: dirname(attestationPath),
      });
      const expected = Buffer.from(`${canonicalJson(attestation)}\n`);
      if (!retained.equals(expected)) {
        throw new Error("release_attestation_immutable_conflict");
      }
      attestationBytes = retained;
    }
    const common = {
      surfaceId: SURFACE_ID,
      sourceCommit: envelope.source.commit,
      controllerCommit: envelope.controllerSource.commit,
      controllerDigest: envelope.authority.controllerDigest,
      artifactDigests: envelope.candidate.artifactDigests,
      targetFingerprint: expectedTargetFingerprint,
      attestationDigest: sha256Bytes(attestationBytes),
      immutableId: readback.versionId,
      readbackAt,
      healthChecks: readback.healthChecks,
    };
    return options.environment === "production"
      ? {
          kind: "takos.release-safety-adapter-result@v1",
          status: "promoted",
          ...common,
          adapterDigest: envelope.authority.adapterDigest,
        }
      : {
          kind: "takos.release-safety-direct-staging-action-result@v1",
          status: "verified",
          ...common,
          releaseId: envelope.releaseId,
          stagingAdapterDigest: envelope.authority.stagingAdapterDigest,
        };
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
}
