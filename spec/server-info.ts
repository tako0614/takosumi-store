/**
 * ServerInfo — a TCS node's self-description. Served at the stable well-known
 * path `/.well-known/tcs` (and aliased at `/tcs/v1/server-info`). nodeinfo in
 * spirit, but plain TCS JSON. This is how a single server is self-describing and
 * how a client learns the facet space (categories / kinds / providers) and
 * optional capabilities before querying or merging.
 */
import type { TcsCapability } from "./version.ts";
import type { ListingKind } from "./listing.ts";

export interface ServerFacetCount {
  readonly key: string;
  readonly count: number;
}

export interface ServerInfo {
  readonly spec: {
    readonly version: string;
    readonly capabilities: readonly TcsCapability[];
  };
  readonly server: {
    /** Human label for this node. */
    readonly name: string;
    readonly software: { readonly name: string; readonly version: string };
    /** Canonical base url for `/tcs/v1` (lets a client de-dup itself). */
    readonly baseUrl: string;
  };
  readonly listings: { readonly count: number };
  readonly categories: readonly ServerFacetCount[];
  readonly kinds: readonly {
    readonly key: ListingKind;
    readonly count: number;
  }[];
  readonly providers: readonly ServerFacetCount[];
  readonly contact?: { readonly admin?: string; readonly url?: string };
  readonly defaultLocale?: "ja" | "en";
}
