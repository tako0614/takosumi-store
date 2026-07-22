import { and, eq, gt } from "drizzle-orm";
import type { StoreDb } from "../db/client.ts";
import { sessions } from "../db/schema.ts";

export const SESSION_COOKIE = "tcs_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Session id = salted hash of the opaque cookie token (raw token never stored). */
export function hashToken(token: string, salt: string): Promise<string> {
  return sha256hex(`${salt}:${token}`);
}

export async function createSession(
  db: StoreDb,
  input: { publisherId: string; token: string; salt: string; now: Date },
): Promise<void> {
  const id = await hashToken(input.token, input.salt);
  await db.insert(sessions).values({
    id,
    publisherId: input.publisherId,
    expiresAt: new Date(input.now.getTime() + SESSION_TTL_MS).toISOString(),
    createdAt: input.now.toISOString(),
  });
}

export async function lookupSessionPublisherId(
  db: StoreDb,
  input: { token: string; salt: string; now: Date },
): Promise<string | null> {
  const id = await hashToken(input.token, input.salt);
  const rows = (await db
    .select({ publisherId: sessions.publisherId })
    .from(sessions)
    .where(
      and(eq(sessions.id, id), gt(sessions.expiresAt, input.now.toISOString())),
    )
    .limit(1)) as { publisherId: string }[];
  return rows[0]?.publisherId ?? null;
}

export async function deleteSession(
  db: StoreDb,
  input: { token: string; salt: string },
): Promise<void> {
  const id = await hashToken(input.token, input.salt);
  await db.delete(sessions).where(eq(sessions.id, id));
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function buildSessionCookie(
  token: string,
  opts: { secure: boolean; maxAgeSec?: number },
): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSec ?? Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}
