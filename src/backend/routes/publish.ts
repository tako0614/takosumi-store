import { Hono } from "hono";
import type { Env, Variables } from "../types.ts";
import { jsonError, type TcsContext } from "../lib/http.ts";
import {
  defaultResolveDb,
  originOf,
  type DbResolver,
} from "../lib/db-context.ts";
import { requirePublisher } from "../lib/auth.ts";
import {
  validatePublishInput,
  type ValidatedListing,
} from "../lib/listing-validate.ts";
import { isRehostedIconKey, rehostListingIcon } from "../lib/icon-rehost.ts";
import {
  countListingsInScope,
  createListing,
  getListingRow,
  hardDeleteListing,
  listOwnedListings,
  rowToListing,
  setListingStatus,
  slugTakenInScope,
  updateListingCore,
} from "../db/listings-store.ts";
import { normalizeSlug, slugIsValid } from "../lib/slug.ts";
import type { StoreDb } from "../db/client.ts";

const DEFAULT_MAX_LISTINGS_PER_SCOPE = 10;

/** Per-scope listing quota (operator-overridable via env). */
function maxListingsPerScope(env: Env): number {
  const raw = Number(env.TCS_MAX_LISTINGS_PER_SCOPE);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : DEFAULT_MAX_LISTINGS_PER_SCOPE;
}

