/**
 * TCS read API — request params + response shapes for the four mandatory
 * endpoints every conforming server implements:
 *
 *   GET /tcs/v1/listings                 → ListingsPage
 *   GET /tcs/v1/listings/search?q=<...>  → ListingsPage   (capability "search")
 *   GET /tcs/v1/listings/{id}            → Listing
 *   GET /.well-known/tcs                 → ServerInfo      (alias /tcs/v1/server-info)
 *
 * Reads are unauthenticated by spec (a server MAY gate them, but the official
 * implementation does not). Errors use the TcsErrorEnvelope; lists use keyset
 * cursor pagination.
 */
import type { Listing, ListingKind, ListingSurface } from "./listing.ts";
import type { Page } from "./pagination.ts";

export const TCS_API_PREFIX = "/tcs/v1" as const;
export const TCS_WELL_KNOWN = "/.well-known/tcs" as const;

export type ListSort = "updated" | "created" | "name";
export type Locale = "ja" | "en";

export const LIST_SORTS: readonly ListSort[] = ["updated", "created", "name"];
export const LISTING_KINDS: readonly ListingKind[] = [
  "worker",
  "storage",
  "site",
];
export const LISTING_SURFACES: readonly ListingSurface[] = [
  "service",
  "building_block",
  "example",
];

/** Query params for `GET /tcs/v1/listings`. */
export interface ListListingsQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly category?: string;
  /** Filter to listings carrying this tag (matches any of `tags`). */
  readonly tag?: string;
  readonly kind?: ListingKind;
  readonly provider?: string;
  readonly surface?: ListingSurface;
  /** Filter to a single publisher namespace (scope). */
  readonly scope?: string;
  /** Defaults to "updated". */
  readonly sort?: ListSort;
  /** Affects `sort=name` collation only; text fields always return both locales. */
  readonly locale?: Locale;
}

/** Query params for `GET /tcs/v1/listings/search` (adds required `q`). */
export interface SearchListingsQuery extends ListListingsQuery {
  readonly q: string;
}

export type ListingsPage = Page<Listing>;
