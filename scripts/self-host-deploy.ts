import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const OFFICIAL_STORE_HOSTNAME = "store.takosumi.com";
const OFFICIAL_STORE_WORKER = "takosumi-store";
const OFFICIAL_DATABASE_NAMES = new Set(["takosumi-store-db"]);
const OFFICIAL_KV_NAMES = new Set(["takosumi-store-kv"]);
const OFFICIAL_R2_NAMES = new Set(["takosumi-store-icons"]);

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function routeHostname(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const pattern = value.trim().toLowerCase();
  try {
    return new URL(pattern).hostname;
  } catch {
    return pattern
      .replace(/^\*\./u, "")
      .split("/", 1)[0]!
      .replace(/[.]$/u, "")
      .split(":", 1)[0]!;
  }
}

function routeTargetsOfficialStore(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(routeTargetsOfficialStore);
  const pattern =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>).pattern
      : value;
  const hostname = routeHostname(pattern);
  return (
    hostname === OFFICIAL_STORE_HOSTNAME ||
    hostname?.endsWith(`.${OFFICIAL_STORE_HOSTNAME}`) === true
  );
}

/**
 * Fail closed before a self-host deployment can address the public/canonical
 * official Store identities. Opaque Cloudflare IDs are protected by separate
 * account/token custody; their realized values are intentionally not copied
 * into this public repository.
 */
export function assertSelfHostTarget(config: Record<string, unknown>): void {
  const vars =
    config.vars &&
    typeof config.vars === "object" &&
    !Array.isArray(config.vars)
      ? (config.vars as Record<string, unknown>)
      : {};
  const appUrl = String(vars.APP_URL ?? "").replace(/\/$/u, "");
  const routesOfficialStore =
    routeTargetsOfficialStore(config.route) ||
    routeTargetsOfficialStore(config.routes);
  const databaseTargetsOfficialStore = records(config.d1_databases).some(
    (database) =>
      typeof database.database_name === "string" &&
      OFFICIAL_DATABASE_NAMES.has(database.database_name),
  );
  const kvTargetsOfficialStore = records(config.kv_namespaces).some(
    (namespace) =>
      [namespace.name, namespace.title, namespace.namespace_name].some(
        (name) => typeof name === "string" && OFFICIAL_KV_NAMES.has(name),
      ),
  );
  const r2TargetsOfficialStore = records(config.r2_buckets).some(
    (bucket) =>
      typeof bucket.bucket_name === "string" &&
      OFFICIAL_R2_NAMES.has(bucket.bucket_name),
  );
  if (
    appUrl === `https://${OFFICIAL_STORE_HOSTNAME}` ||
    config.name === OFFICIAL_STORE_WORKER ||
    routesOfficialStore ||
    databaseTargetsOfficialStore ||
    kvTargetsOfficialStore ||
    r2TargetsOfficialStore
  ) {
    throw new Error("official_store_target_forbidden_in_self_host_wrapper");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    args[0] !== "--i-understand-this-is-self-host" ||
    args[1] !== "--config" ||
    !isAbsolute(args[2] ?? "")
  ) {
    throw new Error(
      "self_host_deploy_requires_explicit_marker_and_absolute_config",
    );
  }
  if (
    Object.keys(process.env).some((name) =>
      name.startsWith("TAKOS_RELEASE_SAFETY_"),
    )
  ) {
    throw new Error("self_host_deploy_forbidden_under_release_controller");
  }
  const root = await realpath(resolve(import.meta.dir, ".."));
  const configPath = await realpath(args[2]!);
  const child = relative(root, configPath);
  if (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  ) {
    throw new Error("self_host_config_must_live_outside_repository");
  }
  const config = Bun.TOML.parse(await Bun.file(configPath).text()) as Record<
    string,
    unknown
  >;
  assertSelfHostTarget(config);
  const build = spawnSync(process.execPath, ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (build.status !== 0) throw new Error("self_host_build_failed");
  const wrangler = resolve(root, "node_modules/wrangler/wrangler-dist/cli.js");
  const deploy = spawnSync(
    process.execPath,
    [wrangler, "deploy", "--config", configPath],
    {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (deploy.status !== 0) throw new Error("self_host_deploy_failed");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "self_host_deploy_failed";
    process.stderr.write(
      `takosumi-store self-host deploy blocked: ${message}\n`,
    );
    process.exitCode = 1;
  }
}
