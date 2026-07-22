import type { StoreDb } from "../../src/backend/db/client.ts";
import {
  setPublisherHandle,
  upsertPublisherBySub,
} from "../../src/backend/db/publishers-store.ts";
import { createSession } from "../../src/backend/lib/session.ts";

export const TEST_SALT = "tcs-dev-salt";

/** Create a publisher (+ optional handle/role) and a session; return its cookie. */
export async function login(
  db: StoreDb,
  opts: { handle?: string; role?: "publisher" | "moderator" } = {},
): Promise<{ publisherId: string; cookie: string }> {
  const now = new Date();
  const publisher = await upsertPublisherBySub(db, {
    id: `pub-${crypto.randomUUID()}`,
    sub: `sub-${crypto.randomUUID()}`,
    now,
    firstIsModerator: opts.role === "moderator",
  });
  if (opts.handle) {
    await setPublisherHandle(db, {
      id: publisher.id,
      handle: opts.handle,
      now,
    });
  }
  const token = `tok-${crypto.randomUUID()}`;
  await createSession(db, {
    publisherId: publisher.id,
    token,
    salt: TEST_SALT,
    now,
  });
  return { publisherId: publisher.id, cookie: `tcs_session=${token}` };
}
