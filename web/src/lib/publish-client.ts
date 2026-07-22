import type { Listing } from "../../../spec/listing.ts";

export interface PublishBody {
  source: { git: string; path: string };
  /** Optional explicit slug; defaults to one derived from suggestedName. */
  slug?: string;
  kind: string;
  surface: string;
  provider: string;
  /** Free-form browse tags; the server derives `category` from tags[0]. */
  tags?: string[];
  /** Legacy single facet; optional now that `tags` is the publisher taxonomy. */
  category?: string;
  suggestedName: string;
  name: { ja: string; en: string };
  description: { ja: string; en: string };
  badge: { ja: string; en: string };
  iconUrl?: string;
}

/** A publisher's own listing as returned by GET /publish/listings. */
export type OwnedListing = Listing & { status: "visible" | "hidden" };

/** Rebuild the publish body from a listing (for PATCH; setup lives in Git). */
export function bodyFromListing(l: Listing): PublishBody {
  return {
    source: {
      git: l.source.git,
      path: l.source.path ?? "",
    },
    kind: l.kind,
    surface: l.surface,
    provider: l.provider,
    tags: [...l.tags],
    ...(l.category ? { category: l.category } : {}),
    suggestedName: l.suggestedName,
    name: { ...l.name },
    description: { ...l.description },
    badge: { ...l.badge },
    ...(l.iconUrl ? { iconUrl: l.iconUrl } : {}),
  };
}

export type PublishResult =
  | { ok: true; listing: Listing; warnings: string[] }
  | { ok: false; status: number; message: string; errors?: string[] };

export async function createListing(body: PublishBody): Promise<PublishResult> {
  const res = await fetch("/publish/listings", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 201) {
    const data = (await res.json()) as {
      listing: Listing;
      warnings?: string[];
    };
    return { ok: true, listing: data.listing, warnings: data.warnings ?? [] };
  }
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string; details?: unknown };
  } | null;
  const details = data?.error?.details;
  return {
    ok: false,
    status: res.status,
    message: data?.error?.message ?? `error ${res.status}`,
    ...(Array.isArray(details) ? { errors: details as string[] } : {}),
  };
}

export async function listMine(): Promise<OwnedListing[]> {
  const res = await fetch("/publish/listings", { credentials: "same-origin" });
  if (!res.ok) return [];
  return ((await res.json()) as { listings: OwnedListing[] }).listings;
}

/** Path form for the 2-segment owner routes (`/publish/listings/:scope/:slug`). */
function ownerPath(id: string): string {
  return id
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Update (PATCH) an existing listing; setup and version selection stay in Git/Takosumi. */
export async function updateListing(
  id: string,
  body: PublishBody,
): Promise<PublishResult> {
  const res = await fetch(`/publish/listings/${ownerPath(id)}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const data = (await res.json()) as { listing: Listing };
    return { ok: true, listing: data.listing, warnings: [] };
  }
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string; details?: unknown };
  } | null;
  const details = data?.error?.details;
  return {
    ok: false,
    status: res.status,
    message: data?.error?.message ?? `error ${res.status}`,
    ...(Array.isArray(details) ? { errors: details as string[] } : {}),
  };
}

/** Toggle a listing between public (visible) and unlisted (hidden). */
export async function setVisibility(
  id: string,
  status: "visible" | "hidden",
): Promise<boolean> {
  const res = await fetch(`/publish/listings/${ownerPath(id)}/status`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  return res.ok;
}

/** Hard-delete a listing (`?hard=true`) or soft-hide it (default). */
export async function deleteListing(
  id: string,
  hard = false,
): Promise<boolean> {
  const res = await fetch(
    `/publish/listings/${ownerPath(id)}${hard ? "?hard=true" : ""}`,
    { method: "DELETE", credentials: "same-origin" },
  );
  return res.ok;
}
