/**
 * Install handoff — build a public Takos `/install?...` deep-link from a
 * Listing. The Takos dashboard parses this query to PRE-FILL its add flow
 * (parseInstallPrefill in takosumi/dashboard/src/lib/install-link.ts); nothing
 * installs from the URL — the visitor confirms on their own Takos dashboard,
 * runs the compatibility check, and clicks install. There is no server call:
 * this is a plain cross-site link the user opens against their own Takos origin.
 *
 * The handoff carries the repository, the display name, and — when the listing
 * reviewed one non-root module — that module path. A listing that reviews the
 * repository root emits no `path`, which leaves the module choice to the
 * installer's own scan. The legacy v1 overload always carried a path; the
 * branch below covers both shapes.
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
