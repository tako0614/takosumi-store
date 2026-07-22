import { Hono } from "hono";
import type { Env, Variables } from "../types.ts";
import { createD1Db, type StoreDb } from "../db/client.ts";
import {
  getListingById,
  getListingByScopeSlug,
  queryListings,
} from "../db/listings-store.ts";
import { buildServerInfo } from "../lib/server-info.ts";
import { fetchListingReadme } from "../lib/readme.ts";
import { tcsError, type TcsContext } from "../lib/http.ts";
import {
  LIST_SORTS,
  LISTING_KINDS,
  LISTING_SURFACES,
  type ListListingsQuery,
  type Locale,
} from "../../../spec/api.ts";

type ParseResult =
  | { ok: true; query: ListListingsQuery & { q?: string } }
  | { ok: false; response: Response };

/** Canonical public base url for ServerInfo / self de-dup. */
function baseUrlOf(c: TcsContext): string {
  const fromEnv = c.env.APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

function parseCommonQuery(c: TcsContext): ParseResult {
  const q = c.req.query();
  const query: ListListingsQuery & { q?: string } = {};

  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1) {
      return {
        ok: false,
        response: tcsError(
          c,
          "invalid_argument",
          "`limit` must be a positive integer",
        ),
      };
    }
    (query as { limit?: number }).limit = n;
  }
  if (q.cursor !== undefined) (query as { cursor?: string }).cursor = q.cursor;
  if (q.category !== undefined) {
    (query as { category?: string }).category = q.category;
  }
  if (q.tag !== undefined) {
    (query as { tag?: string }).tag = q.tag;
  }
  if (q.provider !== undefined) {
    (query as { provider?: string }).provider = q.provider;
  }
  if (q.scope !== undefined) {
    (query as { scope?: string }).scope = q.scope;
  }
  if (q.kind !== undefined) {
    if (!LISTING_KINDS.includes(q.kind as (typeof LISTING_KINDS)[number])) {
      return {
        ok: false,
        response: tcsError(
          c,
          "invalid_argument",
          `unknown \`kind\`: ${q.kind}`,
        ),
      };
    }
    (query as { kind?: (typeof LISTING_KINDS)[number] }).kind =
      q.kind as (typeof LISTING_KINDS)[number];
  }
  if (q.surface !== undefined) {
    if (
      !LISTING_SURFACES.includes(q.surface as (typeof LISTING_SURFACES)[number])
    ) {
      return {
        ok: false,
        response: tcsError(
          c,
          "invalid_argument",
          `unknown \`surface\`: ${q.surface}`,
        ),
      };
    }
    (query as { surface?: (typeof LISTING_SURFACES)[number] }).surface =
      q.surface as (typeof LISTING_SURFACES)[number];
  }
  if (q.sort !== undefined) {
    if (!LIST_SORTS.includes(q.sort as (typeof LIST_SORTS)[number])) {
      return {
        ok: false,
        response: tcsError(
          c,
          "invalid_argument",
          `unknown \`sort\`: ${q.sort}`,
        ),
      };
    }
    (query as { sort?: (typeof LIST_SORTS)[number] }).sort =
      q.sort as (typeof LIST_SORTS)[number];
  }
  if (q.locale !== undefined) {
    if (q.locale !== "ja" && q.locale !== "en") {
      return {
        ok: false,
        response: tcsError(c, "invalid_argument", "`locale` must be ja or en"),
      };
    }
    (query as { locale?: Locale }).locale = q.locale;
  }
  return { ok: true, query };
}

/** Resolve the store handle for a request. Overridable in tests. */
export type DbResolver = (c: TcsContext) => StoreDb;

const defaultResolveDb: DbResolver = (c) => createD1Db(c.env.DB);

export function createReadRoutes(
  resolveDb: DbResolver = defaultResolveDb,
): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  const serverInfoHandler = async (c: TcsContext) => {
    const info = await buildServerInfo(resolveDb(c), baseUrlOf(c));
    return c.json(info);
  };

  app.get("/.well-known/tcs", serverInfoHandler);
  app.get("/tcs/v1/server-info", serverInfoHandler);

  app.get("/tcs/v1/listings", async (c: TcsContext) => {
    const parsed = parseCommonQuery(c);
    if (!parsed.ok) return parsed.response;
    const { page, cursorError } = await queryListings(
      resolveDb(c),
      parsed.query,
    );
    if (cursorError) return tcsError(c, "invalid_argument", "invalid `cursor`");
    return c.json(page);
  });

  app.get("/tcs/v1/listings/search", async (c: TcsContext) => {
    const rawQ = c.req.query("q");
    if (!rawQ || rawQ.trim() === "") {
      return tcsError(c, "invalid_argument", "`q` is required");
    }
    const q: string = rawQ;
    const parsed = parseCommonQuery(c);
    if (!parsed.ok) return parsed.response;
    const { page, cursorError } = await queryListings(resolveDb(c), {
      ...parsed.query,
      q,
    });
    if (cursorError) return tcsError(c, "invalid_argument", "invalid `cursor`");
    return c.json(page);
  });

  // Canonical get by `scope/slug` (two path segments).
  app.get("/tcs/v1/listings/:scope/:slug", async (c: TcsContext) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    if (!scope || !slug) return tcsError(c, "not_found", "missing scope/slug");
    const listing = await getListingByScopeSlug(resolveDb(c), scope, slug);
    if (!listing) {
      return tcsError(c, "not_found", `no listing ${scope}/${slug}`);
    }
    return c.json(listing);
  });

  // Registry-grade detail: the source repo's README, fetched (SSRF-guarded)
  // from the listing's own repository pointer and cached in KV. 404 when absent.
  app.get("/tcs/v1/listings/:scope/:slug/readme", async (c: TcsContext) => {
    const scope = c.req.param("scope");
    const slug = c.req.param("slug");
    if (!scope || !slug) return tcsError(c, "not_found", "missing scope/slug");
    const listing = await getListingByScopeSlug(resolveDb(c), scope, slug);
    if (!listing) {
      return tcsError(c, "not_found", `no listing ${scope}/${slug}`);
    }
    const src = listing.source;
    const cacheKey = `readme:${src.git}#${src.path}`;
    if (c.env.KV) {
      const cached = await c.env.KV.get(cacheKey);
      if (cached === "none") return tcsError(c, "not_found", "no README");
      if (cached) {
        return c.json(JSON.parse(cached) as unknown, 200, {
          "cache-control": "public, max-age=600",
        });
      }
    }
    const readme = await fetchListingReadme(src);
    if (c.env.KV) {
      // Cache a hit for an hour, but a miss only briefly: a "no README" result
      // may be a transient fetch failure (rate limit / timeout), so it must
      // self-heal instead of hiding a real README for an hour.
      await c.env.KV.put(cacheKey, readme ? JSON.stringify(readme) : "none", {
        expirationTtl: readme ? 3_600 : 120,
      });
    }
    if (!readme) return tcsError(c, "not_found", "no README");
    return c.json(readme, 200, { "cache-control": "public, max-age=600" });
  });

  app.get("/tcs/v1/listings/:id", async (c: TcsContext) => {
    const id = c.req.param("id");
    if (!id) return tcsError(c, "not_found", "missing listing id");
    const listing = await getListingById(resolveDb(c), id);
    if (!listing) return tcsError(c, "not_found", `no listing with id ${id}`);
    return c.json(listing);
  });

  return app;
}
