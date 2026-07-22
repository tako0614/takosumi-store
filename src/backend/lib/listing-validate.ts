import { safeListingIconReference } from "./icon-rehost.ts";
import { isSafeRemoteUrl } from "./ssrf.ts";
import { normalizeSlug } from "./slug.ts";
import { normalizeTags } from "./tags.ts";
import { LISTING_KINDS, LISTING_SURFACES } from "../../../spec/api.ts";
import type {
  Listing,
  ListingSource,
  LocalizedText,
} from "../../../spec/listing.ts";

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/** The publisher-controlled subset of a Listing (id/timestamps/publisher added by the route). */
export interface ValidatedListing {
  readonly source: ListingSource;
  readonly kind: Listing["kind"];
  readonly surface: Listing["surface"];
  readonly provider: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly suggestedName: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly badge: LocalizedText;
  readonly iconUrl?: string;
}

export type ValidationResult =
  | { ok: true; value: ValidatedListing; warnings: string[] }
  | { ok: false; errors: string[] };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function isHttpsSafe(url: string): boolean {
  if (!isSafeRemoteUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
function localized(v: unknown): LocalizedText {
  const r = asRecord(v);
  return { ja: str(r.ja).trim(), en: str(r.en).trim() };
}

export function validatePublishInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const body = asRecord(input);

  // --- source ---
  const source = asRecord(body.source);
  const git = str(source.git).trim();
  if (!git) errors.push("source.git is required");
  else if (!isHttpsSafe(git)) {
    errors.push(
      "source.git must be an https url with no embedded credentials and a public host",
    );
  }
  const path = str(source.path).trim();
  if (path.length > 500) errors.push("source.path too long");
  for (const field of ["ref", "resolvedCommit", "commit"]) {
    if (source[field] !== undefined) {
      errors.push(
        `source.${field} belongs in the repository or Takosumi install flow, not in the store listing`,
      );
    }
  }

  // --- enums ---
  const kind = str(body.kind);
  if (!LISTING_KINDS.includes(kind as (typeof LISTING_KINDS)[number])) {
    errors.push(`kind must be one of ${LISTING_KINDS.join(", ")}`);
  }
  const surface = str(body.surface) || "service";
  if (
    !LISTING_SURFACES.includes(surface as (typeof LISTING_SURFACES)[number])
  ) {
    errors.push(`surface must be one of ${LISTING_SURFACES.join(", ")}`);
  }

  // --- slugs ---
  const provider = str(body.provider).trim();
  if (!SLUG.test(provider) || provider.length > 64) {
    errors.push("provider must be a short slug");
  }
  // Tags are the publisher-facing taxonomy; `category` (a single slug) is kept
  // for wire compatibility and derived from the first tag, falling back to an
  // explicit `category` field or "general" so older clients still work.
  const tags = normalizeTags(body.tags);
  const category = tags[0] ?? (normalizeSlug(str(body.category)) || "general");
  const suggestedName = str(body.suggestedName).trim();
  if (!SLUG.test(suggestedName) || suggestedName.length > 64) {
    errors.push("suggestedName must be a short slug");
  }

  // --- text ---
  const name = localized(body.name);
  if (!name.ja && !name.en) errors.push("name requires ja or en");
  if (name.ja.length > 120 || name.en.length > 120)
    errors.push("name too long");
  const description = localized(body.description);
  if (description.ja.length > 2000 || description.en.length > 2000) {
    errors.push("description too long");
  }
  const badge = localized(body.badge);
  if (badge.ja.length > 32 || badge.en.length > 32)
    errors.push("badge too long");

  // --- icon ---
  let iconUrl: string | undefined;
  const rawIcon = str(body.iconUrl).trim();
  if (rawIcon) {
    const safe = safeListingIconReference(rawIcon);
    if (!safe) warnings.push("iconUrl was unsafe and will be omitted");
    else iconUrl = safe;
  }

  for (const field of ["inputs", "installExperience", "outputAllowlist"]) {
    if (body[field] !== undefined) {
      errors.push(
        `${field} belongs in the repository .well-known/tcs.json, not in the store listing`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    value: {
      source: { git, path },
      kind: kind as Listing["kind"],
      surface: surface as Listing["surface"],
      provider,
      category,
      tags,
      suggestedName,
      name,
      description,
      badge,
      ...(iconUrl ? { iconUrl } : {}),
    },
  };
}
