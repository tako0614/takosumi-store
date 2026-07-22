import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SURFACE_ID = "takosumi-store";
export const REPOSITORY = "https://github.com/tako0614/takosumi-store.git";
export const CANONICAL_CANARY_SOURCE_GIT =
  "https://github.com/tako0614/takos.git";
export const VERSION = "0.1.3";
export const TAG = `v${VERSION}`;
export const ARTIFACT_DIRECTORY = "takosumi-store-artifact";
export const ARTIFACT_MANIFEST_FILE = "takosumi-store-artifact-manifest.json";
export const CANDIDATE_FILE = "takosumi-store-release-candidate.json";
export const STAGING_ATTESTATION_FILE =
  "store-release-staging-attestation.json";
export const PRODUCTION_ATTESTATION_FILE =
  "output/takosumi-store-attestation.json";

export const PRODUCTION_HEALTH_NAMES = [
  "production Store Worker exact Version, bindings, and asset readback",
  "production D1 migration lineage and catalog integrity",
  "production TCS ServerInfo and readiness semantics",
  "production SPA static asset and fallback behavior",
] as const;

export const STAGING_HEALTH_NAMES = [
  "staging Store Worker exact Version, bindings, and asset readback",
  "staging D1 migration lineage and catalog integrity",
  "staging TCS ServerInfo and readiness semantics",
  "staging SPA static asset and fallback behavior",
] as const;

export const REPLICA_CHECK_NAMES = [
  "fresh Store Worker exact Version, bindings, and asset readback",
  "fresh D1 migration lineage and sanitized catalog integrity",
  "TCS ServerInfo, listings, SPA, and API fallback behavior",
  "isolated target cleanup and forward-repair rehearsal",
] as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ACCOUNT = /^[0-9a-f]{32}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KV_ID = /^[0-9a-f]{32}$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAX_JSON_BYTES = 1024 * 1024;

export type JsonObject = Record<string, unknown>;

export interface HealthCheck {
  readonly name: string;
  readonly status: "passed";
  readonly bindingDigest: string;
}

export interface CandidateHealthCheck {
  readonly name: string;
  readonly bindingDigest: string;
}

export interface TargetPolicy {
  readonly configPath: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly origin: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly kvNamespaceId: string;
  readonly iconsBucketName: string;
  readonly publishCapability: boolean;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly requiredVarNames: readonly string[];
  readonly requiredSecretNames: readonly string[];
  readonly customDomainHostname: string;
  readonly readbackListingPath: string;
}

export interface StoreReleasePolicy {
  readonly kind: "takosumi.store-release-policy@v1";
  readonly surfaceId: typeof SURFACE_ID;
  readonly production: TargetPolicy;
  readonly staging: TargetPolicy;
}

export interface StoreArtifactFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface StoreArtifactManifest {
  readonly kind: "takosumi.store-release-artifact@v1";
  readonly surfaceId: typeof SURFACE_ID;
  readonly repository: typeof REPOSITORY;
  readonly sourceCommit: string;
  readonly version: typeof VERSION;
  readonly tag: typeof TAG;
  readonly builtAt: string;
  readonly worker: StoreArtifactFile;
  readonly assets: readonly StoreArtifactFile[];
  readonly migrations: readonly StoreArtifactFile[];
  readonly sbom: StoreArtifactFile;
  readonly provenance: StoreArtifactFile;
  readonly digests: {
    readonly worker: string;
    readonly assets: string;
    readonly migrations: string;
    readonly sbom: string;
    readonly provenance: string;
    readonly artifact: string;
  };
  readonly toolchain: {
    readonly bun: string;
    readonly bunExecutableDigest: string;
    readonly wrangler: string;
    readonly wranglerEntrypointDigest: string;
    readonly wranglerPackageJsonDigest: string;
    readonly nodeModulesRuntimeDigest: string;
    readonly lockfileDigest: string;
  };
}

export interface StoreReleaseCandidate extends JsonObject {
  readonly kind: "takos.direct-deployment-release-candidate@v1";
  readonly surfaceId: typeof SURFACE_ID;
  readonly repository: typeof REPOSITORY;
  readonly sourceCommit: string;
  readonly version: typeof VERSION;
  readonly builtAt: string;
  readonly artifactDigests: readonly string[];
  readonly sbomDigests: readonly string[];
  readonly provenanceDigests: readonly string[];
  readonly configDigest: string;
  readonly policyDigest: string;
  readonly toolchainDigest: string;
  readonly targetFingerprint: string;
  readonly healthChecks: readonly CandidateHealthCheck[];
  readonly staging: {
    readonly configDigest: string;
    readonly targetFingerprint: string;
    readonly healthChecks: readonly CandidateHealthCheck[];
  };
}

export interface ReleaseEnvelope extends JsonObject {
  readonly kind: "takos.release-safety-envelope@v1";
  readonly releaseId: string;
  readonly surfaceId: typeof SURFACE_ID;
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly treeDigest: string;
    readonly clean: true;
    readonly pushed: true;
  };
  readonly controllerSource: {
    readonly repository: string;
    readonly commit: string;
    readonly treeDigest: string;
    readonly clean: true;
    readonly pushed: true;
  };
  readonly authority: {
    readonly controllerDigest: string;
    readonly adapterDigest: string;
    readonly stagingAdapterDigest: string;
    readonly replicaAdapterDigest: string;
    readonly operatorPolicyDigest: string;
  } & JsonObject;
  readonly candidate: StoreReleaseCandidate & {
    readonly manifestDigest: string;
  };
  readonly staging: JsonObject;
  readonly replica: JsonObject;
  readonly promotion: {
    readonly targetFingerprint: string;
    readonly artifactDigests: readonly string[];
    readonly healthChecks: readonly CandidateHealthCheck[];
  } & JsonObject;
  readonly evidence: {
    readonly directory: string;
    readonly permissions: "0700-directory/0600-files";
  };
}

export interface WranglerRunner {
  (args: readonly string[], options: { cwd: string }): string;
  inspect?: (
    args: readonly string[],
    options: { cwd: string },
  ) => {
    readonly status: "ok" | "not-found" | "failed";
    readonly stdout: string;
  };
}

