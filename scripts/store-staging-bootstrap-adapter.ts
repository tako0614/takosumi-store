import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  REPOSITORY,
  SURFACE_ID,
  VERSION,
  assertVersionBindings,
  canonicalJson,
  createCloudflareReadClient,
  createWranglerRunner,
  deploymentHasExactVersionAtFullTraffic,
  digestJson,
  isRecord,
  parseJsonOutput,
  parseVersionId,
  readCredentialFiles,
  readPrivateFile,
  readPrivateJson,
  readRuntimeTopology,
  sha256Bytes,
  validateRealizedConfig,
  writePrivateJson,
  type CloudflareReadClient,
  type JsonObject,
  type TargetPolicy,
  type WranglerRunner,
} from "./store-release-common.ts";

export const BOOTSTRAP_POLICY_FILE = "store/staging-bootstrap-policy.json";
export const BOOTSTRAP_ACTIONS = [
  "plan",
  "provision",
  "attest",
  "adopt",
  "cleanup-plan",
  "destroy",
  "quarantine",
] as const;
export type BootstrapAction = (typeof BOOTSTRAP_ACTIONS)[number];

const MUTATIONS = new Set<BootstrapAction>([
  "provision",
  "adopt",
  "destroy",
  "quarantine",
]);
const ACCOUNT = /^[0-9a-f]{32}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KV_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BOOTSTRAP_TAG = "staging-bootstrap-v1";
const PROGRESS_FILE = "store-staging-bootstrap-progress.json";
const INVENTORY_FILE = "store-staging-bootstrap-inventory.json";
const EVIDENCE_FILE: Record<BootstrapAction, string> = {
  plan: "store-staging-bootstrap-plan.json",
  provision: INVENTORY_FILE,
  attest: "store-staging-bootstrap-attestation.json",
  adopt: "store-staging-bootstrap-adoption.json",
  "cleanup-plan": "store-staging-bootstrap-cleanup-plan.json",
  destroy: "store-staging-bootstrap-destroy-attestation.json",
  quarantine: "store-staging-bootstrap-quarantine-attestation.json",
};

export interface BootstrapStagingTarget extends JsonObject {
  readonly configPath: "store/wrangler.staging.toml";
  readonly accountId: string;
  readonly workerName: "takosumi-store-staging";
  readonly origin: "https://store-staging.takosumi.com";
  readonly databaseName: "takosumi-store-staging-db";
  readonly kvNamespaceName: "takosumi-store-staging-kv";
  readonly iconsBucketName: "takosumi-store-staging-icons";
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly vars: {
    readonly APP_URL: "https://store-staging.takosumi.com";
    readonly TAKOSUMI_ACCOUNTS_CLIENT_ID: string;
    readonly TAKOSUMI_ACCOUNTS_ISSUER_URL: string;
  };
  readonly requiredSecretNames: readonly ["SESSION_HASH_SALT"];
  readonly customDomainHostname: "store-staging.takosumi.com";
  readonly readbackListingPath: "/tcs/v1/listings/tako/takos";
}

export interface BootstrapPolicy extends JsonObject {
  readonly kind: "takosumi.store-staging-bootstrap-policy@v1";
  readonly surfaceId: typeof SURFACE_ID;
  readonly production: TargetPolicy;
  readonly staging: BootstrapStagingTarget;
  readonly cleanupPolicy: "destroy-only-before-adoption-or-first-candidate";
}

export interface BootstrapEnvelope extends JsonObject {
  readonly kind: "takosumi.store-staging-bootstrap-envelope@v1";
  readonly operationId: string;
  readonly surfaceId: typeof SURFACE_ID;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly source: {
    readonly repository: typeof REPOSITORY;
    readonly commit: string;
    readonly clean: true;
    readonly pushed: true;
  };
  readonly controllerSource: {
    readonly repository: string;
    readonly commit: string;
    readonly clean: true;
    readonly pushed: true;
  };
  readonly authority: {
    readonly adapterDigest: string;
    readonly operatorPolicyDigest: string;
  };
  readonly evidence: {
    readonly directory: string;
    readonly permissions: "0700-directory/0600-files";
  };
  readonly productionFallback: false;
}

export interface BootstrapInventory extends JsonObject {
  readonly kind: "takosumi.store-staging-bootstrap-inventory@v1";
  readonly operationId: string;
  readonly sourceCommit: string;
  readonly controllerCommit: string;
  readonly target: BootstrapStagingTarget & {
    readonly databaseId: string;
    readonly kvNamespaceId: string;
    readonly versionId: string;
  };
  readonly configDigest: string;
  readonly releasePolicyDigest: string;
  readonly versionDigest: string;
  readonly deploymentDigest: string;
  readonly topologyDigest: string;
  readonly productionFallback: false;
}

export interface BootstrapProgress extends JsonObject {
  readonly kind: "takosumi.store-staging-bootstrap-progress@v1";
  readonly operationId: string;
  readonly status:
    | "provisioning"
    | "provisioned"
    | "adopted"
    | "quarantined"
    | "destroyed";
  readonly resources: readonly {
    readonly type: "d1" | "kv" | "r2" | "worker" | "custom-domain";
    readonly name: string;
    readonly id?: string;
    readonly state:
      | "intent-recorded"
      | "present"
      | "presence-unknown"
      | "retained-quarantined"
      | "disabled"
      | "deleted";
  }[];
  readonly steps: readonly string[];
  readonly productionFallback: false;
}

interface MutationClient {
  request(
    method: "DELETE" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<unknown>;
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): void {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  ) {
    throw new Error(`${label}_schema_invalid`);
  }
}

