/** TCS 2.0 listing wire type: presentation metadata plus a Git URL only. */

import type { LocalizedText, ListingPublisher } from "../listing.ts";
import {
  tcsV2ListingSourceIdentity,
  type ListingSourceV2,
} from "./listing-source.ts";

export type { ListingSourceV2 } from "./listing-source.ts";

/**
 * v2 is intentionally smaller than the v1 implementation shape. A listing
 * is a Git repository discovery card; provider/kind/surface and all execution
 * coordinates remain legacy Store-internal/v1 compatibility data.
 */
export interface ListingV2 {
  readonly id: string;
  readonly scope: string;
  readonly slug: string;
  readonly source: ListingSourceV2;
  readonly suggestedName: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly badge: LocalizedText;
  readonly iconUrl?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly publisher?: ListingPublisher;
  readonly badges?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function listingIdentityV2(source: ListingSourceV2): string {
  return tcsV2ListingSourceIdentity(source) ?? source.git.trim();
}

/** Protocol spelling for implementers that prefer the TCS prefix. */
export const tcsV2ListingIdentity = listingIdentityV2;
