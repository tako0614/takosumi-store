/**
 * Typed fetch wrapper over the OPEN TCS read spec, scoped to one server base
 * url. This is the only place the client talks to a store node; aggregation
 * (aggregate.ts) fans these calls out across many bases. There is never any
 * server-to-server traffic.
 */
import type { Listing } from "../../../spec/listing.ts";
import type { ListingsPage, ListSort } from "../../../spec/api.ts";
import type { ServerInfo } from "../../../spec/server-info.ts";

export interface PageQuery {
  readonly sort?: ListSort;
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly scope?: string;
  readonly tag?: string;
  readonly signal?: AbortSignal;
}

/** Marker thrown when a node does not implement search (501 not_implemented). */
export class NotSupportedError extends Error {}

function joinBase(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${path}`;
}

export async function fetchServerInfo(
  base: string,
  signal?: AbortSignal,
): Promise<ServerInfo> {
  const res = await fetch(joinBase(base, "/.well-known/tcs"), {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`server-info ${res.status}`);
  return (await res.json()) as ServerInfo;
}

export async function fetchListingsPage(
  base: string,
  query: PageQuery = {},
): Promise<ListingsPage> {
  const params = new URLSearchParams();
  if (query.sort) params.set("sort", query.sort);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.scope) params.set("scope", query.scope);
  if (query.tag) params.set("tag", query.tag);
  const path = query.q
    ? `/tcs/v1/listings/search?q=${encodeURIComponent(query.q)}&${params}`
    : `/tcs/v1/listings?${params}`;
  const res = await fetch(joinBase(base, path), {
    headers: { accept: "application/json" },
    signal: query.signal,
  });
  if (res.status === 501) throw new NotSupportedError("search not supported");
  if (!res.ok) throw new Error(`listings ${res.status}`);
  return (await res.json()) as ListingsPage;
}

export async function fetchListing(
  base: string,
  id: string,
  signal?: AbortSignal,
): Promise<Listing | null> {
  const res = await fetch(
    joinBase(base, `/tcs/v1/listings/${encodeURIComponent(id)}`),
    { headers: { accept: "application/json" }, signal },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`listing ${res.status}`);
  return (await res.json()) as Listing;
}

/** Canonical get by `scope/slug` (the two-segment endpoint). */
export async function fetchListingByScopeSlug(
  base: string,
  scope: string,
  slug: string,
  signal?: AbortSignal,
): Promise<Listing | null> {
  const path = `/tcs/v1/listings/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}`;
  const res = await fetch(joinBase(base, path), {
    headers: { accept: "application/json" },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`listing ${res.status}`);
  return (await res.json()) as Listing;
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
  const path = `/tcs/v1/listings/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/readme`;
  const res = await fetch(joinBase(base, path), {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as ListingReadme;
}
