import type { StoreDb } from "../db/client.ts";
import { facetCounts, facetCountsV2 } from "../db/listings-store.ts";
import type { ServerInfo } from "../../../spec/server-info.ts";
import type { ListingKind } from "../../../spec/listing.ts";
import type { TcsCapability } from "../../../spec/version.ts";
import {
  TCS_ADVERTISED_VERSIONS,
  TCS_SPEC_VERSION,
} from "../../../spec/version.ts";
import type { ServerInfoV2 } from "../../../spec/v2/server-info.ts";
import type { TcsV2Capability } from "../../../spec/v2/version.ts";
import { TCS_V2_SPEC_VERSION } from "../../../spec/v2/version.ts";
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
  "icons",
];

export async function buildServerInfo(
  db: StoreDb,
  baseUrl: string,
): Promise<ServerInfo> {
  const facets = await facetCounts(db);
  return {
    spec: {
      version: TCS_SPEC_VERSION,
      capabilities: OFFICIAL_CAPABILITIES,
      versions: TCS_ADVERTISED_VERSIONS,
    },
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

export const OFFICIAL_V2_CAPABILITIES: readonly TcsV2Capability[] = [
  "filter.category",
  "filter.scope",
  "sort.updated",
  "sort.created",
  "icons",
];

/** Build the explicit v2 server-info response (v1 remains unchanged). */
export async function buildServerInfoV2(
  db: StoreDb,
  baseUrl: string,
): Promise<ServerInfoV2> {
  const facets = await facetCountsV2(db);
  return {
    spec: {
      version: TCS_V2_SPEC_VERSION,
      capabilities: OFFICIAL_V2_CAPABILITIES,
      compatibleVersions: [TCS_SPEC_VERSION],
    },
    server: {
      name: STORE_DEFAULT_NAME,
      software: { name: STORE_SOFTWARE_NAME, version: STORE_VERSION },
      baseUrl,
    },
    listings: { count: facets.total },
    categories: facets.categories,
    defaultLocale: "ja",
  };
}
