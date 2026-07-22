import type { StoreDb } from "../db/client.ts";
import { facetCounts } from "../db/listings-store.ts";
import type { ServerInfo } from "../../../spec/server-info.ts";
import type { ListingKind } from "../../../spec/listing.ts";
import type { TcsCapability } from "../../../spec/version.ts";
import { TCS_SPEC_VERSION } from "../../../spec/version.ts";
import {
  STORE_DEFAULT_NAME,
  STORE_SOFTWARE_NAME,
  STORE_VERSION,
} from "../version.ts";

/** Capabilities the official implementation advertises (it implements all). */
export const OFFICIAL_CAPABILITIES: readonly TcsCapability[] = [
  "search",
  "filter.category",
  "filter.kind",
  "filter.provider",
  "filter.surface",
  "sort.updated",
  "sort.created",
  "sort.name",
  "icons",
];

export async function buildServerInfo(
  db: StoreDb,
  baseUrl: string,
): Promise<ServerInfo> {
  const facets = await facetCounts(db);
  return {
    spec: { version: TCS_SPEC_VERSION, capabilities: OFFICIAL_CAPABILITIES },
    server: {
      name: STORE_DEFAULT_NAME,
      software: { name: STORE_SOFTWARE_NAME, version: STORE_VERSION },
      baseUrl,
    },
    listings: { count: facets.total },
    categories: facets.categories,
    kinds: facets.kinds.map((k) => ({
      key: k.key as ListingKind,
      count: k.count,
    })),
    providers: facets.providers,
    defaultLocale: "ja",
  };
}
