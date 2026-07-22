import { and, asc, desc, eq, gt, lt, or, sql, type SQL } from "drizzle-orm";
import type { StoreDb } from "./client.ts";
import { listings, type ListingInsert, type ListingRow } from "./schema.ts";
import type { ValidatedListing } from "../lib/listing-validate.ts";
import type { Publisher } from "./publishers-store.ts";
import { decodeCursor, encodeCursor } from "../lib/cursor.ts";
import type { Listing } from "../../../spec/listing.ts";
import type {
  ListListingsQuery,
  ListingsPage,
  ListSort,
  Locale,
} from "../../../spec/api.ts";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../../../spec/pagination.ts";

// ---------------------------------------------------------------------------
// Row <-> wire mapping
// ---------------------------------------------------------------------------

function parseJsonArray<T>(value: string | null): readonly T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function rowToListing(row: ListingRow): Listing {
  const badges = parseJsonArray<string>(row.badges);
  return {
    id: row.id,
    scope: row.scope,
    slug: row.slug,
    source: {
      git: row.git,
      path: row.path,
    },
    kind: row.kind as Listing["kind"],
    surface: row.surface as Listing["surface"],
    provider: row.provider,
    category: row.category,
    tags: parseJsonArray<string>(row.tags),
    suggestedName: row.suggestedName,
    name: { ja: row.nameJa, en: row.nameEn },
    description: { ja: row.descriptionJa, en: row.descriptionEn },
    badge: { ja: row.badgeJa, en: row.badgeEn },
    ...(row.iconUrl ? { iconUrl: row.iconUrl } : {}),
    ...(row.publisherHandle
      ? {
          publisher: {
            handle: row.publisherHandle,
            ...(row.publisherDisplayName
              ? { displayName: row.publisherDisplayName }
              : {}),
          },
        }
      : {}),
    ...(badges.length > 0 ? { badges } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Build an insert row from a Listing (used by seed and publish). */
export function listingToInsert(listing: Listing): ListingInsert {
  return {
    id: listing.id,
    scope: listing.scope,
    slug: listing.slug,
    git: listing.source.git,
    ref: "",
    resolvedCommit: null,
    path: listing.source.path ?? "",
    kind: listing.kind,
    surface: listing.surface,
    provider: listing.provider,
    category: listing.category,
    tags: JSON.stringify(listing.tags ?? []),
    suggestedName: listing.suggestedName,
    nameJa: listing.name.ja,
    nameEn: listing.name.en,
    descriptionJa: listing.description.ja,
    descriptionEn: listing.description.en,
    badgeJa: listing.badge.ja,
    badgeEn: listing.badge.en,
    iconUrl: listing.iconUrl ?? null,
    inputs: "[]",
    installExperience: null,
    outputAllowlist: "[]",
    publisherId: null,
    publisherHandle: listing.publisher?.handle ?? null,
    publisherDisplayName: listing.publisher?.displayName ?? null,
    badges:
      listing.badges && listing.badges.length > 0
        ? JSON.stringify(listing.badges)
        : null,
    status: "visible",
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Query planning
// ---------------------------------------------------------------------------

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PAGE_LIMIT;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return n;
}

interface SortPlan {
  readonly sortExpr: SQL;
  readonly direction: "asc" | "desc";
  readonly keyOf: (row: ListingRow) => string;
}

function buildSortPlan(sort: ListSort, locale: Locale): SortPlan {
  if (sort === "created") {
    return {
      sortExpr: sql`${listings.createdAt}`,
      direction: "desc",
      keyOf: (r) => r.createdAt,
    };
  }
  if (sort === "name") {
    const nameCol = locale === "ja" ? listings.nameJa : listings.nameEn;
    return {
      sortExpr: sql`lower(${nameCol})`,
      direction: "asc",
      keyOf: (r) => (locale === "ja" ? r.nameJa : r.nameEn).toLowerCase(),
    };
  }
  return {
    sortExpr: sql`${listings.updatedAt}`,
    direction: "desc",
    keyOf: (r) => r.updatedAt,
  };
}

function keysetPredicate(
  plan: SortPlan,
  k: string,
  id: string,
): SQL | undefined {
  const { sortExpr, direction } = plan;
  if (direction === "desc") {
    return or(lt(sortExpr, k), and(eq(sortExpr, k), lt(listings.id, id)));
  }
  return or(gt(sortExpr, k), and(eq(sortExpr, k), gt(listings.id, id)));
}

function searchPredicate(q: string): SQL | undefined {
  const needle = q.trim().toLowerCase();
  if (!needle) return undefined;
  const cols = [
    listings.nameJa,
    listings.nameEn,
    listings.descriptionJa,
    listings.descriptionEn,
    listings.provider,
    listings.category,
    listings.tags,
    listings.suggestedName,
  ];
  return or(...cols.map((col) => sql`instr(lower(${col}), ${needle}) > 0`));
}

interface QueryOptions extends ListListingsQuery {
  readonly q?: string;
}

/**
 * Core listing query: visible rows, optional filters + search, keyset paging.
 * Returns the page plus a `cursorError` flag when the supplied cursor was
 * malformed (the route maps that to 400 invalid_argument).
 */
export async function queryListings(
  db: StoreDb,
  opts: QueryOptions,
): Promise<{ page: ListingsPage; cursorError: boolean }> {
  const limit = clampLimit(opts.limit);
  const sort: ListSort = opts.sort ?? "updated";
  const locale: Locale = opts.locale ?? "en";
  const plan = buildSortPlan(sort, locale);

  const conditions: (SQL | undefined)[] = [eq(listings.status, "visible")];
  if (opts.category) conditions.push(eq(listings.category, opts.category));
  if (opts.tag) {
    // Tags are a JSON string array; match the quoted, normalized element so
    // "social" doesn't also match "social-network".
    const needle = JSON.stringify(opts.tag.trim().toLowerCase());
    conditions.push(sql`instr(lower(${listings.tags}), ${needle}) > 0`);
  }
  if (opts.kind) conditions.push(eq(listings.kind, opts.kind));
  if (opts.provider) conditions.push(eq(listings.provider, opts.provider));
  if (opts.surface) conditions.push(eq(listings.surface, opts.surface));
  if (opts.scope) conditions.push(eq(listings.scope, opts.scope));
  if (opts.q !== undefined) conditions.push(searchPredicate(opts.q));

  let cursorError = false;
  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (!decoded) {
      cursorError = true;
    } else {
      conditions.push(keysetPredicate(plan, decoded.k, decoded.id));
    }
  }
  if (cursorError) {
    return { page: { items: [] }, cursorError: true };
  }

  const where = and(...conditions.filter((c): c is SQL => c !== undefined));
  const orderBy =
    plan.direction === "desc"
      ? [desc(plan.sortExpr), desc(listings.id)]
      : [asc(plan.sortExpr), asc(listings.id)];

  const rows = (await db
    .select()
    .from(listings)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit + 1)) as ListingRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(rowToListing);

  let nextCursor: string | undefined;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = encodeCursor({ k: plan.keyOf(last), id: last.id });
  }

  return {
    page: nextCursor ? { items, nextCursor } : { items },
    cursorError: false,
  };
}

export async function getListingById(
  db: StoreDb,
  id: string,
): Promise<Listing | null> {
  const rows = (await db
    .select()
    .from(listings)
    .where(and(eq(listings.id, id), eq(listings.status, "visible")))
    .limit(1)) as ListingRow[];
  const row = rows[0];
  return row ? rowToListing(row) : null;
}

/** Canonical get by `scope/slug` (visible only). */
export function getListingByScopeSlug(
  db: StoreDb,
  scope: string,
  slug: string,
): Promise<Listing | null> {
  return getListingById(db, `${scope}/${slug}`);
}

/** True when a slug is already used (any status) within a scope. */
export async function slugTakenInScope(
  db: StoreDb,
  scope: string,
  slug: string,
): Promise<boolean> {
  const rows = (await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.scope, scope), eq(listings.slug, slug)))
    .limit(1)) as { id: string }[];
  return rows.length > 0;
}

