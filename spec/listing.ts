/**
 * TCS Listing wire schema.
 *
 * A Listing is only a discovery pointer to an installable Capsule (a plain
 * OpenTofu/Terraform module addressed by git url + module path) plus lightweight
 * presentation metadata. Version selection, setup fields, output projection,
 * artifact hints, and install UX remain Takosumi installer authority. An app
 * repository may propose Takosumi-specific install UX through its optional
 * `.well-known/takosumi.json`, but the Store never reads or returns that file
 * and must not become install authority.
 *
 * `publisher` and `badges` are presentation / server-local curation, NOT
 * cross-server trust assertions.
 */

import {
  tcsListingSourceIdentity,
  type ListingSource,
} from "./listing-source.ts";

export type { ListingSource } from "./listing-source.ts";

/** Bilingual display text (mirrors Takosumi `InstallConfigCatalogText`). */
export interface LocalizedText {
  readonly ja: string;
  readonly en: string;
}

/** Service archetype (mirrors Takosumi `InstallConfigCatalogKind`). */
export type ListingKind = "worker" | "storage" | "site";
/** Discovery surface (mirrors Takosumi `InstallConfigCatalogSurface`). */
export type ListingSurface = "service" | "building_block" | "example";

/** Presentation-only publisher attribution (NOT a trust assertion). */
export interface ListingPublisher {
  readonly handle: string;
  readonly displayName?: string;
}

export interface Listing {
  /** Stable id, equal to `${scope}/${slug}` (used by get-by-id and cursor paging). */
  readonly id: string;
  /** Publisher namespace (the publisher's handle). */
  readonly scope: string;
  /** URL-safe identifier, unique within the scope. `id === ${scope}/${slug}`. */
  readonly slug: string;
  readonly source: ListingSource;
  readonly kind: ListingKind;
  readonly surface: ListingSurface;
  /** Provider address namespace, e.g. "cloudflare" | "aws". Free string. */
  readonly provider: string;
  /**
   * Primary store-local taxonomy facet (a single slug, e.g. "social").
   * Retained for wire compatibility; by convention `category === tags[0]` when
   * the publisher supplied tags. Browse/filter UIs SHOULD prefer `tags`.
   */
  readonly category: string;
  /**
   * Free-form, multi-valued browse tags chosen by the publisher (normalized
   * lowercase slugs, e.g. ["social","activitypub"]). May be empty.
   */
  readonly tags: readonly string[];
  readonly suggestedName: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly badge: LocalizedText;
  /** Absolute https icon url (a server may re-host to its own object store). */
  readonly iconUrl?: string;
  readonly publisher?: ListingPublisher;
  /** Server-local curation flags, e.g. ["official","verified"]. Presentation only. */
  readonly badges?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Normalized identity tuple used for cross-server de-duplication. */
export function listingIdentity(source: ListingSource): string {
  return (
    tcsListingSourceIdentity(source) ??
    `${source.git.trim()}#${source.path.trim()}`
  );
}