export interface CloudflareReadClient {
  readonly accountId: string;
  get(
    path: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<
    | {
        readonly status: "ok";
        readonly result: unknown;
        readonly resultInfo: unknown;
      }
    | { readonly status: "not-found" }
  >;
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

type RuntimeTreeEntry =
  | {
      readonly path: string;
      readonly kind: "file";
      readonly size: number;
      readonly mode: number;
      readonly sha256: string;
    }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly target: string;
      readonly resolvedTarget: string;
    };

/**
 * Seal the complete installed JavaScript/native runtime that Wrangler can
 * resolve. The inventory deliberately covers all of node_modules rather than
 * attempting to infer a partial import graph: optional and platform-specific
 * imports must not become an unsealed path under release credentials.
 */
export async function digestNodeModulesRuntimeTree(
  sourceCheckout: string,
): Promise<string> {
  const source = await realpath(sourceCheckout);
  const runtimeRoot = await realpath(join(source, "node_modules"));
  const runtimeRelativeToSource = relative(source, runtimeRoot);
  if (
    runtimeRelativeToSource === ".." ||
    runtimeRelativeToSource.startsWith(`..${sep}`) ||
    isAbsolute(runtimeRelativeToSource)
  ) {
    throw new Error("release_runtime_tree_outside_source");
  }
  const entries: RuntimeTreeEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = relative(runtimeRoot, path).split(sep).join("/");
      const metadata = await lstat(path);
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (metadata.isFile()) {
        entries.push({
          path: relativePath,
          kind: "file",
          size: metadata.size,
          mode: metadata.mode & 0o777,
          sha256: sha256Bytes(await readFile(path)),
        });
        continue;
      }
      if (metadata.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = await realpath(path);
        const resolvedTarget = relative(runtimeRoot, resolved)
          .split(sep)
          .join("/");
        if (
          resolvedTarget === ".." ||
          resolvedTarget.startsWith("../") ||
          isAbsolute(resolvedTarget)
        ) {
          throw new Error(
            `release_runtime_symlink_outside_tree:${relativePath}`,
          );
        }
        entries.push({
          path: relativePath,
          kind: "symlink",
          target,
          resolvedTarget,
        });
        continue;
      }
      throw new Error(`release_runtime_special_file_forbidden:${relativePath}`);
    }
  };
  await visit(runtimeRoot);
  if (entries.length === 0) throw new Error("release_runtime_tree_empty");
  return digestJson({
    kind: "takosumi.store-runtime-tree@v1",
    root: "node_modules",
    entries,
  });
}

const SVG_UNSAFE_MARKUP =
  /(?:<!|<\?|<!--[\s\S]*?-->|<(?:[A-Za-z][\w.-]*:)?(?:script|foreignObject|iframe|object|embed|style|link|image|use|audio|video|animate|set|discard|handler|listener)\b|\b(?:on[a-z]+|href|src|style)\s*=|\b(?:javascript|data):|&)/iu;

export const RELEASE_CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bsk_(?:live|test)_[A-Za-z0-9]+/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
  /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[,=:]\s*['"][^'"]{8,}/iu,
] as const;

export const RELEASE_PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}\b/iu,
  /\b(?:\d{1,3}[.]){3}\d{1,3}\b/u,
  /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}[.]eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}\b/u,
  /\b(?:cookie|set-cookie|session[_-]?(?:id|token)|csrf[_-]?token)\b\s*[,=:]\s*['"][^'"]{4,}/iu,
] as const;

function scanRepresentations(value: string | Uint8Array): readonly string[] {
  if (typeof value === "string") return [value];
  const bytes = Buffer.from(value);
  const utf16be = Buffer.alloc(bytes.byteLength - (bytes.byteLength % 2));
  for (let index = 0; index < utf16be.byteLength; index += 2) {
    utf16be[index] = bytes[index + 1]!;
    utf16be[index + 1] = bytes[index]!;
  }
  return [
    bytes.toString("utf8"),
    bytes.toString("latin1"),
    bytes.toString("utf16le"),
    utf16be.toString("utf16le"),
  ].map((text) => text.replaceAll("\0", ""));
}

/** Scan decoded image bytes and their allowed metadata fail-closed. */
export function assertNoReleaseCredentialOrPii(
  value: string | Uint8Array,
  label: string,
): void {
  const representations = scanRepresentations(value);
  if (
    representations.some((text) =>
      RELEASE_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)),
    )
  ) {
    throw new Error(`${label}_credential_literal_detected`);
  }
  if (
    representations.some((text) =>
      RELEASE_PII_PATTERNS.some((pattern) => pattern.test(text)),
    )
  ) {
    throw new Error(`${label}_pii_literal_detected`);
  }
}

/**
 * Fail-closed verification for icon bytes carried by replica bundles and live
 * canonical canary readback. The declared media type is authority only after
 * the bytes independently match it. SVG remains supported for the existing
 * catalog, but only as inert, self-contained markup with no links, CSS,
 * scripting, animation, entities, or embedded resources.
 */
export function assertIconMediaType(
  bytes: Uint8Array,
  mediaType: string,
  label: string,
): void {
  const normalizedMediaType = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedMediaType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      bytes.byteLength < signature.length ||
      signature.some((value, index) => bytes[index] !== value)
    ) {
      throw new Error(`${label}_media_type_mismatch`);
    }
    return;
  }
  if (normalizedMediaType === "image/jpeg") {
    if (
      bytes.byteLength < 5 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff ||
      bytes[bytes.byteLength - 2] !== 0xff ||
      bytes[bytes.byteLength - 1] !== 0xd9
    ) {
      throw new Error(`${label}_media_type_mismatch`);
    }
    return;
  }
  if (normalizedMediaType === "image/webp") {
    const riff = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
    const webp = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
    const declaredSize =
      bytes.byteLength >= 8
        ? new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          ).getUint32(4, true)
        : -1;
    if (
      bytes.byteLength < 12 ||
      riff !== "RIFF" ||
      webp !== "WEBP" ||
      declaredSize !== bytes.byteLength - 8
    ) {
      throw new Error(`${label}_media_type_mismatch`);
    }
    return;
  }
  if (normalizedMediaType === "image/svg+xml") {
    let markup: string;
    try {
      markup = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label}_media_type_mismatch`);
    }
    const trimmed = markup.trim();
    const paintReferences = trimmed.match(/\burl\s*\([^)]*\)/giu) ?? [];
    if (
      !/^<svg(?:\s|>)/u.test(trimmed) ||
      !/<\/svg>$/u.test(trimmed) ||
      SVG_UNSAFE_MARKUP.test(trimmed) ||
      paintReferences.some(
        (reference) => !/^url\s*\(\s*#[A-Za-z][\w.-]*\s*\)$/iu.test(reference),
      ) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(trimmed)
    ) {
      throw new Error(`${label}_unsafe_svg`);
    }
    return;
  }
  throw new Error(`${label}_media_type_unsupported`);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function digestJson(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is JsonObject {
  if (!isRecord(value)) throw new Error(`${label}_must_be_object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}_keys_invalid`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}_missing`);
  }
  return value;
}

export function safeRelativePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label}_must_be_safe_relative_path`);
  }
  return path;
}

export async function secureResolveInside(
  rootInput: string,
  relativePath: string,
): Promise<string> {
  const root = await realpath(rootInput);
  const path = await realpath(resolve(root, relativePath));
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("operator_path_escapes_root");
  }
  return path;
}

export async function readPrivateFile(
  pathInput: string,
  options: { maxBytes?: number; expectedDirectory?: string } = {},
): Promise<Buffer> {
  if (!isAbsolute(pathInput)) throw new Error("private_path_must_be_absolute");
  const link = await lstat(pathInput);
  if (link.isSymbolicLink() || !link.isFile()) {
    throw new Error("private_path_must_be_regular_file");
  }
  const path = await realpath(pathInput);
  const file = await stat(path);
  const directory = await realpath(dirname(path));
  const directoryStat = await stat(directory);
  if ((file.mode & 0o777) !== 0o600 || (directoryStat.mode & 0o777) !== 0o700) {
    throw new Error("private_path_permissions_invalid");
  }
  if (
    typeof process.getuid === "function" &&
    (file.uid !== process.getuid() || directoryStat.uid !== process.getuid())
  ) {
    throw new Error("private_path_owner_invalid");
  }
  if (options.expectedDirectory) {
    const expected = await realpath(options.expectedDirectory);
    if (directory !== expected)
      throw new Error("private_path_directory_mismatch");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > (options.maxBytes ?? MAX_JSON_BYTES)) {
    throw new Error("private_file_too_large");
  }
  return bytes;
}

export async function writePrivateJson(
  path: string,
  value: unknown,
  options: { replace?: boolean } = {},
): Promise<Buffer> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  if (options.replace) {
    const temporary = join(
      directory,
      `.${path.split("/").at(-1)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } else {
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  }
  await chmod(path, 0o600);
  return bytes;
}

