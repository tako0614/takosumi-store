import type { ListingSource } from "../spec/listing-source.ts";

const PRESENTATION_KEYS = [
  "category",
  "tags",
  "suggestedName",
  "name",
  "description",
  "badge",
] as const;

const MODULE_KEYS = ["kind", "surface", "provider"] as const;

/**
 * Official listing manifests own their Git coordinate. Repository metadata
 * fetched from a mutable remote HEAD may enrich presentation only; it cannot
 * redirect the module selected by the reviewed manifest.
 */
export function officialListingSource(
  manifest: ListingSource,
  _repositoryMetadata: Readonly<Record<string, unknown>>,
): ListingSource {
  return { git: manifest.git, path: manifest.path };
}

/**
 * Repository metadata describes one module selected by `modulePath`. Generic
 * presentation may enrich every listing from that repository, but deployment
 * semantics only apply when the official listing selects that exact module.
 *
 * This prevents a repository's root/self-host provider (for example
 * Cloudflare) from overwriting an alternate managed module (for example
 * `deploy/takoform`) in the Store.
 */
export function officialListingMetadataOverrides(
  manifest: ListingSource,
  repositoryMetadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of PRESENTATION_KEYS) {
    if (repositoryMetadata[key] !== undefined) {
      out[key] = repositoryMetadata[key];
    }
  }
  if (repositoryMetadata.modulePath === manifest.path) {
    for (const key of MODULE_KEYS) {
      if (repositoryMetadata[key] !== undefined) {
        out[key] = repositoryMetadata[key];
      }
    }
  }
  return out;
}
