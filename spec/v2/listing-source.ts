/**
 * TCS 2.0 listing source.
 *
 * A v2 source identifies a repository only.  A Store is a discovery catalog,
 * not an installer, so module paths, refs, commits, and install configuration
 * do not belong on this wire shape.
 */

import { canonicalTcsGitUrl } from "../listing-source.ts";

export interface ListingSourceV2 {
  /** Canonical credential-free HTTPS Git repository URL (strict ASCII grammar). */
  readonly git: string;
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
    Object.keys(source).some((key) => key !== "git") ||
    typeof source.git !== "string"
  ) {
    return undefined;
  }
  const git = canonicalTcsGitUrl(source.git);
  return git ? { git } : undefined;
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
