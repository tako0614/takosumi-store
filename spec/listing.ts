/**
 * TCS Listing wire schema.
 *
 * A Listing is only a discovery pointer to an installable Capsule (a plain
 * OpenTofu/Terraform module addressed by git url + module path) plus lightweight
 * presentation metadata. Version selection, setup fields, output projection,
 * artifact hints, and install UX live in the repository and the Takosumi install
 * flow; the store must not become install authority.
 *
 * `publisher` and `badges` are presentation / server-local curation, NOT
 * cross-server trust assertions.
 */

/** Bilingual display text (mirrors Takosumi `InstallConfigCatalogText`). */
export interface LocalizedText {
  readonly ja: string;
  readonly en: string;
}

/** Capsule source pointer (mirrors Takosumi `InstallConfigCatalogSource`). */
export interface ListingSource {
  /** https git url, no embedded credentials. */
  readonly git: string;
  /** Module path inside the repo; "" or "." for the repo root. */
  readonly path: string;
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
  let host = "";
  let rest = "";
  try {
    const url = new URL(source.git);
    host = url.host.toLowerCase();
    // Strip trailing slashes BEFORE `.git` so ".../repo.git/" normalizes too.
    rest = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  } catch {
    // Fall back to the raw string when the url is unparsable.
    host = source.git.trim().toLowerCase();
    rest = "";
  }
  const path = source.path
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  return `${host}${rest}#${path === "." ? "" : path}`;
}