/** Append -2, -3, … until the slug is free within the scope. */
async function uniqueSlug(
  db: StoreDb,
  scope: string,
  base: string,
): Promise<string> {
  if (!(await slugTakenInScope(db, scope, base))) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!(await slugTakenInScope(db, scope, candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

type IconRehoster = typeof rehostListingIcon;

function hasExplicitIcon(body: unknown): boolean {
  return Boolean(
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, "iconUrl"),
  );
}

async function withRehostedIcon(
  env: Env,
  origin: string,
  body: unknown,
  core: ValidatedListing,
  rehostIcon: IconRehoster,
) {
  const explicit = hasExplicitIcon(body);
  const iconUrl = await rehostIcon({
    bucket: env.ICONS,
    origin,
    source: core.source,
    ...(core.iconUrl ? { reference: core.iconUrl } : {}),
    discoverWhenMissing: !explicit,
  });
  const { iconUrl: _unhostedIcon, ...withoutIcon } = core;
  return iconUrl ? { ...withoutIcon, iconUrl } : withoutIcon;
}

export function createPublishRoutes(
  resolveDb: DbResolver = defaultResolveDb,
  rehostIcon: IconRehoster = rehostListingIcon,
): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  // Serve re-hosted icons from R2.
  app.get("/icons/:key", async (c: TcsContext) => {
    if (!c.env.ICONS) return new Response(null, { status: 404 });
    const key = c.req.param("key");
    if (!key || !isRehostedIconKey(key)) {
      return new Response(null, { status: 404 });
    }
    const obj = await c.env.ICONS.get(`icons/${key}`);
    if (!obj) return new Response(null, { status: 404 });
    return new Response(obj.body as unknown as BodyInit, {
      headers: {
        "content-type": obj.httpMetadata?.contentType ?? "image/png",
        "cache-control": "public, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.get("/publish/listings", async (c: TcsContext) => {
    const db = resolveDb(c);
    const auth = await requirePublisher(c, db);
    if (!auth.ok) return auth.response;
    return c.json({ listings: await listOwnedListings(db, auth.publisher.id) });
  });

  app.post("/publish/listings", async (c: TcsContext) => {
    const db = resolveDb(c);
    const auth = await requirePublisher(c, db);
    if (!auth.ok) return auth.response;
    if (!auth.publisher.handle) {
      return jsonError(
        c,
        400,
        "failed_precondition",
        "set a handle before publishing",
      );
    }
    const scope = auth.publisher.handle;
    const body = await c.req.json().catch(() => null);
    const result = validatePublishInput(body);
    if (!result.ok) {
      return jsonError(
        c,
        400,
        "invalid_argument",
        "invalid listing",
        result.errors,
      );
    }
    const max = maxListingsPerScope(c.env);
    if ((await countListingsInScope(db, scope)) >= max) {
      return jsonError(
        c,
        429,
        "resource_exhausted",
        `listing quota reached for ${scope} (max ${max})`,
      );
    }

    const explicitSlug =
      body && typeof (body as { slug?: unknown }).slug === "string"
        ? (body as { slug: string }).slug.trim()
        : "";
    let slug: string;
    if (explicitSlug) {
      slug = normalizeSlug(explicitSlug);
      if (!slugIsValid(slug)) {
        return jsonError(
          c,
          400,
          "invalid_argument",
          "slug must be lowercase letters, digits, and hyphens",
        );
      }
      if (await slugTakenInScope(db, scope, slug)) {
        return jsonError(
          c,
          409,
          "conflict",
          `slug "${slug}" is already taken in ${scope}`,
        );
      }
    } else {
      const base = normalizeSlug(result.value.suggestedName);
      if (!slugIsValid(base)) {
        return jsonError(
          c,
          400,
          "invalid_argument",
          "could not derive a slug from the name; provide an explicit slug",
        );
      }
      slug = await uniqueSlug(db, scope, base);
    }

    const core = await withRehostedIcon(
      c.env,
      originOf(c),
      body,
      result.value,
      rehostIcon,
    );

    const created = await createListing(db, {
      id: `${scope}/${slug}`,
      scope,
      slug,
      core,
      publisher: auth.publisher,
      now: new Date(),
    });
    if (!created.ok) {
      return jsonError(
        c,
        409,
        "conflict",
        "a listing for this git+path already exists",
      );
    }
    return c.json({ listing: created.listing, warnings: result.warnings }, 201);
  });

  app.patch("/publish/listings/:scope/:slug", async (c: TcsContext) => {
    const db = resolveDb(c);
    const auth = await requirePublisher(c, db);
    if (!auth.ok) return auth.response;
    const id = `${c.req.param("scope")}/${c.req.param("slug")}`;
    const row = await getListingRow(db, id);
    if (!row) return jsonError(c, 404, "not_found", "no such listing");
    if (row.publisherId !== auth.publisher.id) {
      return jsonError(c, 403, "permission_denied", "not your listing");
    }
    const body = await c.req.json().catch(() => null);
    const result = validatePublishInput(body);
    if (!result.ok) {
      return jsonError(
        c,
        400,
        "invalid_argument",
        "invalid listing",
        result.errors,
      );
    }
    const core = await withRehostedIcon(
      c.env,
      originOf(c),
      body,
      result.value,
      rehostIcon,
    );
    try {
      await updateListingCore(db, {
        id,
        core,
        now: new Date(),
      });
    } catch {
      return jsonError(
        c,
        409,
        "conflict",
        "git+path collides with another listing",
      );
    }
    const updated = await getListingRow(db, id);
    return c.json({ listing: updated ? rowToListing(updated) : null });
  });

  app.delete("/publish/listings/:scope/:slug", async (c: TcsContext) => {
    const db = resolveDb(c);
    const auth = await requirePublisher(c, db);
    if (!auth.ok) return auth.response;
    const id = `${c.req.param("scope")}/${c.req.param("slug")}`;
    const row = await getListingRow(db, id);
    if (!row) return jsonError(c, 404, "not_found", "no such listing");
    if (row.publisherId !== auth.publisher.id) {
      return jsonError(c, 403, "permission_denied", "not your listing");
    }
    if (c.req.query("hard") === "true") {
      await hardDeleteListing(db, id);
    } else {
      await setListingStatus(db, id, "hidden");
    }
    return c.json({ ok: true });
  });

  // Toggle a listing between public (visible) and unlisted (hidden) without
  // deleting it — the "unpublish / republish" registry control.
  app.post("/publish/listings/:scope/:slug/status", async (c: TcsContext) => {
    const db = resolveDb(c);
    const auth = await requirePublisher(c, db);
    if (!auth.ok) return auth.response;
    const id = `${c.req.param("scope")}/${c.req.param("slug")}`;
    const row = await getListingRow(db, id);
    if (!row) return jsonError(c, 404, "not_found", "no such listing");
    if (row.publisherId !== auth.publisher.id) {
      return jsonError(c, 403, "permission_denied", "not your listing");
    }
    const body = (await c.req.json().catch(() => null)) as {
      status?: unknown;
    } | null;
    const status = body?.status;
    if (status !== "visible" && status !== "hidden") {
      return jsonError(
        c,
        400,
        "invalid_argument",
        'status must be "visible" or "hidden"',
      );
    }
    await setListingStatus(db, id, status);
    const updated = await getListingRow(db, id);
    return c.json({ listing: updated ? rowToListing(updated) : null });
  });

  return app;
}