export async function readPrivateJson<T>(
  path: string,
  expectedDirectory?: string,
): Promise<T> {
  const bytes = await readPrivateFile(path, { expectedDirectory });
  return JSON.parse(bytes.toString("utf8")) as T;
}

function validateTarget(value: unknown, label: string): TargetPolicy {
  exactKeys(
    value,
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
    label,
  );
  const target = value as unknown as TargetPolicy;
  safeRelativePath(target.configPath, `${label}_config_path`);
  if (!ACCOUNT.test(target.accountId))
    throw new Error(`${label}_account_invalid`);
  if (!SAFE_NAME.test(target.workerName))
    throw new Error(`${label}_worker_invalid`);
  if (!SAFE_NAME.test(target.databaseName))
    throw new Error(`${label}_database_invalid`);
  if (!UUID.test(target.databaseId))
    throw new Error(`${label}_database_id_invalid`);
  if (!KV_ID.test(target.kvNamespaceId))
    throw new Error(`${label}_kv_id_invalid`);
  if (!SAFE_NAME.test(target.iconsBucketName))
    throw new Error(`${label}_bucket_invalid`);
  if (typeof target.publishCapability !== "boolean") {
    throw new Error(`${label}_publish_capability_invalid`);
  }
  if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/u.test(target.compatibilityDate)) {
    throw new Error(`${label}_compatibility_date_invalid`);
  }
  for (const [field, values] of [
    ["compatibility_flags", target.compatibilityFlags],
    ["required_var_names", target.requiredVarNames],
    ["required_secret_names", target.requiredSecretNames],
  ] as const) {
    if (
      !Array.isArray(values) ||
      values.some(
        (entry) =>
          typeof entry !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(entry),
      ) ||
      new Set(values).size !== values.length ||
      JSON.stringify(values) !== JSON.stringify([...values].sort())
    ) {
      throw new Error(`${label}_${field}_invalid`);
    }
  }
  if (
    !/^\/tcs\/v1\/listings\/[a-z0-9-]+\/[a-z0-9-]+$/u.test(
      target.readbackListingPath,
    )
  ) {
    throw new Error(`${label}_listing_path_invalid`);
  }
  const origin = new URL(target.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(`${label}_origin_invalid`);
  }
  if (origin.hostname !== target.customDomainHostname) {
    throw new Error(`${label}_custom_domain_mismatch`);
  }
  return target;
}

export function validatePolicy(value: unknown): StoreReleasePolicy {
  exactKeys(value, ["kind", "surfaceId", "production", "staging"], "policy");
  if (value.kind !== "takosumi.store-release-policy@v1") {
    throw new Error("policy_kind_invalid");
  }
  if (value.surfaceId !== SURFACE_ID) throw new Error("policy_surface_invalid");
  const production = validateTarget(value.production, "production");
  const staging = validateTarget(value.staging, "staging");
  if (
    production.origin.replace(/\/$/u, "") !== "https://store.takosumi.com" ||
    production.customDomainHostname !== "store.takosumi.com" ||
    production.workerName !== "takosumi-store"
  ) {
    throw new Error("official_production_target_identity_invalid");
  }
  if (
    production.readbackListingPath !== "/tcs/v1/listings/tako/takos" ||
    staging.readbackListingPath !== "/tcs/v1/listings/tako/takos"
  ) {
    throw new Error("canonical_listing_canary_path_invalid");
  }
  if (
    production.accountId === staging.accountId &&
    (production.workerName === staging.workerName ||
      production.databaseId === staging.databaseId ||
      production.kvNamespaceId === staging.kvNamespaceId ||
      production.iconsBucketName === staging.iconsBucketName)
  ) {
    throw new Error("staging_target_overlaps_production");
  }
  if (production.origin === staging.origin) {
    throw new Error("staging_origin_overlaps_production");
  }
  return { ...value, production, staging } as StoreReleasePolicy;
}

export async function readPolicy(operatorRoot: string): Promise<{
  readonly path: string;
  readonly bytes: Buffer;
  readonly digest: string;
  readonly policy: StoreReleasePolicy;
}> {
  if (!isAbsolute(operatorRoot))
    throw new Error("operator_root_must_be_absolute");
  const path = await secureResolveInside(
    operatorRoot,
    "store/release-policy.production.json",
  );
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("policy_too_large");
  return {
    path,
    bytes,
    digest: sha256Bytes(bytes),
    policy: validatePolicy(JSON.parse(bytes.toString("utf8"))),
  };
}

function tomlTable(value: unknown, name: string): JsonObject[] {
  const entry = (value as JsonObject)[name];
  if (!Array.isArray(entry) || entry.length !== 1 || !isRecord(entry[0])) {
    throw new Error(`config_${name}_must_have_one_entry`);
  }
  return entry as JsonObject[];
}

