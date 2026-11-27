/**
 * Client-side field validation helpers for PublishPage.
 * Mirrors the Store's server-side URL/slug expectations for instant inline
 * feedback without duplicating server authority.
 */

export type GitUrlError = "required" | "invalid" | null;
export type LogoUrlError = "invalid" | null;
export type SlugError = "invalid" | null;
export type HandleError = "required" | "invalid" | null;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

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

/** Extracts a fallback display name from a Git repository URL. */
export function repoNameFromGitUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return (
      u.pathname
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "")
        .split("/")
        .pop() ?? ""
    ).trim();
  } catch {
    return "";
  }
}
