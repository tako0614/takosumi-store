/**
 * Listing slug helpers. A slug is the per-app identifier within a publisher's
 * scope; the public listing id is `${scope}/${slug}`. Slugs are lowercase
 * `[a-z0-9]` with single internal hyphens.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Normalize free text into a candidate slug (may be empty if no usable chars). */
export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function slugIsValid(slug: string): boolean {
  return slug.length >= 1 && slug.length <= 48 && SLUG_RE.test(slug);
}