export function validateRealizedConfig(
  bytes: Uint8Array,
  target: TargetPolicy,
): JsonObject {
  const config = Bun.TOML.parse(
    Buffer.from(bytes).toString("utf8"),
  ) as JsonObject;
  exactKeys(
    config,
    [
      "name",
      "main",
      "compatibility_date",
      "compatibility_flags",
      "vars",
      "d1_databases",
      "r2_buckets",
      "kv_namespaces",
      "assets",
      "routes",
    ],
    "config",
  );
  if (config.name !== target.workerName)
    throw new Error("config_worker_name_mismatch");
  if (config.main !== "src/backend/index.ts") {
    throw new Error("config_worker_entrypoint_mismatch");
  }
  if (
    config.compatibility_date !== target.compatibilityDate ||
    canonicalJson(config.compatibility_flags ?? []) !==
      canonicalJson(target.compatibilityFlags)
  ) {
    throw new Error("config_runtime_compatibility_mismatch");
  }
  const vars = isRecord(config.vars) ? config.vars : {};
  if (
    JSON.stringify(Object.keys(vars).sort()) !==
    JSON.stringify([...target.requiredVarNames].sort())
  ) {
    throw new Error("config_var_name_set_mismatch");
  }
  if (Object.values(vars).some((value) => typeof value !== "string")) {
    throw new Error("config_var_value_invalid");
  }
  if (vars.APP_URL !== target.origin.replace(/\/$/u, "")) {
    throw new Error("config_app_url_mismatch");
  }
  const db = tomlTable(config, "d1_databases")[0]!;
  exactKeys(
    db,
    ["binding", "database_name", "database_id", "migrations_dir"],
    "config_d1_binding",
  );
  if (
    db.binding !== "DB" ||
    db.database_name !== target.databaseName ||
    db.database_id !== target.databaseId ||
    db.migrations_dir !== "migrations"
  ) {
    throw new Error("config_d1_binding_mismatch");
  }
  const kv = tomlTable(config, "kv_namespaces")[0]!;
  exactKeys(kv, ["binding", "id"], "config_kv_binding");
  if (kv.binding !== "KV" || kv.id !== target.kvNamespaceId) {
    throw new Error("config_kv_binding_mismatch");
  }
  const r2 = tomlTable(config, "r2_buckets")[0]!;
  exactKeys(r2, ["binding", "bucket_name"], "config_icons_binding");
  if (r2.binding !== "ICONS" || r2.bucket_name !== target.iconsBucketName) {
    throw new Error("config_icons_binding_mismatch");
  }
  const assets = isRecord(config.assets) ? config.assets : {};
  exactKeys(
    assets,
    ["directory", "binding", "run_worker_first", "not_found_handling"],
    "config_assets",
  );
  if (
    assets.binding !== "ASSETS" ||
    assets.run_worker_first !== true ||
    assets.not_found_handling !== "single-page-application"
  ) {
    throw new Error("config_assets_binding_mismatch");
  }
  if (assets.directory !== "./dist") {
    throw new Error("config_assets_directory_invalid");
  }
  const routes = config.routes;
  if (!Array.isArray(routes) || routes.length !== 1 || !isRecord(routes[0])) {
    throw new Error("config_custom_domain_route_missing");
  }
  exactKeys(routes[0], ["pattern", "custom_domain"], "config_route");
  if (
    routes[0].custom_domain !== true ||
    routes[0].pattern !== target.customDomainHostname
  ) {
    throw new Error("config_custom_domain_route_mismatch");
  }
  return config;
}

export function targetFingerprint(
  target: TargetPolicy,
  configDigest: string,
  policyDigest: string,
): string {
  return digestJson({
    surfaceId: SURFACE_ID,
    accountId: target.accountId,
    workerName: target.workerName,
    origin: target.origin.replace(/\/$/u, ""),
    databaseName: target.databaseName,
    databaseId: target.databaseId,
    kvNamespaceId: target.kvNamespaceId,
    iconsBucketName: target.iconsBucketName,
    configDigest,
    policyDigest,
  });
}

export function candidateHealthChecks(
  names: readonly string[],
  target: TargetPolicy,
  artifactDigests: readonly string[],
  configDigest: string,
): CandidateHealthCheck[] {
  return names.map((name) => ({
    name,
    bindingDigest: digestJson({
      name,
      surfaceId: SURFACE_ID,
      version: VERSION,
      origin: target.origin.replace(/\/$/u, ""),
      workerName: target.workerName,
      databaseId: target.databaseId,
      kvNamespaceId: target.kvNamespaceId,
      iconsBucketName: target.iconsBucketName,
      compatibilityDate: target.compatibilityDate,
      compatibilityFlags: target.compatibilityFlags,
      requiredVarNames: target.requiredVarNames,
      requiredSecretNames: target.requiredSecretNames,
      customDomainHostname: target.customDomainHostname,
      readbackListingPath: target.readbackListingPath,
      artifactDigests,
      configDigest,
    }),
  }));
}

export function validateEnvelope(value: unknown): ReleaseEnvelope {
  if (!isRecord(value)) throw new Error("release_envelope_invalid");
  const envelope = value as unknown as ReleaseEnvelope;
  if (
    envelope.kind !== "takos.release-safety-envelope@v1" ||
    envelope.surfaceId !== SURFACE_ID ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(envelope.releaseId ?? "") ||
    envelope.source?.repository !== REPOSITORY ||
    !COMMIT.test(envelope.source?.commit ?? "") ||
    envelope.source?.clean !== true ||
    envelope.source?.pushed !== true ||
    envelope.candidate?.kind !==
      "takos.direct-deployment-release-candidate@v1" ||
    envelope.candidate?.surfaceId !== SURFACE_ID ||
    envelope.candidate?.repository !== REPOSITORY ||
    envelope.candidate?.sourceCommit !== envelope.source.commit ||
    envelope.candidate?.version !== VERSION ||
    envelope.evidence?.permissions !== "0700-directory/0600-files" ||
    !isAbsolute(envelope.evidence?.directory ?? "")
  ) {
    throw new Error("release_envelope_authority_invalid");
  }
  for (const digest of [
    envelope.authority?.controllerDigest,
    envelope.authority?.adapterDigest,
    envelope.authority?.stagingAdapterDigest,
    envelope.authority?.replicaAdapterDigest,
    envelope.authority?.operatorPolicyDigest,
    envelope.candidate?.manifestDigest,
    envelope.candidate?.configDigest,
    envelope.candidate?.policyDigest,
    envelope.candidate?.toolchainDigest,
    envelope.candidate?.targetFingerprint,
  ]) {
    if (!SHA256.test(digest ?? ""))
      throw new Error("release_envelope_digest_invalid");
  }
  if (
    JSON.stringify(envelope.promotion?.artifactDigests) !==
      JSON.stringify(envelope.candidate.artifactDigests) ||
    envelope.promotion?.targetFingerprint !==
      envelope.candidate.targetFingerprint
  ) {
    throw new Error("release_envelope_promotion_mismatch");
  }
  return envelope;
}

