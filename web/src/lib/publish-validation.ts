/**
 * Client-side field validation helpers for PublishPage.
 * Mirrors the Store's server-side URL/slug/handle/tag expectations for instant
 * inline feedback without duplicating server authority.
 */
import { canonicalTcsGitUrl } from "../../../spec/listing-source.ts";

export type GitUrlError = "required" | "invalid" | null;
export type LogoUrlError = "invalid" | null;
export type SlugError = "invalid" | "required_ascii" | null;
export type HandleError = "required" | "invalid" | null;
export type TextLengthError = "too_long" | null;

export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
// Matches `src/backend/db/publishers-store.ts` (`HANDLE`).
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const BLOCKED_LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
];

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
  const canonical = canonicalTcsGitUrl(trimmed);
  if (!canonical) return "invalid";
  let parsed: URL;
  try {
    parsed = new URL(canonical);
  } catch {
    return "invalid";
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    host === "localhost" ||
    BLOCKED_LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return "invalid";
  }
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

/** Normalize one free-form tag to match the backend slug normalizer. */
export function normalizeTagInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG_LENGTH)
    .replace(/-+$/, "");
}

export type TagFeedbackReason =
  "" | "non_ascii" | "duplicate" | "limit_reached";

export interface ParseTagInputResult {
  readonly next: string[];
  readonly added: string[];
  readonly feedback: TagFeedbackReason;
}

/**
 * Parse comma-separated (ASCII or full-width) tag tokens into normalized ASCII
 * slugs while surfacing why any non-empty token was skipped.
 */
export function parseTagInput(
  raw: string,
  existing: readonly string[],
  max = MAX_TAGS,
): ParseTagInputResult {
  const next = [...existing];
  const added: string[] = [];
  let droppedNonAscii = false;
  let duplicate = false;
  let limitReached = false;

  for (const part of raw.split(/[,、，]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tag = normalizeTagInput(trimmed);
    if (!tag) {
      droppedNonAscii = true;
      continue;
    }
    if (next.includes(tag)) {
      duplicate = true;
      continue;
    }
    if (next.length >= max) {
      limitReached = true;
      continue;
    }
    next.push(tag);
    added.push(tag);
  }

  const feedback: TagFeedbackReason = droppedNonAscii
    ? "non_ascii"
    : limitReached
      ? "limit_reached"
      : duplicate && added.length === 0
        ? "duplicate"
        : "";
  return { next, added, feedback };
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
