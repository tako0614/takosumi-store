/**
 * Typed fetch wrapper over the OPEN TCS read spec, scoped to one server base
 * url. This is the only place the client talks to a store node; aggregation
 * (aggregate.ts) fans these calls out across many bases. There is never any
 * server-to-server traffic.
 */
import type { ListSort } from "../../../spec/api.ts";
import type { ListingsPageV2 } from "../../../spec/v2/api.ts";
import type { ListingV2 } from "../../../spec/v2/listing.ts";
import type { ServerInfoV2 } from "../../../spec/v2/server-info.ts";

export interface PageQuery {
  readonly sort?: ListSort;
  readonly cursor?: string;
  readonly limit?: number;
  readonly scope?: string;
  readonly signal?: AbortSignal;
}

/** Marker thrown when a node does not implement an optional capability. */
export class NotSupportedError extends Error {}

function joinBase(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${path}`;
}

export async function fetchServerInfo(
  base: string,
  signal?: AbortSignal,
): Promise<ServerInfoV2> {
  const res = await fetch(joinBase(base, "/tcs/v2/server-info"), {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`server-info ${res.status}`);
  return (await res.json()) as ServerInfoV2;
}

export async function fetchListingsPage(
  base: string,
  query: PageQuery = {},
): Promise<ListingsPageV2> {
  const params = new URLSearchParams();
  if (query.sort) params.set("sort", query.sort);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.scope) params.set("scope", query.scope);
  const path = `/tcs/v2/listings?${params}`;
  const res = await fetch(joinBase(base, path), {
    headers: { accept: "application/json" },
    signal: query.signal,
  });
  if (res.status === 501)
    throw new NotSupportedError("optional capability not supported");
  if (!res.ok) throw new Error(`listings ${res.status}`);
  return (await res.json()) as ListingsPageV2;
}

export async function fetchListing(
  base: string,
  id: string,
  signal?: AbortSignal,
): Promise<ListingV2 | null> {
  const res = await fetch(
    joinBase(base, `/tcs/v2/listings/${encodeURIComponent(id)}`),
    { headers: { accept: "application/json" }, signal },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`listing ${res.status}`);
  return (await res.json()) as ListingV2;
}

/** Canonical get by `scope/slug` (the two-segment endpoint). */
export async function fetchListingByScopeSlug(
  base: string,
  scope: string,
  slug: string,
  signal?: AbortSignal,
): Promise<ListingV2 | null> {
  const path = `/tcs/v2/listings/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}`;
  const res = await fetch(joinBase(base, path), {
    headers: { accept: "application/json" },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`listing ${res.status}`);
  return (await res.json()) as ListingV2;
}

export interface ListingReadme {
  readonly markdown: string;
  readonly sourceUrl: string;
}

/** Fetch the source repo's README for a listing (null when none is served). */
export async function fetchListingReadme(
  base: string,
  scope: string,
  slug: string,
  signal?: AbortSignal,
): Promise<ListingReadme | null> {
  const path = `/tcs/v2/listings/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/readme`;
  const res = await fetch(joinBase(base, path), {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as ListingReadme;
}
