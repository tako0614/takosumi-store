import { resolve } from "node:path";

import { runStoreReleaseAdapter } from "./store-release-fixed-adapter.ts";

function envelopeArgument(args: readonly string[]): string {
  if (
    args.length !== 2 ||
    args[0] !== "--envelope" ||
    !args[1]?.startsWith("/")
  ) {
    throw new Error("fixed_adapter_arguments_invalid");
  }
  return args[1];
}

try {
  const result = await runStoreReleaseAdapter({
    environment: "staging",
    envelopePath: envelopeArgument(process.argv.slice(2)),
    wrapperPath: resolve(import.meta.filename),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code =
    error instanceof Error && /^[a-z0-9_]+/u.test(error.message)
      ? error.message.match(/^[a-z0-9_]+/u)![0]
      : "store_staging_release_failed";
  process.stderr.write(`takosumi-store staging adapter blocked: ${code}\n`);
  process.exitCode = 1;
}
