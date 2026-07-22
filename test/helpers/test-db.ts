import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../../src/backend/db/schema.ts";
import type { StoreDb } from "../../src/backend/db/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "../../migrations");

function splitStatements(sqlText: string): string[] {
  // Drop full-line comments first, THEN split — otherwise a statement preceded
  // by a comment block would be discarded as if it were a comment.
  const stripped = sqlText
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** In-memory libsql StoreDb with all canonical migrations applied. */
export async function createTestDb(): Promise<StoreDb> {
  const client = createClient({ url: ":memory:" });
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const text = readFileSync(join(migrationsDir, file), "utf8");
    for (const stmt of splitStatements(text)) {
      await client.execute(stmt);
    }
  }
  return drizzle(client, { schema }) as unknown as StoreDb;
}
