import {
  createEffect,
  createMemo,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { useSearchParams } from "@solidjs/router";
import type { ListSort } from "../../../spec/api.ts";
import {
  agg,
  ensureListings,
  loadError,
  loadMoreItems,
  locale,
  rebuild,
} from "../appstate.ts";
import { filterCatalog, normalizeCatalogSort } from "../lib/catalog-filter.ts";
import { tagLabel, t } from "../lib/i18n.ts";
import { AppCard } from "../components/AppCard.tsx";
import { CategoryShelf } from "../components/CategoryShelf.tsx";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/states.tsx";

const SHELF_MIN_TOTAL = 12;

function paramStr(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export const HomePage: Component = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  let searchInputRef: HTMLInputElement | undefined;

  const fTag = () => paramStr(searchParams.tag);
  const fQuery = () => paramStr(searchParams.q);
  const fSort = (): ListSort =>
    normalizeCatalogSort(paramStr(searchParams.sort));

  const setFTag = (tag: string) =>
    setSearchParams({ tag: tag || undefined }, { replace: true });
  const setFQuery = (q: string) =>
    setSearchParams({ q: q || undefined }, { replace: true });
  const setFSort = (sort: ListSort) =>
    setSearchParams(
      { sort: sort === "updated" ? undefined : sort },
      { replace: true },
    );
  const resetFilters = () =>
    setSearchParams({ tag: undefined, q: undefined }, { replace: true });

  onMount(() => {
    ensureListings();
    const onGlobalKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (searchInputRef) {
        e.preventDefault();
        searchInputRef.focus();
      }
    };
    window.addEventListener("keydown", onGlobalKey);
    onCleanup(() => window.removeEventListener("keydown", onGlobalKey));
  });

  createEffect(() => {
    document.title = t("appName", locale());
  });

  const facetTags = createMemo(() => {
    const set = new Set<string>();
    for (const it of agg().items) for (const tg of it.tags ?? []) set.add(tg);
    return [...set].sort();
  });

  const displayed = createMemo(() =>
    filterCatalog(agg().items, {
      query: fQuery(),
      tag: fTag(),
      sort: fSort(),
      locale: locale(),
    }),
  );

  const filtersActive = () => Boolean(fTag() || fQuery().trim());
  const showShelf = () =>
    !filtersActive() &&
    fSort() === "updated" &&
    agg().items.length >= SHELF_MIN_TOTAL;
  const recent = createMemo(() => agg().items.slice(0, 12));

  const firstLoad = () => agg().loading && agg().items.length === 0;

  return (
    <main id="main" tabIndex={-1} class="page home">
      <div class="container">
        <header class="home-head">
          <h1 class="home-title">{t("apps", locale())}</h1>
          <p class="home-subtitle muted">{t("storeSubtitle", locale())}</p>
        </header>

        <Show when={agg().items.length > 0 || !firstLoad()}>
          <div class="catalog-controls">
            <div class="catalog-toolbar">
              <div class="search-field">
                <label class="sr-only" for="catalog-search">
                  {t("searchLabel", locale())}
                </label>
                <input
                  ref={searchInputRef}
                  id="catalog-search"
                  type="search"
                  class="search-input"
                  value={fQuery()}
                  placeholder={t("searchPlaceholder", locale())}
                  autocomplete="off"
                  spellcheck={false}
                  onInput={(e) => setFQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && fQuery()) {
                      e.preventDefault();
                      setFQuery("");
                    }
                  }}
                />
                <Show when={fQuery()}>
                  <button
                    type="button"
                    class="search-clear"
                    aria-label={t("clearSearch", locale())}
                    onClick={() => {
                      setFQuery("");
                      searchInputRef?.focus();
                    }}
                  >
                    ×
                  </button>
                </Show>
              </div>

              <div
                class="sort-toggle"
                role="group"
                aria-label={t("sortLabel", locale())}
              >
                <button
                  type="button"
                  class="sort-btn"
                  classList={{ active: fSort() === "updated" }}
                  aria-pressed={fSort() === "updated"}
                  onClick={() => setFSort("updated")}
                >
                  {t("sortUpdated", locale())}
                </button>
                <button
                  type="button"
                  class="sort-btn"
                  classList={{ active: fSort() === "name" }}
                  aria-pressed={fSort() === "name"}
                  onClick={() => setFSort("name")}
                >
                  {t("sortName", locale())}
                </button>
              </div>
            </div>

            <Show when={facetTags().length > 0}>
              <div
                class="chips"
                role="group"
                aria-label={t("tagFilters", locale())}
              >
                <button
                  type="button"
                  class="chip"
                  classList={{ active: !fTag() }}
                  aria-pressed={!fTag()}
                  onClick={() => setFTag("")}
                >
                  {t("all", locale())}
                </button>
                <For each={facetTags()}>
                  {(tg) => (
                    <button
                      type="button"
                      class="chip"
                      classList={{ active: fTag() === tg }}
                      aria-pressed={fTag() === tg}
                      onClick={() => setFTag(fTag() === tg ? "" : tg)}
                    >
                      {tagLabel(tg, locale())}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={filtersActive() && !firstLoad() && !loadError()}>
          <div class="results-bar" aria-live="polite">
            <span class="results-summary muted">
              {locale() === "ja"
                ? `${displayed().length}${t("resultsCount", locale())}`
                : `${displayed().length} ${t("resultsCount", locale())}`}
            </span>
            <button type="button" class="linklike" onClick={resetFilters}>
              {t("resetFilters", locale())}
            </button>
          </div>
        </Show>

        <Show when={firstLoad()}>
          <SkeletonGrid count={8} />
        </Show>

        <Show when={!firstLoad() && loadError() && agg().items.length === 0}>
          <ErrorState
            title={t("errorTitle", locale())}
            message={t("errorHint", locale())}
            retryLabel={t("retry", locale())}
            onRetry={() => void rebuild()}
          />
        </Show>

        <Show when={!firstLoad() && !loadError() && displayed().length === 0}>
          <EmptyState
            title={t("noResults", locale())}
            message={t("noResultsHint", locale())}
            action={
              <Show when={filtersActive()}>
                <button
                  type="button"
                  class="btn btn-secondary"
                  onClick={resetFilters}
                >
                  {t("resetFilters", locale())}
                </button>
              </Show>
            }
          />
        </Show>

        <Show when={showShelf()}>
          <CategoryShelf
            title={t("recentlyAdded", locale())}
            items={recent()}
            locale={locale()}
          />
        </Show>

        <Show when={displayed().length > 0}>
          <section class="app-grid" aria-label={t("apps", locale())}>
            <For each={displayed()}>
              {(listing) => <AppCard listing={listing} locale={locale()} />}
            </For>
          </section>
        </Show>

        <Show when={!agg().done && !filtersActive() && agg().items.length > 0}>
          <div class="loadmore">
            <button
              type="button"
              class="btn btn-secondary"
              disabled={agg().loading}
              onClick={() => void loadMoreItems()}
            >
              {agg().loading ? t("loading", locale()) : t("loadMore", locale())}
            </button>
          </div>
        </Show>
      </div>
    </main>
  );
};
