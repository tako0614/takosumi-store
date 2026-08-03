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
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/u;

function hasAsciiHttpsScheme(value: string): boolean {
  const expected = "https://";
  if (value.length < expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const expectedChar = expected[index]!;
    const actualChar = value[index]!;
    if (
      actualChar !== expectedChar &&
      actualChar !== expectedChar.toUpperCase()
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Canonicalize the URL-shaped part of a TCS source coordinate.
 *
 * This deliberately accepts a small ASCII grammar instead of delegating
 * identity to the moving WHATWG URL serializer. The same grammar is used by
 * the Store's SQL migration, so an old row cannot normalize differently from
 * a newly published row. Repository paths remain case-sensitive.
 */
export function canonicalTcsGitUrl(raw: string): string | undefined {
  if (CONTROL.test(raw)) return undefined;
  // SQLite trim(X) removes only U+0020 by default. Keep the JS parser's
  // boundary identical rather than silently accepting NBSP/BOM/other Unicode
  // whitespace that the migration would reject.
  const value = raw.replace(/^ +/u, "").replace(/ +$/u, "");
  if (
    !value ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }
  if (!hasAsciiHttpsScheme(value)) return undefined;

  const rest = value.slice("https://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;

  const authority = rest.slice(0, slash);
  if (!authority || authority.includes("@")) return undefined;

  const colon = authority.indexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  const portText = colon === -1 ? undefined : authority.slice(colon + 1);
  if (
    !host ||
    authority.indexOf(":", colon === -1 ? 0 : colon + 1) !== -1 ||
    host.split(".").some((label) => !DNS_LABEL.test(label))
  ) {
    return undefined;
  }

  let canonicalAuthority = host.toLowerCase();
  if (portText !== undefined) {
    if (!/^\d+$/u.test(portText)) return undefined;
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port > 65_535) return undefined;
    if (port !== 443) canonicalAuthority += `:${port}`;
  }

  const rawPath = rest.slice(slash).replace(/\/+$/u, "");
  if (!rawPath || rawPath === "/") return undefined;
  const segments = rawPath.slice(1).split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !PATH_SEGMENT.test(segment),
    )
  ) {
    return undefined;
  }

  let canonicalPath = rawPath;
  if (/\.git$/iu.test(canonicalPath)) {
    canonicalPath = canonicalPath.slice(0, -4).replace(/\/+$/u, "");
  }
  if (!canonicalPath || canonicalPath === "/") return undefined;
  const canonicalSegments = canonicalPath.slice(1).split("/");
  if (
    canonicalSegments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !PATH_SEGMENT.test(segment),
    )
  ) {
    return undefined;
  }
  return `https://${canonicalAuthority}${canonicalPath}`;
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
