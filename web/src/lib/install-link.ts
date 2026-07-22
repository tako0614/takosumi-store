/**
 * Install handoff — build a public Takos `/install?...` deep-link from a
 * Listing. The Takos dashboard parses this query to PRE-FILL its add flow
 * (parseInstallPrefill in takosumi/dashboard/src/lib/install-link.ts); nothing
 * installs from the URL — the visitor confirms on their own Takos dashboard,
 * runs the compatibility check, and clicks install. There is no server call:
 * this is a plain cross-site link the user opens against their own Takos origin.
 *
 * The query fields mirror the parser exactly: git / path / name. The Store
 * intentionally does not choose a ref/tag/commit; Takosumi's install flow and
 * the repository source contract own version selection.
 */
import type { Listing } from "../../../spec/listing.ts";

export function buildInstallUrl(takosOrigin: string, listing: Listing): string {
  const base = takosOrigin.replace(/\/+$/, "");
  const url = new URL(`${base}/install`);
  url.searchParams.set("git", listing.source.git);
  if (listing.source.path) url.searchParams.set("path", listing.source.path);
  // name is capped at 96 chars by the parser.
  url.searchParams.set("name", listing.suggestedName.slice(0, 96));
  return url.toString();
}