export async function verifySourceAuthority(
  sourceCheckout: string,
  envelope: ReleaseEnvelope,
): Promise<void> {
  const source = await realpath(sourceCheckout);
  const git = (...args: string[]): string => {
    const result = spawnSync("/usr/bin/git", ["-C", source, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) throw new Error("source_git_verification_failed");
    return result.stdout.trim();
  };
  if (
    git("remote", "get-url", "origin") !== REPOSITORY ||
    git("rev-parse", "HEAD") !== envelope.source.commit ||
    git("status", "--porcelain=v1", "--untracked-files=all") !== ""
  ) {
    throw new Error("source_checkout_authority_mismatch");
  }
  const tree = spawnSync(
    "/usr/bin/git",
    ["-C", source, "ls-tree", "-r", "--full-tree", "HEAD"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (tree.status !== 0) throw new Error("source_tree_digest_failed");
  const treeDigest = sha256Bytes(tree.stdout);
  if (treeDigest !== envelope.source.treeDigest) {
    throw new Error("source_tree_digest_mismatch");
  }
  if (
    git("cat-file", "-t", `refs/tags/${TAG}`) !== "tag" ||
    git("rev-parse", `refs/tags/${TAG}^{}`) !== envelope.source.commit
  ) {
    throw new Error("signed_annotated_tag_authority_mismatch");
  }
  const verification = spawnSync(
    "/usr/bin/git",
    ["-C", source, "verify-tag", TAG],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  if (verification.status !== 0)
    throw new Error("release_tag_signature_invalid");
  const remote = spawnSync(
    "/usr/bin/git",
    [
      "-C",
      source,
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${TAG}`,
      `refs/tags/${TAG}^{}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (
    remote.status !== 0 ||
    !remote.stdout.includes(`${envelope.source.commit}\trefs/tags/${TAG}^{}`)
  ) {
    throw new Error("release_tag_not_pushed");
  }
}

export async function digestFile(
  path: string,
  manifestPath: string,
): Promise<StoreArtifactFile> {
  const bytes = await readFile(path);
  return {
    path: manifestPath,
    size: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  };
}

export async function walkFiles(
  root: string,
  prefix = "",
): Promise<StoreArtifactFile[]> {
  const output: StoreArtifactFile[] = [];
  async function walk(directory: string, childPrefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("artifact_symlink_forbidden");
      const absolute = join(directory, entry.name);
      const next = childPrefix ? `${childPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, next);
      else if (entry.isFile())
        output.push(await digestFile(absolute, `${prefix}${next}`));
      else throw new Error("artifact_special_file_forbidden");
    }
  }
  await walk(root, "");
  return output;
}

export function artifactSetDigest(files: readonly StoreArtifactFile[]): string {
  return digestJson(
    files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  );
}

export function validateArtifactManifest(
  value: unknown,
): StoreArtifactManifest {
  exactKeys(
    value,
    [
      "kind",
      "surfaceId",
      "repository",
      "sourceCommit",
      "version",
      "tag",
      "builtAt",
      "worker",
      "assets",
      "migrations",
      "sbom",
      "provenance",
      "digests",
      "toolchain",
    ],
    "artifact_manifest",
  );
  const manifest = value as unknown as StoreArtifactManifest;
  if (
    manifest.kind !== "takosumi.store-release-artifact@v1" ||
    manifest.surfaceId !== SURFACE_ID ||
    manifest.repository !== REPOSITORY ||
    !COMMIT.test(manifest.sourceCommit ?? "") ||
    manifest.version !== VERSION ||
    manifest.tag !== TAG ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length === 0 ||
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.length !== 6
  ) {
    throw new Error("artifact_manifest_authority_invalid");
  }
  const validateFile = (entry: unknown, label: string): StoreArtifactFile => {
    exactKeys(entry, ["path", "size", "sha256"], label);
    const record = entry as unknown as StoreArtifactFile;
    if (
      typeof record.path !== "string" ||
      isAbsolute(record.path) ||
      record.path.includes("\\") ||
      record.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      !SHA256.test(record.sha256)
    ) {
      throw new Error(`${label}_invalid`);
    }
    return record;
  };
  validateFile(manifest.worker, "artifact_worker");
  validateFile(manifest.sbom, "artifact_sbom");
  validateFile(manifest.provenance, "artifact_provenance");
  manifest.assets.forEach((entry, index) =>
    validateFile(entry, `artifact_asset_${index}`),
  );
  manifest.migrations.forEach((entry, index) =>
    validateFile(entry, `artifact_migration_${index}`),
  );
  if (
    manifest.worker.path !== "worker/worker.mjs" ||
    manifest.sbom.path !== "sbom.cdx.json" ||
    manifest.provenance.path !== "provenance.intoto.jsonl" ||
    manifest.assets.some((entry) => !entry.path.startsWith("assets/")) ||
    canonicalJson(manifest.assets.map((entry) => entry.path)) !==
      canonicalJson(manifest.assets.map((entry) => entry.path).sort()) ||
    canonicalJson(manifest.migrations.map((entry) => entry.path)) !==
      canonicalJson([
        "migrations/0001_init.sql",
        "migrations/0002_accounts.sql",
        "migrations/0003_scope_slug.sql",
        "migrations/0004_tags.sql",
        "migrations/0005_install_experience.sql",
        "migrations/0006_source_identity.sql",
      ])
  ) {
    throw new Error("artifact_manifest_inventory_invalid");
  }
  const allPaths = [
    manifest.worker.path,
    ...manifest.assets.map((entry) => entry.path),
    ...manifest.migrations.map((entry) => entry.path),
    manifest.sbom.path,
    manifest.provenance.path,
  ];
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error("artifact_manifest_duplicate_path");
  }
  exactKeys(
    manifest.digests,
    ["worker", "assets", "migrations", "sbom", "provenance", "artifact"],
    "artifact_manifest_digests",
  );
  for (const digest of Object.values(manifest.digests)) {
    if (!SHA256.test(digest))
      throw new Error("artifact_manifest_digest_invalid");
  }
  exactKeys(
    manifest.toolchain,
    [
      "bun",
      "bunExecutableDigest",
      "wrangler",
      "wranglerEntrypointDigest",
      "wranglerPackageJsonDigest",
      "nodeModulesRuntimeDigest",
      "lockfileDigest",
    ],
    "artifact_manifest_toolchain",
  );
  if (
    !/^\d+[.]\d+[.]\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(manifest.toolchain.bun) ||
    !/^\d+[.]\d+[.]\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(
      manifest.toolchain.wrangler,
    ) ||
    [
      manifest.toolchain.bunExecutableDigest,
      manifest.toolchain.wranglerEntrypointDigest,
      manifest.toolchain.wranglerPackageJsonDigest,
      manifest.toolchain.nodeModulesRuntimeDigest,
      manifest.toolchain.lockfileDigest,
    ].some((digest) => !SHA256.test(digest))
  ) {
    throw new Error("artifact_manifest_toolchain_invalid");
  }
  return manifest;
}

export async function verifyArtifact(
  evidenceDirectory: string,
  envelope: ReleaseEnvelope,
): Promise<{
  readonly root: string;
  readonly manifest: StoreArtifactManifest;
  readonly manifestDigest: string;
}> {
  const candidatePath = await secureResolveInside(
    evidenceDirectory,
    CANDIDATE_FILE,
  );
  const candidateBytes = await readPrivateFile(candidatePath, {
    expectedDirectory: evidenceDirectory,
  });
  if (sha256Bytes(candidateBytes) !== envelope.candidate.manifestDigest) {
    throw new Error("candidate_manifest_digest_mismatch");
  }
  const retainedCandidate = JSON.parse(
    candidateBytes.toString("utf8"),
  ) as JsonObject;
  const envelopeCandidate = { ...envelope.candidate } as JsonObject;
  delete envelopeCandidate.manifestDigest;
  if (canonicalJson(retainedCandidate) !== canonicalJson(envelopeCandidate)) {
    throw new Error("candidate_manifest_envelope_mismatch");
  }
  const root = await secureResolveInside(evidenceDirectory, ARTIFACT_DIRECTORY);
  const manifestPath = await secureResolveInside(root, ARTIFACT_MANIFEST_FILE);
  const bytes = await readPrivateFile(manifestPath, {
    expectedDirectory: root,
  });
  const manifestDigest = sha256Bytes(bytes);
  const manifest = validateArtifactManifest(JSON.parse(bytes.toString("utf8")));
  if (
    manifest.sourceCommit !== envelope.source.commit ||
    JSON.stringify([
      manifest.digests.worker,
      manifest.digests.assets,
      manifest.digests.migrations,
    ]) !== JSON.stringify(envelope.candidate.artifactDigests) ||
    JSON.stringify([manifest.digests.sbom]) !==
      JSON.stringify(envelope.candidate.sbomDigests) ||
    JSON.stringify([manifest.digests.provenance]) !==
      JSON.stringify(envelope.candidate.provenanceDigests)
  ) {
    throw new Error("artifact_manifest_envelope_mismatch");
  }
  const records = {
    worker: manifest.worker,
    assets: manifest.assets,
    migrations: manifest.migrations,
    sbom: manifest.sbom,
    provenance: manifest.provenance,
  };
  const flattened = [
    records.worker,
    ...records.assets,
    ...records.migrations,
    records.sbom,
    records.provenance,
  ];
  const expectedInventory = [
    ARTIFACT_MANIFEST_FILE,
    ...flattened.map((record) => record.path),
  ].sort();
  const actualInventory = (await walkFiles(root)).map((record) => record.path);
  if (canonicalJson(actualInventory) !== canonicalJson(expectedInventory)) {
    throw new Error("artifact_filesystem_inventory_mismatch");
  }
  const actualRecords = new Map<string, StoreArtifactFile>();
  for (const record of flattened) {
    const path = await secureResolveInside(root, record.path);
    const actual = await digestFile(path, record.path);
    if (actual.size !== record.size || actual.sha256 !== record.sha256) {
      throw new Error(`artifact_file_digest_mismatch:${record.path}`);
    }
    actualRecords.set(record.path, actual);
  }
  const computed = {
    worker: actualRecords.get(manifest.worker.path)!,
    assets: manifest.assets.map((entry) => actualRecords.get(entry.path)!),
    migrations: manifest.migrations.map(
      (entry) => actualRecords.get(entry.path)!,
    ),
    sbom: actualRecords.get(manifest.sbom.path)!,
    provenance: actualRecords.get(manifest.provenance.path)!,
  };
  const computedDigests = {
    worker: computed.worker.sha256,
    assets: artifactSetDigest(computed.assets),
    migrations: artifactSetDigest(computed.migrations),
    sbom: computed.sbom.sha256,
    provenance: computed.provenance.sha256,
    artifact: digestJson(computed),
  };
  if (canonicalJson(computedDigests) !== canonicalJson(manifest.digests)) {
    throw new Error("artifact_component_digest_mismatch");
  }
  return { root, manifest, manifestDigest };
}

export async function verifyActualToolchain(
  sourceCheckout: string,
  manifest: StoreArtifactManifest,
): Promise<{ readonly wranglerEntrypoint: string }> {
  const source = await realpath(sourceCheckout);
  const bunVersion = spawnSync(process.execPath, ["--version"], {
    cwd: source,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    bunVersion.status !== 0 ||
    bunVersion.stdout.trim() !== manifest.toolchain.bun ||
    sha256Bytes(await readFile(process.execPath)) !==
      manifest.toolchain.bunExecutableDigest ||
    sha256Bytes(await readFile(join(source, "bun.lock"))) !==
      manifest.toolchain.lockfileDigest
  ) {
    throw new Error("release_bun_toolchain_mismatch");
  }
  const wranglerEntrypoint = await realpath(
    join(source, "node_modules/wrangler/wrangler-dist/cli.js"),
  );
  const wranglerPackageJson = await realpath(
    join(source, "node_modules/wrangler/package.json"),
  );
  const runtimeDigestBefore = await digestNodeModulesRuntimeTree(source);
  const packageValue = JSON.parse(
    await readFile(wranglerPackageJson, "utf8"),
  ) as { version?: unknown };
  if (
    runtimeDigestBefore !== manifest.toolchain.nodeModulesRuntimeDigest ||
    sha256Bytes(await readFile(wranglerEntrypoint)) !==
      manifest.toolchain.wranglerEntrypointDigest ||
    sha256Bytes(await readFile(wranglerPackageJson)) !==
      manifest.toolchain.wranglerPackageJsonDigest
  ) {
    throw new Error("release_wrangler_runtime_tree_mismatch");
  }
  if (packageValue.version !== manifest.toolchain.wrangler) {
    throw new Error("release_wrangler_package_version_mismatch");
  }
  const wranglerVersion = spawnSync(
    process.execPath,
    [wranglerEntrypoint, "--version"],
    {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    wranglerVersion.status !== 0 ||
    wranglerVersion.stdout.trim() !== manifest.toolchain.wrangler
  ) {
    throw new Error("release_wrangler_toolchain_mismatch");
  }
  if (
    (await digestNodeModulesRuntimeTree(source)) !==
    manifest.toolchain.nodeModulesRuntimeDigest
  ) {
    throw new Error("release_wrangler_runtime_mutated_during_verification");
  }
  return { wranglerEntrypoint };
}

export async function readCredentialFiles(
  accountEnvironment: string,
  tokenEnvironment: string,
  expectedAccountId: string,
): Promise<{ readonly accountId: string; readonly apiToken: string }> {
  for (const raw of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    if (process.env[raw]) throw new Error(`raw_credential_forbidden:${raw}`);
  }
  const accountPath = process.env[accountEnvironment];
  const tokenPath = process.env[tokenEnvironment];
  if (!accountPath || !tokenPath)
    throw new Error("credential_file_reference_missing");
  const accountId = (await readPrivateFile(accountPath, { maxBytes: 128 }))
    .toString("utf8")
    .trim();
  const apiToken = (await readPrivateFile(tokenPath, { maxBytes: 4096 }))
    .toString("utf8")
    .trim();
  if (
    accountId !== expectedAccountId ||
    !ACCOUNT.test(accountId) ||
    apiToken.length < 20
  ) {
    throw new Error("credential_file_value_invalid");
  }
  return { accountId, apiToken };
}

export function createWranglerRunner(options: {
  readonly wranglerEntrypoint: string;
  readonly accountId: string;
  readonly apiToken: string;
}): WranglerRunner {
  const execute = (args: readonly string[], invocation: { cwd: string }) =>
    spawnSync(process.execPath, [options.wranglerEntrypoint, ...args], {
      cwd: invocation.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      env: {
        HOME: process.env.HOME ?? "/nonexistent",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        CI: "true",
        CLOUDFLARE_ACCOUNT_ID: options.accountId,
        CLOUDFLARE_API_TOKEN: options.apiToken,
        WRANGLER_SEND_METRICS: "false",
      },
    });
  const runner: WranglerRunner = (args, invocation) => {
    const result = execute(args, invocation);
    if (result.status !== 0) throw new Error("wrangler_operation_failed");
    return result.stdout;
  };
  runner.inspect = (args, invocation) => {
    const result = execute(args, invocation);
    if (result.status === 0) return { status: "ok", stdout: result.stdout };
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    if (
      /(?:\b404\b|not[ -]?found|does not exist|no deployments|no such)/iu.test(
        diagnostic,
      )
    ) {
      return { status: "not-found", stdout: "" };
    }
    return { status: "failed", stdout: "" };
  };
  return runner;
}

export function createCloudflareReadClient(options: {
  readonly accountId: string;
  readonly apiToken: string;
}): CloudflareReadClient {
  return {
    accountId: options.accountId,
    async get(path, query = {}) {
      if (!path.startsWith("/") || path.includes("..")) {
        throw new Error("cloudflare_read_path_invalid");
      }
      const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, value);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${options.apiToken}`,
          },
        });
        if (response.status === 404) return { status: "not-found" as const };
        if (response.status !== 200) {
          throw new Error(`cloudflare_read_http_${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 4 * 1024 * 1024) {
          throw new Error("cloudflare_read_response_too_large");
        }
        const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
        if (
          !isRecord(value) ||
          value.success !== true ||
          !("result" in value)
        ) {
          throw new Error("cloudflare_read_response_invalid");
        }
        return {
          status: "ok" as const,
          result: value.result,
          resultInfo: value.result_info ?? null,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export async function readRuntimeTopology(
  client: CloudflareReadClient,
  target: TargetPolicy,
  mode: "custom-domain" | "workers-dev",
): Promise<JsonObject> {
  const account = encodeURIComponent(target.accountId);
  if (client.accountId !== target.accountId) {
    throw new Error("runtime_topology_account_mismatch");
  }
  if (mode === "custom-domain") {
    const response = await client.get(`/accounts/${account}/workers/domains`, {
      hostname: target.customDomainHostname,
    });
    if (response.status !== "ok" || !Array.isArray(response.result)) {
      throw new Error("runtime_custom_domain_readback_missing");
    }
    const matches = response.result.filter(
      (entry) =>
        isRecord(entry) && entry.hostname === target.customDomainHostname,
    );
    if (matches.length !== 1 || !isRecord(matches[0])) {
      throw new Error("runtime_custom_domain_readback_ambiguous");
    }
    const domain = matches[0];
    if (
      domain.service !== target.workerName ||
      (domain.environment !== undefined && domain.environment !== "production")
    ) {
      throw new Error("runtime_custom_domain_owner_mismatch");
    }
    return {
      mode,
      hostname: target.customDomainHostname,
      workerName: target.workerName,
      domainId: String(domain.id ?? ""),
      zoneId: String(domain.zone_id ?? ""),
      environment: String(domain.environment ?? "production"),
    };
  }
  const accountSubdomain = await client.get(
    `/accounts/${account}/workers/subdomain`,
  );
  const scriptSubdomain = await client.get(
    `/accounts/${account}/workers/scripts/${encodeURIComponent(target.workerName)}/subdomain`,
  );
  if (
    accountSubdomain.status !== "ok" ||
    !isRecord(accountSubdomain.result) ||
    typeof accountSubdomain.result.subdomain !== "string" ||
    scriptSubdomain.status !== "ok" ||
    !isRecord(scriptSubdomain.result) ||
    scriptSubdomain.result.enabled !== true ||
    scriptSubdomain.result.previews_enabled !== false
  ) {
    throw new Error("runtime_workers_dev_readback_mismatch");
  }
  const hostname = `${target.workerName}.${accountSubdomain.result.subdomain}.workers.dev`;
  if (target.origin !== `https://${hostname}`) {
    throw new Error("runtime_workers_dev_origin_mismatch");
  }
  return {
    mode,
    hostname,
    workerName: target.workerName,
    enabled: true,
    previewsEnabled: false,
  };
}

export function parseJsonOutput(output: string, label: string): unknown {
  const lines = output.split(/\r?\n/u);
  const candidates = [output.trim()];
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^[\s]*[\[{]/u.test(lines[start] ?? "")) continue;
    for (let end = lines.length; end > start; end -= 1) {
      candidates.push(lines.slice(start, end).join("\n").trim());
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue to the preceding bounded candidate.
    }
  }
  throw new Error(`${label}_json_missing`);
}

export function parseVersionId(output: string): string {
  const match = output.match(
    /(?:Version ID|version_id)["':\s]+([0-9a-f-]{36})/iu,
  );
  if (!match || !UUID.test(match[1]!))
    throw new Error("worker_version_id_missing");
  return match[1]!.toLowerCase();
}

export function assertVersionBindings(
  version: unknown,
  versionId: string,
  target: TargetPolicy,
): void {
  const versionRecord = isRecord(version) ? version : {};
  if (versionRecord.id !== versionId) {
    throw new Error(`worker_version_binding_mismatch:${versionId}`);
  }
  const resources = isRecord(versionRecord.resources)
    ? versionRecord.resources
    : {};
  if (!Array.isArray(resources.bindings)) {
    throw new Error("worker_version_bindings_missing");
  }
  const allowed = new Map<string, Set<string>>([
    ["DB", new Set(["d1"])],
    ["KV", new Set(["kv_namespace"])],
    ["ICONS", new Set(["r2_bucket"])],
    ["ASSETS", new Set(["assets"])],
    ...target.requiredVarNames.map(
      (name) => [name, new Set(["plain_text", "json"])] as const,
    ),
    ...target.requiredSecretNames.map(
      (name) => [name, new Set(["secret_text", "secret_key"])] as const,
    ),
  ]);
  const seen = new Set<string>();
  for (const raw of resources.bindings) {
    if (
      !isRecord(raw) ||
      typeof raw.name !== "string" ||
      typeof raw.type !== "string"
    ) {
      throw new Error("worker_version_binding_shape_invalid");
    }
    const types = allowed.get(raw.name);
    if (!types?.has(raw.type) || seen.has(raw.name)) {
      throw new Error(`worker_version_binding_set_mismatch:${raw.name}`);
    }
    if (raw.name === "DB") {
      const ids = [raw.database_id, raw.id].filter(
        (value): value is string => typeof value === "string",
      );
      if (
        ids.length === 0 ||
        ids.some((id) => id !== target.databaseId) ||
        (raw.database_name !== undefined &&
          raw.database_name !== target.databaseName)
      ) {
        throw new Error("worker_version_binding_identity_mismatch:DB");
      }
    } else if (raw.name === "KV") {
      const ids = [raw.namespace_id, raw.id].filter(
        (value): value is string => typeof value === "string",
      );
      if (ids.length === 0 || ids.some((id) => id !== target.kvNamespaceId)) {
        throw new Error("worker_version_binding_identity_mismatch:KV");
      }
    } else if (
      raw.name === "ICONS" &&
      raw.bucket_name !== target.iconsBucketName
    ) {
      throw new Error("worker_version_binding_identity_mismatch:ICONS");
    }
    seen.add(raw.name);
  }
  if (
    JSON.stringify([...seen].sort()) !==
    JSON.stringify([...allowed.keys()].sort())
  ) {
    throw new Error("worker_version_binding_set_incomplete");
  }
}

export function deploymentHasExactVersionAtFullTraffic(
  value: unknown,
  versionId: string,
): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.versions) || value.versions.length !== 1) {
    return false;
  }
  const current = value.versions[0];
  return (
    isRecord(current) &&
    current.version_id === versionId &&
    current.percentage === 100
  );
}

async function fetchBytes(
  url: string,
  init: Pick<RequestInit, "method" | "headers"> = {},
): Promise<{ response: Response; bytes: Uint8Array }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw new Error(`health_http_${response.status}`);
    return { response, bytes };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchExpectedStatus(
  url: string,
  status: number,
  init: Pick<RequestInit, "method" | "headers"> = {},
): Promise<{ response: Response; bytes: Uint8Array }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status !== status)
      throw new Error(`health_http_${response.status}`);
    return { response, bytes };
  } finally {
    clearTimeout(timeout);
  }
}

