import { resolve } from "node:path";

import { mainReplicaAdapter } from "./store-release-replica-adapter.ts";

try {
  await mainReplicaAdapter(resolve(import.meta.filename));
} catch (error) {
  const code =
    error instanceof Error && /^[a-z0-9_]+/u.test(error.message)
      ? error.message.match(/^[a-z0-9_]+/u)![0]
      : "store_replica_failed";
  process.stderr.write(`takosumi-store replica adapter blocked: ${code}\n`);
  process.exitCode = 1;
}
