/**
 * Runtime contract for the TCS discovery coordinate.
 *
 * TCS owns the wire vocabulary (`{ git, path }`). Consumers that use a
 * different internal source shape must parse this tuple first and only then
 * adapt the two canonical values to their local model.
 */
export interface ListingSource {
  /**
   * Canonical credential-free HTTPS Git URL. Query strings and fragments are
   * never part of repository identity.
   */
  readonly git: string;
  /** Canonical repository-relative module path. `.` is the repository root. */
  readonly path: string;
}

const CONTROL = /\p{Cc}/u;

/** Canonicalize the URL-shaped part of a TCS source coordinate. */
export function canonicalTcsGitUrl(raw: string): string | undefined {
  if (CONTROL.test(raw)) return undefined;
  const value = raw.trim();
  if (
    !value ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    const pathname = parsed.pathname
      .replace(/\/+$/u, "")
      .replace(/\.git$/iu, "");
    if (!pathname || pathname === "/") return undefined;
    parsed.pathname = pathname;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

/** Canonicalize a repository-relative TCS module path without folding case. */
export function canonicalTcsModulePath(raw: string): string | undefined {
  if (CONTROL.test(raw)) return undefined;
  let value = raw.trim();
  if (!value || value === ".") return ".";
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }

  value = value.replace(/\/+$/u, "");
  while (value.startsWith("./")) value = value.slice(2);
  if (!value || value === ".") return ".";

  const canonical: string[] = [];
  for (const rawSegment of value.split("/")) {
    if (!rawSegment) return undefined;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment).normalize("NFC");
    } catch {
      return undefined;
    }
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      CONTROL.test(segment)
    ) {
      return undefined;
    }
    canonical.push(segment);
  }
  return canonical.join("/");
}

/**
 * Parse an untrusted TCS source object and return its one canonical wire form.
 * Extra fields are rejected so version/ref authority cannot hitchhike through
 * a listing.
 */
export function parseTcsListingSource(
  input: unknown,
): ListingSource | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const source = input as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => key !== "git" && key !== "path") ||
    typeof source.git !== "string" ||
    typeof source.path !== "string"
  ) {
    return undefined;
  }
  const git = canonicalTcsGitUrl(source.git);
  const path = canonicalTcsModulePath(source.path);
  return git && path ? { git, path } : undefined;
}

/** Canonical cross-server de-duplication key for a valid TCS source tuple. */
export function tcsListingSourceIdentity(input: unknown): string | undefined {
  const source = parseTcsListingSource(input);
  return source ? `${source.git}#${source.path}` : undefined;
}
