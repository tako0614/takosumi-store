import type { ListSort, Locale } from "../../../spec/api.ts";
import { sortItems, type AggregatedListing } from "./aggregate.ts";
import { tagLabel } from "./i18n.ts";

export interface CatalogFilterOptions {
  readonly query: string;
  readonly tag: string;
  readonly sort: ListSort;
  readonly locale: Locale;
}

/**
 * Pure client-side catalog filter & sort over already-loaded TCS listings.
 * TCS v2 deliberately keeps server-side search unsupported, so filtering runs
 * locally without issuing extra network requests.
 */
export function filterCatalog(
  items: readonly AggregatedListing[],
  opts: CatalogFilterOptions,
): AggregatedListing[] {
  const q = opts.query.trim().toLowerCase();
  const tag = opts.tag.trim();
  const matched = items.filter((item) => {
    if (tag && !(item.tags ?? []).includes(tag)) return false;
    if (!q) return true;
    const haystacks = [
      item.name.ja,
      item.name.en,
      item.description.ja,
      item.description.en,
      item.scope,
      item.slug,
      item.id,
      item.category ?? "",
      ...(item.tags ?? []),
      ...(item.tags ?? []).map((tg) => tagLabel(tg, opts.locale)),
    ];
    return haystacks.some((value) => value.toLowerCase().includes(q));
  });
  return sortItems(matched, opts.sort, opts.locale);
}

/** Normalize URL `sort` param to a supported catalog sort value. */
export function normalizeCatalogSort(raw: string | undefined): ListSort {
  return raw === "name" ? "name" : "updated";
}
