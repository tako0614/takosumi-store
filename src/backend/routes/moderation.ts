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
  listOpenReports,
  resolveReport,
} from "../db/reports-store.ts";

const ALLOWED_BADGES = new Set(["verified"]);

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

  // Anyone may report (logged-in attaches their subject).
  app.post("/moderation/reports", async (c: TcsContext) => {
    const db = resolveDb(c);
    const body = (await c.req.json().catch(() => null)) as {
      listingId?: unknown;
      reason?: unknown;
    } | null;
    const listingId = typeof body?.listingId === "string" ? body.listingId : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!listingId || !reason) {
      return jsonError(
        c,
        400,
        "invalid_argument",
        "listingId and reason required",
      );
    }
    if (!(await getListingRow(db, listingId))) {
      return jsonError(c, 404, "not_found", "no such listing");
    }
    const reporter = await currentPublisher(c, db);
    await createReport(db, {
      id: `rpt-${crypto.randomUUID()}`,
      listingId,
      reporterSub: reporter?.oidcSub ?? null,
      reason,
      now: new Date(),
    });
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
    await resolveReport(db, c.req.param("id")!);
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