function assertFixedProduction(target: TargetPolicy): void {
  exactKeys(
    target,
    [
      "configPath",
      "accountId",
      "workerName",
      "origin",
      "databaseName",
      "databaseId",
      "kvNamespaceId",
      "iconsBucketName",
      "publishCapability",
      "compatibilityDate",
      "compatibilityFlags",
      "requiredVarNames",
      "requiredSecretNames",
      "customDomainHostname",
      "readbackListingPath",
    ],
    "bootstrap_production",
  );
  if (
    target.configPath !== "store/wrangler.production.toml" ||
    target.workerName !== "takosumi-store" ||
    target.origin !== "https://store.takosumi.com" ||
    target.customDomainHostname !== "store.takosumi.com" ||
    target.databaseName !== "takosumi-store-db" ||
    !ACCOUNT.test(target.accountId) ||
    !UUID.test(target.databaseId) ||
    !KV_ID.test(target.kvNamespaceId) ||
    target.publishCapability !== true ||
    target.readbackListingPath !== "/tcs/v1/listings/tako/takos" ||
    canonicalJson(target.requiredVarNames) !==
      canonicalJson([
        "APP_URL",
        "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      ]) ||
    canonicalJson(target.requiredSecretNames) !==
      canonicalJson(["SESSION_HASH_SALT"])
  ) {
    throw new Error("bootstrap_production_identity_invalid");
  }
}

export function validateBootstrapPolicy(value: unknown): BootstrapPolicy {
  exactKeys(
    value,
    ["kind", "surfaceId", "production", "staging", "cleanupPolicy"],
    "bootstrap_policy",
  );
  const policy = value as unknown as BootstrapPolicy;
  exactKeys(
    policy.staging,
    [
      "configPath",
      "accountId",
      "workerName",
      "origin",
      "databaseName",
      "kvNamespaceName",
      "iconsBucketName",
      "compatibilityDate",
      "compatibilityFlags",
      "vars",
      "requiredSecretNames",
      "customDomainHostname",
      "readbackListingPath",
    ],
    "bootstrap_staging",
  );
  exactKeys(
    policy.staging.vars,
    ["APP_URL", "TAKOSUMI_ACCOUNTS_CLIENT_ID", "TAKOSUMI_ACCOUNTS_ISSUER_URL"],
    "bootstrap_staging_vars",
  );
  assertFixedProduction(policy.production);
  const staging = policy.staging;
  if (
    policy.kind !== "takosumi.store-staging-bootstrap-policy@v1" ||
    policy.surfaceId !== SURFACE_ID ||
    policy.cleanupPolicy !==
      "destroy-only-before-adoption-or-first-candidate" ||
    staging.accountId !== policy.production.accountId ||
    staging.configPath !== "store/wrangler.staging.toml" ||
    staging.workerName !== "takosumi-store-staging" ||
    staging.origin !== "https://store-staging.takosumi.com" ||
    staging.customDomainHostname !== "store-staging.takosumi.com" ||
    staging.databaseName !== "takosumi-store-staging-db" ||
    staging.kvNamespaceName !== "takosumi-store-staging-kv" ||
    staging.iconsBucketName !== "takosumi-store-staging-icons" ||
    staging.vars.APP_URL !== staging.origin ||
    staging.readbackListingPath !== "/tcs/v1/listings/tako/takos" ||
    !/^https:\/\//u.test(staging.vars.TAKOSUMI_ACCOUNTS_ISSUER_URL) ||
    typeof staging.vars.TAKOSUMI_ACCOUNTS_CLIENT_ID !== "string" ||
    staging.vars.TAKOSUMI_ACCOUNTS_CLIENT_ID.length < 3 ||
    canonicalJson(staging.compatibilityFlags) !==
      canonicalJson(["global_fetch_strictly_public", "nodejs_compat"]) ||
    canonicalJson(staging.requiredSecretNames) !==
      canonicalJson(["SESSION_HASH_SALT"])
  ) {
    throw new Error("bootstrap_staging_identity_invalid");
  }
  const serialized = canonicalJson(staging);
  if (/placeholder|todo|changeme|example\.com/iu.test(serialized)) {
    throw new Error("bootstrap_placeholder_forbidden");
  }
  return policy;
}

export function makeStagingConfig(
  staging: BootstrapStagingTarget,
  databaseId: string,
  kvNamespaceId: string,
  options: { route?: boolean; main?: string; assets?: string } = {},
): string {
  const flags = staging.compatibilityFlags
    .map((flag) => JSON.stringify(flag))
    .join(", ");
  const route =
    options.route === false
      ? ""
      : `\n[[routes]]\npattern = ${JSON.stringify(staging.customDomainHostname)}\ncustom_domain = true\n`;
  return `name = ${JSON.stringify(staging.workerName)}
main = ${JSON.stringify(options.main ?? "src/backend/index.ts")}
compatibility_date = ${JSON.stringify(staging.compatibilityDate)}
compatibility_flags = [${flags}]

[vars]
APP_URL = ${JSON.stringify(staging.vars.APP_URL)}
TAKOSUMI_ACCOUNTS_CLIENT_ID = ${JSON.stringify(staging.vars.TAKOSUMI_ACCOUNTS_CLIENT_ID)}
TAKOSUMI_ACCOUNTS_ISSUER_URL = ${JSON.stringify(staging.vars.TAKOSUMI_ACCOUNTS_ISSUER_URL)}

[[d1_databases]]
binding = "DB"
database_name = ${JSON.stringify(staging.databaseName)}
database_id = ${JSON.stringify(databaseId)}
migrations_dir = "migrations"

[[r2_buckets]]
binding = "ICONS"
bucket_name = ${JSON.stringify(staging.iconsBucketName)}

[[kv_namespaces]]
binding = "KV"
id = ${JSON.stringify(kvNamespaceId)}

[assets]
directory = ${JSON.stringify(options.assets ?? "./dist")}
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"
${route}`;
}

function targetPolicy(
  staging: BootstrapStagingTarget,
  databaseId: string,
  kvNamespaceId: string,
): TargetPolicy {
  return {
    configPath: staging.configPath,
    accountId: staging.accountId,
    workerName: staging.workerName,
    origin: staging.origin,
    databaseName: staging.databaseName,
    databaseId,
    kvNamespaceId,
    iconsBucketName: staging.iconsBucketName,
    publishCapability: true,
    compatibilityDate: staging.compatibilityDate,
    compatibilityFlags: staging.compatibilityFlags,
    requiredVarNames: Object.keys(staging.vars).sort(),
    requiredSecretNames: staging.requiredSecretNames,
    customDomainHostname: staging.customDomainHostname,
    readbackListingPath: staging.readbackListingPath,
  };
}

function exactD1Id(output: string, name: string): string | null {
  const value = parseJsonOutput(output, "bootstrap_d1_list");
  if (!Array.isArray(value)) throw new Error("bootstrap_d1_list_invalid");
  const matches = value.filter(
    (entry) =>
      isRecord(entry) && (entry.name === name || entry.database_name === name),
  );
  if (matches.length > 1) throw new Error("bootstrap_d1_name_ambiguous");
  if (matches.length === 0) return null;
  const id = String(matches[0]!.uuid ?? matches[0]!.id ?? "");
  if (!UUID.test(id)) throw new Error("bootstrap_d1_id_invalid");
  return id.toLowerCase();
}

function exactKvId(output: string, name: string): string | null {
  const value = parseJsonOutput(output, "bootstrap_kv_list");
  if (!Array.isArray(value)) throw new Error("bootstrap_kv_list_invalid");
  const matches = value.filter(
    (entry) => isRecord(entry) && entry.title === name,
  );
  if (matches.length > 1) throw new Error("bootstrap_kv_name_ambiguous");
  if (matches.length === 0) return null;
  const id = String(matches[0]!.id ?? "");
  if (!KV_ID.test(id)) throw new Error("bootstrap_kv_id_invalid");
  return id;
}

function parseCreatedId(
  output: string,
  expression: RegExp,
  label: string,
): string {
  const match = output.match(expression)?.[1];
  if (!match) throw new Error(`${label}_missing`);
  return match.toLowerCase();
}

export function recoverExactlyOne<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  label: string,
): T | null {
  const matches = values.filter(predicate);
  if (matches.length > 1) throw new Error(`${label}_ambiguous`);
  return matches[0] ?? null;
}

async function exactR2(
  client: CloudflareReadClient,
  name: string,
): Promise<boolean> {
  const response = await client.get(
    `/accounts/${client.accountId}/r2/buckets`,
    { name },
  );
  if (response.status === "not-found") return false;
  const values = Array.isArray(response.result)
    ? response.result
    : isRecord(response.result) && Array.isArray(response.result.buckets)
      ? response.result.buckets
      : null;
  if (!values) throw new Error("bootstrap_r2_list_invalid");
  return (
    recoverExactlyOne(
      values,
      (entry) => isRecord(entry) && entry.name === name,
      "bootstrap_r2",
    ) !== null
  );
}

async function exactDomain(
  client: CloudflareReadClient,
  hostname: string,
  workerName?: string,
): Promise<JsonObject | null> {
  const response = await client.get(
    `/accounts/${client.accountId}/workers/domains`,
    { hostname },
  );
  if (response.status === "not-found") return null;
  if (!Array.isArray(response.result))
    throw new Error("bootstrap_domain_list_invalid");
  const domain = recoverExactlyOne(
    response.result,
    (entry) => isRecord(entry) && entry.hostname === hostname,
    "bootstrap_domain",
  );
  if (
    domain &&
    (!isRecord(domain) || (workerName && domain.service !== workerName))
  ) {
    throw new Error("bootstrap_domain_owner_mismatch");
  }
  return domain as JsonObject | null;
}

async function dnsRecordPresent(
  client: CloudflareReadClient,
  hostname: string,
): Promise<boolean> {
  const zoneResponse = await client.get("/zones", {
    name: "takosumi.com",
    "account.id": client.accountId,
  });
  if (zoneResponse.status !== "ok" || !Array.isArray(zoneResponse.result)) {
    throw new Error("bootstrap_zone_readback_missing");
  }
  const zone = recoverExactlyOne(
    zoneResponse.result,
    (entry) =>
      isRecord(entry) &&
      entry.name === "takosumi.com" &&
      (!isRecord(entry.account) || entry.account.id === client.accountId),
    "bootstrap_zone",
  );
  const zoneId = isRecord(zone) ? String(zone.id ?? "") : "";
  if (!zoneId) throw new Error("bootstrap_zone_readback_missing");
  const records = await client.get(
    `/zones/${encodeURIComponent(zoneId)}/dns_records`,
    { name: hostname, per_page: "5" },
  );
  if (records.status !== "ok" || !Array.isArray(records.result)) {
    throw new Error("bootstrap_dns_readback_missing");
  }
  return (
    recoverExactlyOne(
      records.result,
      (entry) => isRecord(entry) && entry.name === hostname,
      "bootstrap_dns_record",
    ) !== null
  );
}

function workerState(
  runner: WranglerRunner,
  cwd: string,
  workerName: string,
): "present" | "absent" {
  const value = runner.inspect?.(
    ["deployments", "status", "--name", workerName, "--json"],
    { cwd },
  );
  if (!value) throw new Error("bootstrap_runner_inspection_missing");
  if (value.status === "failed")
    throw new Error("bootstrap_worker_presence_unknown");
  return value.status === "ok" ? "present" : "absent";
}

async function assertAbsent(
  policy: BootstrapPolicy,
  runner: WranglerRunner,
  cwd: string,
  client: CloudflareReadClient,
): Promise<JsonObject> {
  const target = policy.staging;
  const absence = {
    worker: workerState(runner, cwd, target.workerName) === "absent",
    d1:
      exactD1Id(
        runner(["d1", "list", "--json"], { cwd }),
        target.databaseName,
      ) === null,
    kv:
      exactKvId(
        runner(["kv", "namespace", "list"], { cwd }),
        target.kvNamespaceName,
      ) === null,
    r2: !(await exactR2(client, target.iconsBucketName)),
    domain: !(await exactDomain(client, target.customDomainHostname)),
    dns: !(await dnsRecordPresent(client, target.customDomainHostname)),
    productionFallback: false,
  };
  if (
    Object.entries(absence).some(
      ([key, present]) => key !== "productionFallback" && present !== true,
    )
  ) {
    throw new Error("bootstrap_target_not_absent");
  }
  return absence;
}

function updateProgress(
  progress: BootstrapProgress,
  type: BootstrapProgress["resources"][number]["type"],
  state: BootstrapProgress["resources"][number]["state"],
  id?: string,
): BootstrapProgress {
  return {
    ...progress,
    resources: progress.resources.map((resource) =>
      resource.type === type
        ? { ...resource, state, ...(id ? { id } : {}) }
        : resource,
    ),
  };
}

async function writeProgress(
  directory: string,
  progress: BootstrapProgress,
): Promise<void> {
  await writePrivateJson(join(directory, PROGRESS_FILE), progress, {
    replace: true,
  });
}

function bootstrapWorker(): string {
  return `export default {async fetch(request){const path=new URL(request.url).pathname;if(path==="/healthz")return Response.json({status:"bootstrap",software:"takosumi-store",version:"${VERSION}"},{headers:{"cache-control":"no-store"}});return Response.json({error:{code:"staging_bootstrap_in_progress"}},{status:503,headers:{"cache-control":"no-store"}})}};\n`;
}

export async function provisionStoreStaging(options: {
  envelope: BootstrapEnvelope;
  policy: BootstrapPolicy;
  source: string;
  evidence: string;
  secretPath: string;
  runner: WranglerRunner;
  client: CloudflareReadClient;
}): Promise<BootstrapInventory> {
  await assertAbsent(
    options.policy,
    options.runner,
    options.source,
    options.client,
  );
  const target = options.policy.staging;
  const progressPath = join(options.evidence, PROGRESS_FILE);
  const progressInitial: BootstrapProgress = {
    kind: "takosumi.store-staging-bootstrap-progress@v1",
    operationId: options.envelope.operationId,
    status: "provisioning",
    resources: [
      { type: "d1", name: target.databaseName, state: "intent-recorded" },
      { type: "kv", name: target.kvNamespaceName, state: "intent-recorded" },
      { type: "r2", name: target.iconsBucketName, state: "intent-recorded" },
      { type: "worker", name: target.workerName, state: "intent-recorded" },
      {
        type: "custom-domain",
        name: target.customDomainHostname,
        state: "intent-recorded",
      },
    ],
    steps: ["all-create-intents-recorded-before-first-mutation"],
    productionFallback: false,
  };
  await writePrivateJson(progressPath, progressInitial);
  let progress = progressInitial;

  let databaseId: string;
  try {
    databaseId = parseCreatedId(
      options.runner(["d1", "create", target.databaseName], {
        cwd: options.source,
      }),
      /database_id\s*=\s*["']([0-9a-f-]{36})["']/iu,
      "bootstrap_d1_create_id",
    );
  } catch (error) {
    const recovered = exactD1Id(
      options.runner(["d1", "list", "--json"], { cwd: options.source }),
      target.databaseName,
    );
    if (!recovered) {
      await writeProgress(
        options.evidence,
        updateProgress(progress, "d1", "presence-unknown"),
      );
      throw error;
    }
    databaseId = recovered;
  }
  progress = updateProgress(progress, "d1", "present", databaseId);
  await writeProgress(options.evidence, progress);

  let kvNamespaceId: string;
  try {
    kvNamespaceId = parseCreatedId(
      options.runner(["kv", "namespace", "create", target.kvNamespaceName], {
        cwd: options.source,
      }),
      /["']?id["']?\s*[:=]\s*["']([0-9a-f]{32})["']/iu,
      "bootstrap_kv_create_id",
    );
  } catch (error) {
    const recovered = exactKvId(
      options.runner(["kv", "namespace", "list"], { cwd: options.source }),
      target.kvNamespaceName,
    );
    if (!recovered) {
      await writeProgress(
        options.evidence,
        updateProgress(progress, "kv", "presence-unknown"),
      );
      throw error;
    }
    kvNamespaceId = recovered;
  }
  progress = updateProgress(progress, "kv", "present", kvNamespaceId);
  await writeProgress(options.evidence, progress);

  try {
    options.runner(["r2", "bucket", "create", target.iconsBucketName], {
      cwd: options.source,
    });
  } catch (error) {
    if (!(await exactR2(options.client, target.iconsBucketName))) {
      await writeProgress(
        options.evidence,
        updateProgress(progress, "r2", "presence-unknown"),
      );
      throw error;
    }
  }
  if (!(await exactR2(options.client, target.iconsBucketName))) {
    await writeProgress(
      options.evidence,
      updateProgress(progress, "r2", "presence-unknown"),
    );
    throw new Error("bootstrap_r2_readback_missing");
  }
  progress = updateProgress(progress, "r2", "present");
  await writeProgress(options.evidence, progress);

  const temporary = await mkdtemp(join(tmpdir(), "takosumi-store-bootstrap-"));
  await chmod(temporary, 0o700);
  try {
    const assets = join(temporary, "assets");
    await mkdir(assets, { mode: 0o700 });
    await writeFile(
      join(assets, "index.html"),
      "<!doctype html><title>Store bootstrap</title>\n",
      { mode: 0o400, flag: "wx" },
    );
    await writeFile(join(temporary, "bootstrap.mjs"), bootstrapWorker(), {
      mode: 0o400,
      flag: "wx",
    });
    await writeFile(
      join(temporary, "wrangler.toml"),
      makeStagingConfig(target, databaseId, kvNamespaceId, {
        main: "bootstrap.mjs",
        assets: "./assets",
      }),
      { mode: 0o400, flag: "wx" },
    );
    const salt = (await readPrivateFile(options.secretPath, { maxBytes: 4096 }))
      .toString("utf8")
      .trim();
    if (salt.length < 32) throw new Error("bootstrap_session_secret_invalid");
    await writeFile(
      join(temporary, "secrets.json"),
      `${JSON.stringify({ SESSION_HASH_SALT: salt })}\n`,
      { mode: 0o400, flag: "wx" },
    );

    let versionId: string;
    try {
      versionId = parseVersionId(
        options.runner(
          [
            "versions",
            "upload",
            "bootstrap.mjs",
            "--no-bundle",
            "--assets",
            "assets",
            "--config",
            "wrangler.toml",
            "--secrets-file",
            "secrets.json",
            "--tag",
            BOOTSTRAP_TAG,
            "--message",
            options.envelope.operationId,
          ],
          { cwd: temporary },
        ),
      );
    } catch (error) {
      const listed = parseJsonOutput(
        options.runner(
          ["versions", "list", "--name", target.workerName, "--json"],
          { cwd: temporary },
        ),
        "bootstrap_version_recovery",
      );
      if (!Array.isArray(listed)) throw error;
      const recovered = recoverExactlyOne(
        listed,
        (entry) => {
          if (!isRecord(entry)) return false;
          const annotations = isRecord(entry.annotations)
            ? entry.annotations
            : {};
          return (
            annotations["workers/message"] === options.envelope.operationId &&
            annotations["workers/tag"] === BOOTSTRAP_TAG
          );
        },
        "bootstrap_version_recovery",
      );
      const recoveredId = isRecord(recovered) ? String(recovered.id ?? "") : "";
      if (!UUID.test(recoveredId)) {
        await writeProgress(
          options.evidence,
          updateProgress(progress, "worker", "presence-unknown"),
        );
        throw error;
      }
      versionId = recoveredId;
    }
    const realized = targetPolicy(target, databaseId, kvNamespaceId);
    const version = parseJsonOutput(
      options.runner(
        [
          "versions",
          "view",
          versionId,
          "--name",
          target.workerName,
          "--config",
          "wrangler.toml",
          "--json",
        ],
        { cwd: temporary },
      ),
      "bootstrap_version_readback",
    );
    assertVersionBindings(version, versionId, realized);
    progress = updateProgress(progress, "worker", "present", versionId);
    await writeProgress(options.evidence, progress);
    try {
      options.runner(
        [
          "versions",
          "deploy",
          `${versionId}@100%`,
          "--name",
          target.workerName,
          "--config",
          "wrangler.toml",
          "--yes",
          "--message",
          options.envelope.operationId,
        ],
        { cwd: temporary },
      );
    } catch (error) {
      const recovered = parseJsonOutput(
        options.runner(
          ["deployments", "status", "--name", target.workerName, "--json"],
          { cwd: temporary },
        ),
        "bootstrap_deployment_recovery",
      );
      if (!deploymentHasExactVersionAtFullTraffic(recovered, versionId))
        throw error;
    }
    const deployment = parseJsonOutput(
      options.runner(
        ["deployments", "status", "--name", target.workerName, "--json"],
        { cwd: temporary },
      ),
      "bootstrap_deployment_readback",
    );
    if (!deploymentHasExactVersionAtFullTraffic(deployment, versionId))
      throw new Error("bootstrap_deployment_readback_mismatch");
    try {
      options.runner(
        [
          "triggers",
          "deploy",
          "--name",
          target.workerName,
          "--config",
          "wrangler.toml",
        ],
        { cwd: temporary },
      );
    } catch (error) {
      if (
        !(await exactDomain(
          options.client,
          target.customDomainHostname,
          target.workerName,
        ))
      )
        throw error;
    }
    const topology = await readRuntimeTopology(
      options.client,
      realized,
      "custom-domain",
    );
    progress = updateProgress(progress, "custom-domain", "present");
    progress = {
      ...progress,
      status: "provisioned",
      steps: [
        ...progress.steps,
        "all-resources-read-back",
        "bootstrap-version-at-100-percent",
      ],
    };
    await writeProgress(options.evidence, progress);

    const config = Buffer.from(
      makeStagingConfig(target, databaseId, kvNamespaceId),
    );
    validateRealizedConfig(config, realized);
    const releasePolicy = Buffer.from(
      `${canonicalJson({ kind: "takosumi.store-release-policy@v1", surfaceId: SURFACE_ID, production: options.policy.production, staging: realized })}\n`,
    );
    await writeFile(
      join(options.evidence, "store-wrangler-staging.toml"),
      config,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      join(options.evidence, "store-release-policy.production.json"),
      releasePolicy,
      { mode: 0o600, flag: "wx" },
    );
    return {
      kind: "takosumi.store-staging-bootstrap-inventory@v1",
      operationId: options.envelope.operationId,
      sourceCommit: options.envelope.source.commit,
      controllerCommit: options.envelope.controllerSource.commit,
      target: { ...target, databaseId, kvNamespaceId, versionId },
      configDigest: sha256Bytes(config),
      releasePolicyDigest: sha256Bytes(releasePolicy),
      versionDigest: digestJson(version),
      deploymentDigest: digestJson(deployment),
      topologyDigest: digestJson(topology),
      productionFallback: false,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function validateEnvelope(value: unknown): BootstrapEnvelope {
  exactKeys(
    value,
    [
      "kind",
      "operationId",
      "surfaceId",
      "requestedAt",
      "expiresAt",
      "source",
      "controllerSource",
      "authority",
      "evidence",
      "productionFallback",
    ],
    "bootstrap_envelope",
  );
  const envelope = value as unknown as BootstrapEnvelope;
  if (
    envelope.kind !== "takosumi.store-staging-bootstrap-envelope@v1" ||
    envelope.surfaceId !== SURFACE_ID ||
    !/^store-staging-bootstrap-[a-z0-9-]{8,80}$/u.test(envelope.operationId) ||
    envelope.source.repository !== REPOSITORY ||
    !COMMIT.test(envelope.source.commit) ||
    envelope.source.clean !== true ||
    envelope.source.pushed !== true ||
    !COMMIT.test(envelope.controllerSource.commit) ||
    envelope.controllerSource.clean !== true ||
    envelope.controllerSource.pushed !== true ||
    !SHA256.test(envelope.authority.adapterDigest) ||
    !SHA256.test(envelope.authority.operatorPolicyDigest) ||
    !envelope.evidence.directory.startsWith("/") ||
    envelope.evidence.permissions !== "0700-directory/0600-files" ||
    envelope.productionFallback !== false ||
    !Number.isFinite(Date.parse(envelope.requestedAt)) ||
    Date.parse(envelope.expiresAt) <= Date.now()
  )
    throw new Error("bootstrap_envelope_invalid");
  return envelope;
}

async function assertAuthorization(
  envelopePath: string,
  envelope: BootstrapEnvelope,
): Promise<void> {
  const bytes = await readPrivateFile(`${envelopePath}.authorization.json`, {
    expectedDirectory: envelope.evidence.directory,
  });
  const expected =
    process.env.TAKOS_STORE_STAGING_BOOTSTRAP_AUTHORIZATION_DIGEST;
  if (!expected || sha256Bytes(bytes) !== expected)
    throw new Error("bootstrap_authorization_digest_mismatch");
  const value = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(value) ||
    value.kind !== "takosumi.store-staging-bootstrap-authorization@v1" ||
    value.operationId !== envelope.operationId ||
    value.envelopeDigest !== sha256Bytes(await readFile(envelopePath)) ||
    value.adapterDigest !== envelope.authority.adapterDigest ||
    value.operatorPolicyDigest !== envelope.authority.operatorPolicyDigest ||
    canonicalJson(value.actions) !==
      canonicalJson(["provision", "adopt", "destroy", "quarantine"]) ||
    value.productionFallback !== false ||
    Date.parse(String(value.expiresAt)) <= Date.now()
  )
    throw new Error("bootstrap_authorization_invalid");
}

function createMutationClient(
  accountId: string,
  token: string,
): MutationClient {
  return {
    async request(method, path, body) {
      if (!path.startsWith(`/accounts/${accountId}/`) || path.includes(".."))
        throw new Error("bootstrap_mutation_path_invalid");
      const response = await fetch(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          method,
          redirect: "error",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      if (!response.ok)
        throw new Error(`bootstrap_mutation_http_${response.status}`);
      const value = await response.json();
      if (!isRecord(value) || value.success !== true)
        throw new Error("bootstrap_mutation_response_invalid");
      return value.result;
    },
  };
}

async function readPolicy(
  operatorRoot: string,
): Promise<{ policy: BootstrapPolicy; digest: string }> {
  const root = await realpath(operatorRoot);
  const path = resolve(root, BOOTSTRAP_POLICY_FILE);
  if (!path.startsWith(`${root}/`)) throw new Error("bootstrap_policy_escape");
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o022) !== 0)
    throw new Error("bootstrap_policy_permissions_invalid");
  const bytes = await readFile(path);
  return {
    policy: validateBootstrapPolicy(JSON.parse(bytes.toString("utf8"))),
    digest: sha256Bytes(bytes),
  };
}

async function verifyGit(
  source: string,
  envelope: BootstrapEnvelope,
): Promise<void> {
  const git = (...args: string[]) => {
    const result = spawnSync("/usr/bin/git", ["-C", source, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) throw new Error("bootstrap_source_git_failed");
    return result.stdout.trim();
  };
  if (
    git("remote", "get-url", "origin") !== REPOSITORY ||
    git("rev-parse", "HEAD") !== envelope.source.commit ||
    git("rev-parse", "origin/main") !== envelope.source.commit ||
    git("status", "--porcelain=v1", "--untracked-files=all") !== ""
  ) {
    throw new Error("bootstrap_source_authority_mismatch");
  }
}

export function assertStagingOnlyEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (
      name === "CLOUDFLARE_ACCOUNT_ID" ||
      name === "CLOUDFLARE_API_TOKEN" ||
      /^TAKOSUMI_RELEASE_(?:PRODUCTION|REPLICA)_/u.test(name)
    )
      throw new Error(`bootstrap_non_staging_credential_forbidden:${name}`);
  }
}

export function assertBootstrapAuthorityActive(
  progress: BootstrapProgress,
): void {
  if (progress.status === "adopted") {
    throw new Error("bootstrap_authority_permanently_adopted");
  }
}

export function quarantinedProgress(
  progress: BootstrapProgress,
): BootstrapProgress {
  return {
    ...progress,
    status: "quarantined",
    resources: progress.resources.map((resource) =>
      resource.type === "custom-domain"
        ? { ...resource, state: "disabled" }
        : { ...resource, state: "retained-quarantined" },
    ),
    steps: [
      ...progress.steps,
      "custom-domain-and-workers-dev-disabled-storage-retained",
    ],
  };
}

async function verifyControllerChild(
  action: BootstrapAction,
  envelopePath: string,
  source: string,
  operatorRoot: string,
): Promise<void> {
  const controllerInput = process.env.TAKOS_RELEASE_SAFETY_CONTROLLER;
  if (!controllerInput?.startsWith("/")) {
    throw new Error("bootstrap_controller_path_missing");
  }
  const controller = await realpath(controllerInput);
  const child = spawnSync(
    process.execPath,
    [
      controller,
      "staging-bootstrap-child-verify",
      "--surface",
      SURFACE_ID,
      "--action",
      action,
      "--envelope",
      envelopePath,
      "--source-checkout",
      source,
      "--operator-root",
      operatorRoot,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 60_000,
      env: {
        HOME: process.env.HOME ?? "/nonexistent",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        TAKOS_STORE_STAGING_BOOTSTRAP_PARENT_AUTHORIZED: `${SURFACE_ID}@v1`,
        TAKOS_STORE_STAGING_BOOTSTRAP_ACTION: action,
        TAKOS_STORE_STAGING_BOOTSTRAP_ENVELOPE: envelopePath,
        TAKOS_STORE_STAGING_BOOTSTRAP_EXECUTE: MUTATIONS.has(action)
          ? "authorized"
          : "read-only",
        TAKOS_STORE_STAGING_BOOTSTRAP_AUTHORIZATION_DIGEST:
          process.env.TAKOS_STORE_STAGING_BOOTSTRAP_AUTHORIZATION_DIGEST ?? "",
        TAKOS_RELEASE_SAFETY_SOURCE_CHECKOUT: source,
        TAKOS_RELEASE_SAFETY_OPERATOR_ROOT: operatorRoot,
      },
    },
  );
  if (child.status !== 0) {
    throw new Error("bootstrap_controller_child_verification_failed");
  }
}

async function readInventory(
  directory: string,
  envelope: BootstrapEnvelope,
): Promise<BootstrapInventory> {
  const inventory = await readPrivateJson<BootstrapInventory>(
    join(directory, INVENTORY_FILE),
    directory,
  );
  if (
    inventory.kind !== "takosumi.store-staging-bootstrap-inventory@v1" ||
    inventory.operationId !== envelope.operationId ||
    inventory.sourceCommit !== envelope.source.commit ||
    inventory.controllerCommit !== envelope.controllerSource.commit ||
    inventory.productionFallback !== false
  ) {
    throw new Error("bootstrap_inventory_authority_mismatch");
  }
  return inventory;
}

async function assertBootstrapStillOwnsTarget(
  inventory: BootstrapInventory,
  runner: WranglerRunner,
  cwd: string,
  client: CloudflareReadClient,
): Promise<{ version: unknown; deployment: unknown; topology: JsonObject }> {
  const target = targetPolicy(
    inventory.target,
    inventory.target.databaseId,
    inventory.target.kvNamespaceId,
  );
  if (
    exactD1Id(
      runner(["d1", "list", "--json"], { cwd }),
      target.databaseName,
    ) !== target.databaseId ||
    exactKvId(
      runner(["kv", "namespace", "list"], { cwd }),
      inventory.target.kvNamespaceName,
    ) !== target.kvNamespaceId ||
    !(await exactR2(client, target.iconsBucketName))
  )
    throw new Error("bootstrap_storage_ownership_mismatch");
  const version = parseJsonOutput(
    runner(
      [
        "versions",
        "view",
        inventory.target.versionId,
        "--name",
        target.workerName,
        "--json",
      ],
      { cwd },
    ),
    "bootstrap_version_attest",
  );
  assertVersionBindings(version, inventory.target.versionId, target);
  const deployment = parseJsonOutput(
    runner(["deployments", "status", "--name", target.workerName, "--json"], {
      cwd,
    }),
    "bootstrap_deployment_attest",
  );
  if (
    !deploymentHasExactVersionAtFullTraffic(
      deployment,
      inventory.target.versionId,
    )
  )
    throw new Error("bootstrap_target_consumed_by_candidate");
  return {
    version,
    deployment,
    topology: await readRuntimeTopology(client, target, "custom-domain"),
  };
}

async function assertBootstrapStorageUnused(
  inventory: BootstrapInventory,
  runner: WranglerRunner,
  cwd: string,
  client: CloudflareReadClient,
): Promise<JsonObject> {
  const d1 = parseJsonOutput(
    runner(
      [
        "d1",
        "execute",
        inventory.target.databaseName,
        "--remote",
        "--command",
        "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
        "--json",
      ],
      { cwd },
    ),
    "bootstrap_cleanup_d1",
  );
  const groups = Array.isArray(d1) ? d1 : [d1];
  const tableNames = groups.flatMap((group) =>
    isRecord(group) && Array.isArray(group.results)
      ? group.results
          .filter(isRecord)
          .map((row) => String(row.name ?? ""))
          .filter(Boolean)
      : [],
  );
  if (tableNames.some((name) => !/^(?:sqlite_|_cf_)/u.test(name))) {
    throw new Error("bootstrap_cleanup_d1_not_empty");
  }
  const kv = await client.get(
    `/accounts/${client.accountId}/storage/kv/namespaces/${inventory.target.kvNamespaceId}/keys`,
    { limit: "1" },
  );
  if (
    kv.status !== "ok" ||
    !Array.isArray(kv.result) ||
    kv.result.length !== 0
  ) {
    throw new Error("bootstrap_cleanup_kv_not_empty");
  }
  return {
    d1TableNames: tableNames,
    kvKeyCount: 0,
    r2WriteAuthority:
      "sealed-bootstrap-version-has-no-r2-write-path-and-no-first-candidate",
  };
}

export async function runStoreStagingBootstrapAdapter(options: {
  action: string;
  envelopePath: string;
  wrapperPath: string;
  runner?: WranglerRunner;
  client?: CloudflareReadClient;
  mutationClient?: MutationClient;
}): Promise<JsonObject> {
  if (!BOOTSTRAP_ACTIONS.includes(options.action as BootstrapAction))
    throw new Error("bootstrap_action_invalid");
  const action = options.action as BootstrapAction;
  const envelopePath = await realpath(options.envelopePath);
  if (
    process.env.TAKOS_STORE_STAGING_BOOTSTRAP_PARENT_AUTHORIZED !==
      `${SURFACE_ID}@v1` ||
    process.env.TAKOS_STORE_STAGING_BOOTSTRAP_ACTION !== action ||
    process.env.TAKOS_STORE_STAGING_BOOTSTRAP_ENVELOPE !== envelopePath ||
    (MUTATIONS.has(action)
      ? process.env.TAKOS_STORE_STAGING_BOOTSTRAP_EXECUTE !== "authorized"
      : process.env.TAKOS_STORE_STAGING_BOOTSTRAP_EXECUTE === "authorized")
  )
    throw new Error("bootstrap_parent_authority_mismatch");
  assertStagingOnlyEnvironment();
  const source = await realpath(
    String(process.env.TAKOS_RELEASE_SAFETY_SOURCE_CHECKOUT),
  );
  const operatorRoot = await realpath(
    String(process.env.TAKOS_RELEASE_SAFETY_OPERATOR_ROOT),
  );
  await verifyControllerChild(action, envelopePath, source, operatorRoot);
  const envelope = validateEnvelope(
    await readPrivateJson(envelopePath, dirname(envelopePath)),
  );
  await verifyGit(source, envelope);
  if (
    sha256Bytes(await readFile(options.wrapperPath)) !==
    envelope.authority.adapterDigest
  )
    throw new Error("bootstrap_adapter_digest_mismatch");
  const policyRecord = await readPolicy(operatorRoot);
  if (policyRecord.digest !== envelope.authority.operatorPolicyDigest)
    throw new Error("bootstrap_policy_digest_mismatch");
  const evidence = await realpath(envelope.evidence.directory);
  if (dirname(envelopePath) !== evidence)
    throw new Error("bootstrap_evidence_directory_mismatch");
  if (MUTATIONS.has(action)) await assertAuthorization(envelopePath, envelope);
  const credentials = await readCredentialFiles(
    "TAKOSUMI_RELEASE_STAGING_ACCOUNT_ID_FILE",
    "TAKOSUMI_RELEASE_STAGING_API_TOKEN_FILE",
    policyRecord.policy.staging.accountId,
  );
  const runner =
    options.runner ??
    createWranglerRunner({
      wranglerEntrypoint: await realpath(
        join(source, "node_modules/wrangler/wrangler-dist/cli.js"),
      ),
      accountId: credentials.accountId,
      apiToken: credentials.apiToken,
    });
  const client = options.client ?? createCloudflareReadClient(credentials);
  const mutation =
    options.mutationClient ??
    createMutationClient(credentials.accountId, credentials.apiToken);

  let evidenceValue: JsonObject;
  if (action === "plan") {
    const absence = await assertAbsent(
      policyRecord.policy,
      runner,
      source,
      client,
    );
    evidenceValue = {
      kind: "takosumi.store-staging-bootstrap-plan@v1",
      operationId: envelope.operationId,
      target: policyRecord.policy.staging,
      absenceDigest: digestJson(absence),
      productionFallback: false,
    };
  } else if (action === "provision") {
    const secretPath =
      process.env.TAKOSUMI_RELEASE_STAGING_SESSION_HASH_SALT_FILE;
    if (!secretPath?.startsWith("/"))
      throw new Error("bootstrap_session_secret_file_missing");
    evidenceValue = await provisionStoreStaging({
      envelope,
      policy: policyRecord.policy,
      source,
      evidence,
      secretPath,
      runner,
      client,
    });
  } else {
    const inventory = await readInventory(evidence, envelope);
    const progressPath = join(evidence, PROGRESS_FILE);
    const progress = await readPrivateJson<BootstrapProgress>(
      progressPath,
      evidence,
    );
    assertBootstrapAuthorityActive(progress);
    const readback = await assertBootstrapStillOwnsTarget(
      inventory,
      runner,
      source,
      client,
    );
    if (action === "attest") {
      evidenceValue = {
        kind: "takosumi.store-staging-bootstrap-attestation@v1",
        status: "verified",
        operationId: envelope.operationId,
        inventoryDigest: digestJson(inventory),
        readbackDigest: digestJson(readback),
        productionFallback: false,
      };
    } else if (action === "adopt") {
      const adopted = {
        ...progress,
        status: "adopted" as const,
        steps: [
          ...progress.steps,
          "release-controller-adopted-target-bootstrap-authority-revoked",
        ],
      };
      await writeProgress(evidence, adopted);
      evidenceValue = {
        kind: "takosumi.store-staging-bootstrap-adoption@v1",
        status: "adopted",
        operationId: envelope.operationId,
        inventoryDigest: digestJson(inventory),
        configDigest: inventory.configDigest,
        releasePolicyDigest: inventory.releasePolicyDigest,
        bootstrapCleanupAuthorityRevoked: true,
        productionFallback: false,
      };
    } else if (action === "cleanup-plan") {
      const unusedStorage = await assertBootstrapStorageUnused(
        inventory,
        runner,
        source,
        client,
      );
      evidenceValue = {
        kind: "takosumi.store-staging-bootstrap-cleanup-plan@v1",
        status: "safe-before-adoption-or-first-candidate",
        operationId: envelope.operationId,
        bootstrapVersionId: inventory.target.versionId,
        inventoryDigest: digestJson(inventory),
        exactResources: progress.resources,
        unusedStorageDigest: digestJson(unusedStorage),
        productionFallback: false,
      };
    } else if (action === "quarantine") {
      const domain = await exactDomain(
        client,
        inventory.target.customDomainHostname,
        inventory.target.workerName,
      );
      if (domain) {
        const domainId = String(domain.id ?? "");
        if (!domainId) throw new Error("bootstrap_domain_id_missing");
        await mutation.request(
          "DELETE",
          `/accounts/${client.accountId}/workers/domains/${encodeURIComponent(domainId)}`,
        );
      }
      await mutation.request(
        "PUT",
        `/accounts/${client.accountId}/workers/scripts/${encodeURIComponent(inventory.target.workerName)}/subdomain`,
        { enabled: false, previews_enabled: false },
      );
      if (await exactDomain(client, inventory.target.customDomainHostname))
        throw new Error("bootstrap_quarantine_domain_readback_failed");
      const quarantined = quarantinedProgress(progress);
      await writeProgress(evidence, quarantined);
      evidenceValue = {
        kind: "takosumi.store-staging-bootstrap-quarantine-attestation@v1",
        status: "quarantined",
        operationId: envelope.operationId,
        storageRetained: true,
        publicIngressDisabled: true,
        inventoryDigest: digestJson(inventory),
        productionFallback: false,
      };
    } else if (action === "destroy") {
      const cleanupPlan = await readPrivateJson<JsonObject>(
        join(evidence, EVIDENCE_FILE["cleanup-plan"]),
        evidence,
      );
      if (
        cleanupPlan.kind !==
          "takosumi.store-staging-bootstrap-cleanup-plan@v1" ||
        cleanupPlan.operationId !== envelope.operationId ||
        cleanupPlan.inventoryDigest !== digestJson(inventory)
      ) {
        throw new Error("bootstrap_cleanup_plan_authority_mismatch");
      }
      await assertBootstrapStorageUnused(inventory, runner, source, client);
      const temporary = await mkdtemp(
        join(tmpdir(), "takosumi-store-bootstrap-cleanup-"),
      );
      await chmod(temporary, 0o700);
      try {
        await writeFile(
          join(temporary, "wrangler.toml"),
          makeStagingConfig(
            inventory.target,
            inventory.target.databaseId,
            inventory.target.kvNamespaceId,
            { route: false },
          ),
          { mode: 0o400, flag: "wx" },
        );
        runner(
          [
            "triggers",
            "deploy",
            "--name",
            inventory.target.workerName,
            "--config",
            "wrangler.toml",
          ],
          { cwd: temporary },
        );
        if (await exactDomain(client, inventory.target.customDomainHostname))
          throw new Error("bootstrap_destroy_domain_readback_failed");
        runner(
          [
            "delete",
            "--name",
            inventory.target.workerName,
            "--config",
            "wrangler.toml",
            "--force",
          ],
          { cwd: temporary },
        );
        runner(["r2", "bucket", "delete", inventory.target.iconsBucketName], {
          cwd: temporary,
        });
        runner(
          [
            "kv",
            "namespace",
            "delete",
            "--namespace-id",
            inventory.target.kvNamespaceId,
          ],
          { cwd: temporary },
        );
        runner(
          [
            "d1",
            "delete",
            inventory.target.databaseName,
            "--skip-confirmation",
          ],
          { cwd: temporary },
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      if (
        workerState(runner, source, inventory.target.workerName) !== "absent" ||
        exactD1Id(
          runner(["d1", "list", "--json"], { cwd: source }),
          inventory.target.databaseName,
        ) !== null ||
        exactKvId(
          runner(["kv", "namespace", "list"], { cwd: source }),
          inventory.target.kvNamespaceName,
        ) !== null ||
        (await exactR2(client, inventory.target.iconsBucketName)) ||
        (await exactDomain(client, inventory.target.customDomainHostname))
      )
        throw new Error("bootstrap_destroy_readback_failed");
      await writeProgress(evidence, {
        ...progress,
        status: "destroyed",
        resources: progress.resources.map((resource) => ({
          ...resource,
          state: "deleted",
        })),
        steps: [
          ...progress.steps,
          "exact-bootstrap-resources-deleted-and-read-back",
        ],
      });
      evidenceValue = {
        kind: "takosumi.store-staging-bootstrap-destroy-attestation@v1",
        status: "destroyed",
        operationId: envelope.operationId,
        inventoryDigest: digestJson(inventory),
        productionFallback: false,
      };
    } else throw new Error("bootstrap_action_unreachable");
  }
  const bytes = await writePrivateJson(
    join(evidence, EVIDENCE_FILE[action]),
    evidenceValue,
  );
  return {
    kind: "takosumi.store-staging-bootstrap-action-result@v1",
    status: action,
    action,
    operationId: envelope.operationId,
    evidenceFile: EVIDENCE_FILE[action],
    evidenceDigest: sha256Bytes(bytes),
    targetInventoryDigest: digestJson(evidenceValue),
    productionFallback: false,
  };
}

export async function mainStoreStagingBootstrapAdapter(
  wrapperPath: string,
): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    args[1] !== "--envelope" ||
    !args[2]?.startsWith("/")
  )
    throw new Error("bootstrap_fixed_arguments_invalid");
  const result = await runStoreStagingBootstrapAdapter({
    action: args[0]!,
    envelopePath: args[2]!,
    wrapperPath,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
