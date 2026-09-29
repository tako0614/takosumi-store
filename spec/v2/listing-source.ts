/**
 * TCS 2.0 listing source.
 *
 * A v2 source names the repository a listing is about and, when the catalog
 * reviewed one specific module inside it, that module's directory. The module
 * path is discovery/curation data, not install authority: an installer still
 * resolves it against the immutable snapshot it scanned before it plans or
 * applies anything. Refs, commits, and install configuration stay off this
 * wire shape, so a listing can never pin executable bytes.
 */

import {
  canonicalTcsGitUrl,
  canonicalTcsModulePath,
} from "../listing-source.ts";

export interface ListingSourceV2 {
  /** Canonical credential-free HTTPS Git repository URL (strict ASCII grammar). */
  readonly git: string;
  /**
   * Canonical repository-relative directory of the module this listing is
   * about. `.` is the repository root module. Absent when the catalog names no
   * module, which leaves the module choice to the installer's own scan.
   */
  readonly path?: string;
}

/** Parse an untrusted v2 source into its one canonical wire form. */
export function parseTcsV2ListingSource(
  input: unknown,
): ListingSourceV2 | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const source = input as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => key !== "git" && key !== "path") ||
    typeof source.git !== "string" ||
    ("path" in source && typeof source.path !== "string")
  ) {
    return undefined;
  }
  const git = canonicalTcsGitUrl(source.git);
  if (!git) return undefined;
  if (!("path" in source)) return { git };
  const path = canonicalTcsModulePath(source.path as string);
  return path ? { git, path } : undefined;
}

/** Canonical URL identity used for v2 cross-server de-duplication. */
export function tcsV2ListingSourceIdentity(input: unknown): string | undefined {
  return parseTcsV2ListingSource(input)?.git;
}

// Short aliases make the v2 parser convenient for implementers while keeping
// the protocol-specific names available for conformance tests.
export const parseListingSourceV2 = parseTcsV2ListingSource;
export const listingSourceIdentityV2 = tcsV2ListingSourceIdentity;
export const parseTcsListingSourceV2 = parseTcsV2ListingSource;
export const tcsListingSourceIdentityV2 = tcsV2ListingSourceIdentity;
export const canonicalTcsV2GitUrl = canonicalTcsGitUrl;
