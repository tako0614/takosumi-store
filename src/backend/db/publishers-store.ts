import { eq } from "drizzle-orm";
import type { StoreDb } from "./client.ts";
import { publishers, type PublisherRow } from "./schema.ts";

export interface Publisher {
  readonly id: string;
  readonly oidcSub: string;
  readonly handle: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: "publisher" | "moderator";
  readonly followedServers: readonly string[];
}

export function rowToPublisher(row: PublisherRow): Publisher {
  let followed: string[] = [];
  try {
    const parsed = JSON.parse(row.followedServers) as unknown;
    if (Array.isArray(parsed))
      followed = parsed.filter((s) => typeof s === "string");
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    oidcSub: row.oidcSub,
    handle: row.handle,
    displayName: row.displayName,
    email: row.email,
    role: row.role === "moderator" ? "moderator" : "publisher",
    followedServers: followed,
  };
}

export async function getPublisherById(
  db: StoreDb,
  id: string,
): Promise<Publisher | null> {
  const rows = (await db
    .select()
    .from(publishers)
    .where(eq(publishers.id, id))
    .limit(1)) as PublisherRow[];
  return rows[0] ? rowToPublisher(rows[0]) : null;
}

export async function getPublisherBySub(
  db: StoreDb,
  sub: string,
): Promise<Publisher | null> {
  const rows = (await db
    .select()
    .from(publishers)
    .where(eq(publishers.oidcSub, sub))
    .limit(1)) as PublisherRow[];
  return rows[0] ? rowToPublisher(rows[0]) : null;
}

export async function getPublisherByHandle(
  db: StoreDb,
  handle: string,
): Promise<Publisher | null> {
  const rows = (await db
    .select()
    .from(publishers)
    .where(eq(publishers.handle, handle))
    .limit(1)) as PublisherRow[];
  return rows[0] ? rowToPublisher(rows[0]) : null;
}

/** Get-or-create a publisher row for an OIDC subject (first login). */
export async function upsertPublisherBySub(
  db: StoreDb,
  input: {
    id: string;
    sub: string;
    name?: string;
    email?: string;
    now: Date;
    firstIsModerator?: boolean;
  },
): Promise<Publisher> {
  const existing = await getPublisherBySub(db, input.sub);
  if (existing) return existing;
  const iso = input.now.toISOString();
  await db.insert(publishers).values({
    id: input.id,
    oidcSub: input.sub,
    handle: null,
    displayName: input.name ?? null,
    email: input.email ?? null,
    role: input.firstIsModerator ? "moderator" : "publisher",
    followedServers: "[]",
    createdAt: iso,
    updatedAt: iso,
  });
  const created = await getPublisherBySub(db, input.sub);
  if (!created) throw new Error("failed to create publisher");
  return created;
}

const HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export async function setPublisherHandle(
  db: StoreDb,
  input: { id: string; handle: string; now: Date },
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "taken" }> {
  const handle = input.handle.trim().toLowerCase();
  if (!HANDLE.test(handle)) return { ok: false, reason: "invalid" };
  const taken = await getPublisherByHandle(db, handle);
  if (taken && taken.id !== input.id) return { ok: false, reason: "taken" };
  await db
    .update(publishers)
    .set({ handle, updatedAt: input.now.toISOString() })
    .where(eq(publishers.id, input.id));
  return { ok: true };
}
