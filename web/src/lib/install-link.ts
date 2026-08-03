/**
 * Install handoff — build a public Takos `/install?...` deep-link from a
 * Listing. The Takos dashboard parses this query to PRE-FILL its add flow
 * (parseInstallPrefill in takosumi/dashboard/src/lib/install-link.ts); nothing
 * installs from the URL — the visitor confirms on their own Takos dashboard,
 * runs the compatibility check, and clicks install. There is no server call:
 * this is a plain cross-site link the user opens against their own Takos origin.
 *
 * v2 handoff fields are deliberately git / name only. The legacy v1 overload
 * still emits `path` for old callers; the Store UI and all v2 links use the
 * URL-only branch below.
 */
import type { Listing } from "../../../spec/listing.ts";
import type { ListingV2 } from "../../../spec/v2/listing.ts";

export function buildInstallUrl(
  takosOrigin: string,
  listing: Listing | ListingV2,
): string {
  const base = takosOrigin.replace(/\/+$/, "");
  const url = new URL(`${base}/install`);
  url.searchParams.set("git", listing.source.git);
  if ("path" in listing.source && listing.source.path) {
    url.searchParams.set("path", listing.source.path);
  }
  // name is capped at 96 chars by the parser.
  url.searchParams.set("name", listing.suggestedName.slice(0, 96));
  return url.toString();
}
