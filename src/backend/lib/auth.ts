import type { StoreDb } from "../db/client.ts";
import { getPublisherById, type Publisher } from "../db/publishers-store.ts";
import { lookupSessionPublisherId, parseSessionCookie } from "./session.ts";
import { jsonError, type TcsContext } from "./http.ts";

/** Salt for session-token hashing (a dev fallback keeps local login working). */
export function sessionSalt(c: TcsContext): string {
  return c.env.SESSION_HASH_SALT?.trim() || "tcs-dev-salt";
}

/** Resolve the logged-in publisher from the session cookie, or null. */
export async function currentPublisher(
  c: TcsContext,
  db: StoreDb,
): Promise<Publisher | null> {
  const token = parseSessionCookie(c.req.header("cookie") ?? null);
  if (!token) return null;
  const publisherId = await lookupSessionPublisherId(db, {
    token,
    salt: sessionSalt(c),
    now: new Date(),
  });
  if (!publisherId) return null;
  return getPublisherById(db, publisherId);
}

export type RequireResult =
  | { ok: true; publisher: Publisher }
  | { ok: false; response: Response };

/** Gate a handler on a logged-in publisher (401 otherwise). */
export async function requirePublisher(
  c: TcsContext,
  db: StoreDb,
): Promise<RequireResult> {
  const publisher = await currentPublisher(c, db);
  if (!publisher) {
    return {
      ok: false,
      response: jsonError(c, 401, "unauthenticated", "authentication required"),
    };
  }
  return { ok: true, publisher };
}
