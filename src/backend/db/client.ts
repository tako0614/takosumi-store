import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.ts";

/**
 * Shared store handle. Both the D1 driver (worker) and the libsql driver (tests)
 * produce an async `BaseSQLiteDatabase`, so store code is written once against
 * this type and runs unchanged in either environment.
 */
export type StoreDb = BaseSQLiteDatabase<"async", unknown, typeof schema>;

/** Worker-side factory (Cloudflare D1). */
export function createD1Db(d1: D1Database): StoreDb {
  return drizzle(d1 as never, { schema }) as unknown as StoreDb;
}

export { schema };
