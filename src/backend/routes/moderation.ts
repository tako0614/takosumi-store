import { Hono } from "hono";
import type { Env, Variables } from "../types.ts";
import { jsonError, type TcsContext } from "../lib/http.ts";
import { defaultResolveDb, type DbResolver } from "../lib/db-context.ts";
import { currentPublisher, requirePublisher } from "../lib/auth.ts";
import type { StoreDb } from "../db/client.ts";
import {
  getListingRow,
  setListingBadges,
  setListingStatus,
} from "../db/listings-store.ts";
import {
  createReport,
  hasOpenDuplicate,
  listOpenReports,
  reserveReportRateLimit,
  resolveReport,
} from "../db/reports-store.ts";

const ALLOWED_BADGES = new Set(["verified"]);
const MAX_REPORT_BODY_BYTES = 4 * 1024;
const MAX_REPORT_REASON_CHARS = 1000;
const MAX_REPORTS_PER_REPORTER_HOUR = 5;

async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function reportKeys(
  c: TcsContext,
  reporterSub: string | undefined,
  reason: string,
): Promise<{ reporterKey: string; reasonDigest: string } | null> {
  const salt = c.env.SESSION_HASH_SALT?.trim();
  if (!salt) return null;
  const reporterIdentity = reporterSub
    ? `subject:${reporterSub}`
    : `anonymous:${c.req.header("cf-connecting-ip")?.trim() || "unknown"}`;
  return {
    reporterKey: await sha256(`${salt}\0${reporterIdentity}`),
    reasonDigest: await sha256(`${salt}\0reason:${reason}`),
  };
}

async function requireModerator(c: TcsContext, db: StoreDb) {
  const auth = await requirePublisher(c, db);
  if (!auth.ok) return auth;
  if (auth.publisher.role !== "moderator") {
    return {
      ok: false as const,
      response: jsonError(
        c,
        403,
        "permission_denied",
        "moderator role required",
      ),
    };
  }
  return auth;
}

export function createModerationRoutes(
  resolveDb: DbResolver = defaultResolveDb,
): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  // Anyone may report; authenticated subjects and anonymous edge addresses are
  // reduced to salted opaque abuse keys before persistence.
  app.post("/moderation/reports", async (c: TcsContext) => {
    const db = resolveDb(c);
    const rawBody = await readBoundedText(c.req.raw, MAX_REPORT_BODY_BYTES);
    if (rawBody === null) {
      return jsonError(c, 413, "resource_exhausted", "report body too large");
    }
    const body = (() => {
      try {
        return JSON.parse(rawBody) as {
          listingId?: unknown;
          reason?: unknown;
        };
      } catch {
        return null;
      }
    })() as {
      listingId?: unknown;
      reason?: unknown;
    } | null;
    const listingId = typeof body?.listingId === "string" ? body.listingId : "";
    const reason =
      typeof body?.reason === "string"
        ? body.reason.trim().replace(/\s+/gu, " ")
        : "";
    if (!listingId || !reason) {
      return jsonError(
        c,
        400,
        "invalid_argument",
        "listingId and reason required",
      );
    }
    if (reason.length > MAX_REPORT_REASON_CHARS) {
      return jsonError(c, 400, "invalid_argument", "reason is too long");
    }
    if (!(await getListingRow(db, listingId))) {
      return jsonError(c, 404, "not_found", "no such listing");
    }
    const reporter = await currentPublisher(c, db);
    const keys = await reportKeys(c, reporter?.oidcSub, reason);
    if (!keys) {
      return jsonError(
        c,
        503,
        "failed_precondition",
        "moderation reporting is not configured",
      );
    }
    if (
      await hasOpenDuplicate(db, listingId, keys.reporterKey, keys.reasonDigest)
    ) {
      return c.json({ ok: true, deduplicated: true });
    }
    if (
      !(await reserveReportRateLimit(
        db,
        keys.reporterKey,
        new Date(),
        MAX_REPORTS_PER_REPORTER_HOUR,
      ))
    ) {
      return jsonError(
        c,
        429,
        "resource_exhausted",
        "report rate limit reached",
      );
    }
    const outcome = await createReport(db, {
      id: `rpt-${crypto.randomUUID()}`,
      listingId,
      ...keys,
      reason,
      now: new Date(),
    });
    if (outcome === "duplicate") {
      return c.json({ ok: true, deduplicated: true });
    }
    if (outcome === "saturated") {
      return jsonError(
        c,
        429,
        "resource_exhausted",
        "listing report queue is full",
      );
    }
    return c.json({ ok: true });
  });

  app.get("/moderation/reports", async (c: TcsContext) => {
    const db = resolveDb(c);
    const mod = await requireModerator(c, db);
    if (!mod.ok) return mod.response;
    return c.json({ reports: await listOpenReports(db) });
  });

  app.post("/moderation/reports/:id/resolve", async (c: TcsContext) => {
    const db = resolveDb(c);
    const mod = await requireModerator(c, db);
    if (!mod.ok) return mod.response;
    if (!(await resolveReport(db, c.req.param("id")!))) {
      return jsonError(c, 404, "not_found", "no such open report");
    }
    return c.json({ ok: true });
  });

  const setStatus = (status: "visible" | "hidden") => async (c: TcsContext) => {
    const db = resolveDb(c);
    const mod = await requireModerator(c, db);
    if (!mod.ok) return mod.response;
    const id = `${c.req.param("scope")}/${c.req.param("slug")}`;
    if (!(await getListingRow(db, id))) {
      return jsonError(c, 404, "not_found", "no such listing");
    }
    await setListingStatus(db, id, status);
    return c.json({ ok: true });
  };
  app.post("/moderation/listings/:scope/:slug/hide", setStatus("hidden"));
  app.post("/moderation/listings/:scope/:slug/show", setStatus("visible"));

  app.post(
    "/moderation/listings/:scope/:slug/badges",
    async (c: TcsContext) => {
      const db = resolveDb(c);
      const mod = await requireModerator(c, db);
      if (!mod.ok) return mod.response;
      const id = `${c.req.param("scope")}/${c.req.param("slug")}`;
      if (!(await getListingRow(db, id))) {
        return jsonError(c, 404, "not_found", "no such listing");
      }
      const body = (await c.req.json().catch(() => null)) as {
        badges?: unknown;
      } | null;
      const badges = Array.isArray(body?.badges)
        ? (body.badges as unknown[]).filter(
            (b): b is string => typeof b === "string" && ALLOWED_BADGES.has(b),
          )
        : [];
      await setListingBadges(db, id, badges);
      return c.json({ ok: true, badges });
    },
  );

  return app;
}