function exactJson(bytes: Uint8Array, expected: unknown, label: string): void {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (canonicalJson(parsed) !== canonicalJson(expected))
    throw new Error(`${label}_mismatch`);
}

export async function runLiveChecks(options: {
  readonly target: TargetPolicy;
  readonly manifest: StoreArtifactManifest;
  readonly artifactRoot: string;
  readonly candidateChecks: readonly CandidateHealthCheck[];
}): Promise<HealthCheck[]> {
  const origin = options.target.origin.replace(/\/$/u, "");
  const health = await fetchBytes(`${origin}/healthz`);
  exactJson(
    health.bytes,
    { status: "ok", software: "takosumi-store", version: VERSION },
    "healthz",
  );
  const ready = await fetchBytes(`${origin}/readyz`);
  exactJson(
    ready.bytes,
    {
      status: "ready",
      capabilities: { publish: options.target.publishCapability },
    },
    "readyz",
  );
  const tcs = JSON.parse(
    Buffer.from((await fetchBytes(`${origin}/.well-known/tcs`)).bytes).toString(
      "utf8",
    ),
  ) as JsonObject;
  const server = isRecord(tcs.server) ? tcs.server : {};
  const software = isRecord(server.software) ? server.software : {};
  if (
    software.name !== "takosumi-store" ||
    software.version !== VERSION ||
    server.baseUrl !== origin
  ) {
    throw new Error("tcs_server_info_mismatch");
  }
  const corsOrigin = "https://release-safety.invalid";
  const listingResponse = await fetchBytes(
    `${origin}${options.target.readbackListingPath}`,
    { headers: { accept: "application/json", origin: corsOrigin } },
  );
  if (
    listingResponse.response.headers.get("access-control-allow-origin") !== "*"
  ) {
    throw new Error("canonical_listing_cors_get_mismatch");
  }
  const listingPreflight = await fetchExpectedStatus(
    `${origin}${options.target.readbackListingPath}`,
    204,
    {
      method: "OPTIONS",
      headers: {
        origin: corsOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "accept",
      },
    },
  );
  if (
    listingPreflight.response.headers.get("access-control-allow-origin") !==
      "*" ||
    listingPreflight.response.headers.get("access-control-allow-methods") !==
      "GET, OPTIONS"
  ) {
    throw new Error("canonical_listing_cors_preflight_mismatch");
  }
  const listing = JSON.parse(
    Buffer.from(listingResponse.bytes).toString("utf8"),
  ) as JsonObject;
  const listingIdentity = options.target.readbackListingPath
    .split("/")
    .slice(-2)
    .join("/");
  if (
    listing.id !== listingIdentity ||
    listing.scope !== listingIdentity.split("/")[0] ||
    listing.slug !== listingIdentity.split("/")[1] ||
    !isRecord(listing.source) ||
    listing.source.git !== CANONICAL_CANARY_SOURCE_GIT
  ) {
    throw new Error("canonical_listing_semantics_mismatch");
  }
  const sourceUrl = new URL(listing.source.git);
  if (
    sourceUrl.protocol !== "https:" ||
    sourceUrl.username ||
    sourceUrl.password
  ) {
    throw new Error("canonical_listing_source_invalid");
  }
  if (typeof listing.iconUrl !== "string")
    throw new Error("canonical_listing_icon_missing");
  const iconUrl = new URL(listing.iconUrl);
  if (
    iconUrl.origin !== origin ||
    iconUrl.username ||
    iconUrl.password ||
    !/^\/icons\/[0-9a-f]{64}$/u.test(iconUrl.pathname) ||
    iconUrl.search ||
    iconUrl.hash
  ) {
    throw new Error("canonical_listing_icon_url_invalid");
  }
  const icon = await fetchBytes(iconUrl.href);
  const iconMediaType = icon.response.headers.get("content-type") ?? "";
  const expectedIconDigest = `sha256:${iconUrl.pathname.slice("/icons/".length)}`;
  if (
    icon.bytes.byteLength === 0 ||
    icon.bytes.byteLength > 1024 * 1024 ||
    sha256Bytes(icon.bytes) !== expectedIconDigest
  ) {
    throw new Error("canonical_listing_icon_readback_invalid");
  }
  assertIconMediaType(
    icon.bytes,
    iconMediaType,
    "canonical_listing_icon_readback",
  );
  assertNoReleaseCredentialOrPii(icon.bytes, "canonical_listing_icon_readback");
  assertNoReleaseCredentialOrPii(
    canonicalJson({ href: iconUrl.href, mediaType: iconMediaType }),
    "canonical_listing_icon_metadata",
  );
  const apiFallback = await fetchExpectedStatus(
    `${origin}/tcs/v1/release-safety-not-found`,
    404,
  );
  const apiFallbackJson = JSON.parse(
    Buffer.from(apiFallback.bytes).toString("utf8"),
  ) as JsonObject;
  const fallbackError = isRecord(apiFallbackJson.error)
    ? apiFallbackJson.error
    : apiFallbackJson;
  if (
    fallbackError.code !== "not_found" ||
    apiFallback.response.headers.get("content-type")?.includes("text/html")
  ) {
    throw new Error("api_fallback_behavior_mismatch");
  }
  const staticAsset = options.manifest.assets.find((file) =>
    /^assets\/index-.*[.]js$/u.test(file.path),
  );
  const index = options.manifest.assets.find(
    (file) => file.path === "index.html",
  );
  if (!staticAsset || !index) throw new Error("spa_release_assets_missing");
  const remoteStatic = await fetchBytes(`${origin}/${staticAsset.path}`);
  if (sha256Bytes(remoteStatic.bytes) !== staticAsset.sha256)
    throw new Error("spa_static_asset_mismatch");
  const fallback = await fetchBytes(
    `${origin}/release-safety/${VERSION}/fallback`,
  );
  if (
    sha256Bytes(fallback.bytes) !== index.sha256 ||
    !fallback.response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/html")
  ) {
    throw new Error("spa_fallback_mismatch");
  }
  return options.candidateChecks.map((check) => ({
    ...check,
    status: "passed",
  }));
}

export function assertMigrationReadback(
  output: string,
  migrationCount: number,
): void {
  if (!/No migrations to apply[.!]?/iu.test(output)) {
    throw new Error("d1_migration_readback_has_pending_rows");
  }
  if (migrationCount !== 6) throw new Error("d1_migration_lineage_incomplete");
}

export async function ensurePrivateEvidenceDirectory(
  pathInput: string,
): Promise<string> {
  if (!isAbsolute(pathInput))
    throw new Error("evidence_directory_must_be_absolute");
  await mkdir(pathInput, { recursive: true, mode: 0o700 });
  await chmod(pathInput, 0o700);
  const path = await realpath(pathInput);
  const metadata = await stat(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("evidence_directory_permissions_invalid");
  }
  return path;
}