/** Count a scope's visible listings (for quota enforcement). */
export async function countListingsInScope(
  db: StoreDb,
  scope: string,
): Promise<number> {
  const rows = (await db
    .select({ c: sql<number>`count(*)` })
    .from(listings)
    .where(and(eq(listings.scope, scope), eq(listings.status, "visible")))) as {
    c: number;
  }[];
  return Number(rows[0]?.c ?? 0);
}

// ---------------------------------------------------------------------------
// Facet counts (ServerInfo)
// ---------------------------------------------------------------------------

export interface FacetCounts {
  readonly total: number;
  readonly categories: readonly { key: string; count: number }[];
  readonly kinds: readonly { key: string; count: number }[];
  readonly providers: readonly { key: string; count: number }[];
}

export async function facetCounts(db: StoreDb): Promise<FacetCounts> {
  const visible = eq(listings.status, "visible");
  const countExpr = sql<number>`count(*)`;

  const totalRows = (await db
    .select({ c: countExpr })
    .from(listings)
    .where(visible)) as { c: number }[];

  const byCategory = (await db
    .select({ key: listings.category, count: countExpr })
    .from(listings)
    .where(visible)
    .groupBy(listings.category)) as { key: string; count: number }[];

  const byKind = (await db
    .select({ key: listings.kind, count: countExpr })
    .from(listings)
    .where(visible)
    .groupBy(listings.kind)) as { key: string; count: number }[];

  const byProvider = (await db
    .select({ key: listings.provider, count: countExpr })
    .from(listings)
    .where(visible)
    .groupBy(listings.provider)) as { key: string; count: number }[];

  return {
    total: Number(totalRows[0]?.c ?? 0),
    categories: byCategory.map((r) => ({ key: r.key, count: Number(r.count) })),
    kinds: byKind.map((r) => ({ key: r.key, count: Number(r.count) })),
    providers: byProvider.map((r) => ({ key: r.key, count: Number(r.count) })),
  };
}

