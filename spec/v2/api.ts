/** TCS 2.0 read API request and response types. */

import type { Page } from "../pagination.ts";
import type { ListingV2 } from "./listing.ts";
import { TCS_V2_API_PREFIX } from "./version.ts";

export { TCS_V2_API_PREFIX } from "./version.ts";

export type ListListingsV2Query = {
  readonly limit?: number;
  readonly cursor?: string;
  readonly category?: string;
  readonly scope?: string;
  readonly sort?: "updated" | "created";
  readonly locale?: "ja" | "en";
};
export type ListingsPageV2 = Page<ListingV2>;

/** Canonical v2 paths. IDs may also be addressed as `scope/slug`. */
export const TCS_V2_LISTINGS_PATH = `${TCS_V2_API_PREFIX}/listings` as const;
export const TCS_V2_SEARCH_PATH = `${TCS_V2_LISTINGS_PATH}/search` as const;
