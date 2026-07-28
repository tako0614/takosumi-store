import type { ListingSource } from "../spec/listing-source.ts";

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
