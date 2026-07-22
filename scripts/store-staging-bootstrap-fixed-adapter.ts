import { resolve } from "node:path";

import { mainStoreStagingBootstrapAdapter } from "./store-staging-bootstrap-adapter.ts";

try {
  await mainStoreStagingBootstrapAdapter(resolve(import.meta.filename));
} catch (error) {
  const message =
    error instanceof Error ? error.message : "store_staging_bootstrap_failed";
  const code =
    message.match(/^[a-z0-9_]+/u)?.[0] ?? "store_staging_bootstrap_failed";
  process.stderr.write(`takosumi-store staging bootstrap blocked: ${code}\n`);
  process.exitCode = 1;
}
