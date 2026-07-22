import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Listings table — one row per published Capsule pointer. Listing wire fields
 * (spec/listing.ts) are flattened. Legacy `inputs`, `install_experience`, and
 * `output_allowlist` columns may exist in deployed DBs, but the public Store
 * wire no longer uses them; setup metadata belongs in repo `.well-known/tcs.json`.
 * `badges` is stored as JSON text. `publisherId` is nullable until accounts
 * land (M3).
 *
 * Schema changes are authored as hand-written SQL under ../../../migrations and
 * mirrored here for drizzle query typing; drizzle-kit must never mutate the
 * canonical migrations.
 */
export const listings = sqliteTable(
  "listings",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull().default(""),
    slug: text("slug").notNull().default(""),
    git: text("git").notNull(),
    ref: text("ref").notNull(),
    resolvedCommit: text("resolved_commit"),
    path: text("path").notNull().default(""),
    kind: text("kind").notNull(),
    surface: text("surface").notNull(),
    provider: text("provider").notNull(),
    category: text("category").notNull(),
    tags: text("tags").notNull().default("[]"),
    suggestedName: text("suggested_name").notNull(),
    nameJa: text("name_ja").notNull(),
    nameEn: text("name_en").notNull(),
    descriptionJa: text("description_ja").notNull().default(""),
    descriptionEn: text("description_en").notNull().default(""),
    badgeJa: text("badge_ja").notNull().default(""),
    badgeEn: text("badge_en").notNull().default(""),
    iconUrl: text("icon_url"),
    inputs: text("inputs").notNull().default("[]"),
    installExperience: text("install_experience"),
    outputAllowlist: text("output_allowlist").notNull().default("[]"),
    publisherId: text("publisher_id"),
    publisherHandle: text("publisher_handle"),
    publisherDisplayName: text("publisher_display_name"),
    badges: text("badges"),
    status: text("status").notNull().default("visible"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    sourceUnique: uniqueIndex("listings_source_unique").on(t.git, t.path),
    scopeIdx: index("listings_scope_idx").on(t.scope, t.slug),
    updatedIdx: index("listings_updated_idx").on(t.updatedAt, t.id),
    createdIdx: index("listings_created_idx").on(t.createdAt, t.id),
    categoryIdx: index("listings_category_idx").on(t.category),
    kindIdx: index("listings_kind_idx").on(t.kind),
    providerIdx: index("listings_provider_idx").on(t.provider),
  }),
);

export const SCHEMA_NOW = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export type ListingRow = typeof listings.$inferSelect;
export type ListingInsert = typeof listings.$inferInsert;

/**
 * Publishers — account-owned identities (official implementation only; the open
 * spec does not define how listings are created). One row per Takosumi Accounts
 * OIDC subject. `handle` is set on first login.
 */
export const publishers = sqliteTable("publishers", {
  id: text("id").primaryKey(),
  oidcSub: text("oidc_sub").notNull().unique(),
  handle: text("handle").unique(),
  displayName: text("display_name"),
  email: text("email"),
  role: text("role").notNull().default("publisher"),
  followedServers: text("followed_servers").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Sessions — httpOnly cookie sessions. `id` is a salted hash of the opaque
 * cookie token (the raw token is never stored), so a DB read can't reconstruct
 * a live cookie.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    publisherId: text("publisher_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    publisherIdx: index("sessions_publisher_idx").on(t.publisherId),
  }),
);

/** Reports — lightweight moderation queue. */
export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").notNull(),
    reporterSub: text("reporter_sub"),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    listingIdx: index("reports_listing_idx").on(t.listingId),
    statusIdx: index("reports_status_idx").on(t.status),
  }),
);

export type PublisherRow = typeof publishers.$inferSelect;
export type PublisherInsert = typeof publishers.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
