import { createD1Db, type StoreDb } from "../db/client.ts";
import type { TcsContext } from "./http.ts";

/** Resolve the store handle for a request. Overridable in tests. */
export type DbResolver = (c: TcsContext) => StoreDb;

export const defaultResolveDb: DbResolver = (c) => createD1Db(c.env.DB);

/** Canonical public origin (APP_URL, else the request origin). */
export function originOf(c: TcsContext): string {
  const fromEnv = c.env.APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

export function isSecureRequest(c: TcsContext): boolean {
  try {
    return new URL(originOf(c)).protocol === "https:";
  } catch {
    return false;
  }
}