/** Insert listings, ignoring rows whose stored source tuple already exists. */
export async function insertListingsIgnoreConflict(
  db: StoreDb,
  rows: readonly Listing[],
): Promise<void> {
  for (const listing of rows) {
    await db
      .insert(listings)
      .values(listingToInsert(listing))
      .onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// Write / ownership / moderation (official implementation)
// ---------------------------------------------------------------------------

/** Fetch a row by id regardless of status (for owner / moderator ops). */
export async function getListingRow(
  db: StoreDb,
  id: string,
): Promise<ListingRow | null> {
  const rows = (await db
    .select()
    .from(listings)
    .where(eq(listings.id, id))
    .limit(1)) as ListingRow[];
  return rows[0] ?? null;
}

async function findBySource(
  db: StoreDb,
  git: string,
  path: string,
  excludeId?: string,
): Promise<ListingRow | null> {
  const conditions = [eq(listings.git, git), eq(listings.path, path)];
  if (excludeId) conditions.push(sql`${listings.id} != ${excludeId}`);
  const rows = (await db
    .select()
    .from(listings)
    .where(and(...conditions))
    .limit(1)) as ListingRow[];
  return rows[0] ?? null;
}

function coreToInsert(
  id: string,
  scope: string,
  slug: string,
  core: ValidatedListing,
  publisher: Publisher,
  now: string,
): ListingInsert {
  return {
    id,
    scope,
    slug,
    git: core.source.git,
    ref: "",
    resolvedCommit: null,
    path: core.source.path,
    kind: core.kind,
    surface: core.surface,
    provider: core.provider,
    category: core.category,
    tags: JSON.stringify(core.tags),
    suggestedName: core.suggestedName,
    nameJa: core.name.ja,
    nameEn: core.name.en,
    descriptionJa: core.description.ja,
    descriptionEn: core.description.en,
    badgeJa: core.badge.ja,
    badgeEn: core.badge.en,
    iconUrl: core.iconUrl ?? null,
    inputs: "[]",
    installExperience: null,
    outputAllowlist: "[]",
    publisherId: publisher.id,
    publisherHandle: publisher.handle,
    publisherDisplayName: publisher.displayName,
    badges: null,
    status: "visible",
    createdAt: now,
    updatedAt: now,
  };
}

export async function createListing(
  db: StoreDb,
  input: {
    id: string;
    scope: string;
    slug: string;
    core: ValidatedListing;
    publisher: Publisher;
    now: Date;
  },
): Promise<{ ok: true; listing: Listing } | { ok: false; reason: "conflict" }> {
  const { git, path } = input.core.source;
  if (await findBySource(db, git, path)) {
    return { ok: false, reason: "conflict" };
  }
  const row = coreToInsert(
    input.id,
    input.scope,
    input.slug,
    input.core,
    input.publisher,
    input.now.toISOString(),
  );
  await db.insert(listings).values(row);
  const created = await getListingRow(db, input.id);
  if (!created) throw new Error("failed to create listing");
  return { ok: true, listing: rowToListing(created) };
}

export async function updateListingCore(
  db: StoreDb,
  input: {
    id: string;
    core: ValidatedListing;
    now: Date;
  },
): Promise<void> {
  const { core } = input;
  if (await findBySource(db, core.source.git, core.source.path, input.id)) {
    throw new Error("source_conflict");
  }
  await db
    .update(listings)
    .set({
      git: core.source.git,
      ref: "",
      resolvedCommit: null,
      path: core.source.path,
      kind: core.kind,
      surface: core.surface,
      provider: core.provider,
      category: core.category,
      tags: JSON.stringify(core.tags),
      suggestedName: core.suggestedName,
      nameJa: core.name.ja,
      nameEn: core.name.en,
      descriptionJa: core.description.ja,
      descriptionEn: core.description.en,
      badgeJa: core.badge.ja,
      badgeEn: core.badge.en,
      iconUrl: core.iconUrl ?? null,
      inputs: "[]",
      installExperience: null,
      outputAllowlist: "[]",
      updatedAt: input.now.toISOString(),
    })
    .where(eq(listings.id, input.id));
}

export async function setListingStatus(
  db: StoreDb,
  id: string,
  status: "visible" | "hidden",
): Promise<void> {
  await db.update(listings).set({ status }).where(eq(listings.id, id));
}

export async function setListingBadges(
  db: StoreDb,
  id: string,
  badges: readonly string[],
): Promise<void> {
  await db
    .update(listings)
    .set({ badges: badges.length > 0 ? JSON.stringify(badges) : null })
    .where(eq(listings.id, id));
}

export async function hardDeleteListing(
  db: StoreDb,
  id: string,
): Promise<void> {
  await db.delete(listings).where(eq(listings.id, id));
}

/** A publisher's own listing carries its (owner-only) visibility status. */
export type OwnedListing = Listing & { readonly status: "visible" | "hidden" };

/** List a publisher's own listings (any status), newest first. */
export async function listOwnedListings(
  db: StoreDb,
  publisherId: string,
): Promise<OwnedListing[]> {
  const rows = (await db
    .select()
    .from(listings)
    .where(eq(listings.publisherId, publisherId))
    .orderBy(desc(listings.updatedAt), desc(listings.id))) as ListingRow[];
  return rows.map((row) => ({
    ...rowToListing(row),
    status: row.status === "hidden" ? "hidden" : "visible",
  }));
}
