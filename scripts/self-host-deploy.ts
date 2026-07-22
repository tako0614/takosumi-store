import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  const vars =
    config.vars && typeof config.vars === "object"
      ? (config.vars as Record<string, unknown>)
      : {};
  const appUrl = String(vars.APP_URL ?? "").replace(/\/$/u, "");
  if (
    appUrl === "https://store.takosumi.com" ||
    config.name === "takosumi-store"
  ) {
    throw new Error("official_store_target_forbidden_in_self_host_wrapper");
  }
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

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "self_host_deploy_failed";
  process.stderr.write(`takosumi-store self-host deploy blocked: ${message}\n`);
  process.exitCode = 1;
}
