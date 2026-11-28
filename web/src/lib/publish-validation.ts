/**
 * Client-side field validation helpers for PublishPage.
 * Mirrors the Store's server-side URL/slug expectations for instant inline
 * feedback without duplicating server authority.
 */

export type GitUrlError = "required" | "invalid" | null;
export type LogoUrlError = "invalid" | null;
export type SlugError = "invalid" | "required_ascii" | null;
export type HandleError = "required" | "invalid" | null;
export type TextLengthError = "too_long" | null;

export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2000;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

export function validateGitUrl(raw: string): GitUrlError {
  const trimmed = raw.trim();
  if (!trimmed) return "required";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "invalid";
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    return "invalid";
  }
  const pathParts = parsed.pathname
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (pathParts.length < 1) return "invalid";
  return null;
}

export function validateLogoUrl(raw: string): LogoUrlError {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "https:") return "invalid";
  if (!parsed.hostname || parsed.username || parsed.password) return "invalid";
  return null;
}

export function validateSlug(raw: string): SlugError {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return SLUG_RE.test(trimmed) ? null : "invalid";
}

export function validateHandle(raw: string): HandleError {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "required";
  return HANDLE_RE.test(trimmed) ? null : "invalid";
}

export function validateNameLength(raw: string): TextLengthError {
  return raw.trim().length > MAX_NAME_LENGTH ? "too_long" : null;
}

export function validateDescriptionLength(raw: string): TextLengthError {
  return raw.trim().length > MAX_DESCRIPTION_LENGTH ? "too_long" : null;
}

/** Extracts a fallback display name from a Git repository URL. */
export function repoNameFromGitUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const seg =
      u.pathname
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "")
        .split("/")
        .pop() ?? "";
    try {
      return decodeURIComponent(seg).trim();
    } catch {
      return seg.trim();
    }
  } catch {
    return "";
  }
}

/**
 * Derive an ASCII slug/suggestedName fallback from localized display names and
 * the Git repository name, so pure non-ASCII names (e.g. Japanese) still yield
 * a valid URL slug whenever an English name or ASCII repo segment exists.
 */
export function deriveAutoSlug(
  name: { readonly ja: string; readonly en: string },
  gitUrl: string,
): string {
  return (
    slugify(name.en) || slugify(name.ja) || slugify(repoNameFromGitUrl(gitUrl))
  );
}
