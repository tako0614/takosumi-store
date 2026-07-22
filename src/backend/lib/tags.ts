/**
 * Listing tag helpers. Tags are free-form, multi-valued browse facets the
 * publisher chooses. Each tag is normalized to a lowercase slug (single
 * internal hyphens); the set is deduped and capped so one listing can't carry
 * an unbounded tag cloud.
 */
export const MAX_TAGS_PER_LISTING = 8;
export const MAX_TAG_LENGTH = 24;

/** Normalize one free-text tag into a slug (may be empty if no usable chars). */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG_LENGTH);
}

/**
 * Normalize an arbitrary input value into a clean, deduped, capped tag list.
 * Accepts an array of strings or a single comma/space-separated string.
 */
export function normalizeTags(
  input: unknown,
  max = MAX_TAGS_PER_LISTING,
): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.filter((v): v is string => typeof v === "string")
    : typeof input === "string"
      ? input.split(/[,\s]+/)
      : [];
  const out: string[] = [];
  for (const candidate of raw) {
    const tag = normalizeTag(candidate);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}
