import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import type { ListSort } from "../../../spec/api.ts";
import {
  agg,
  ensureListings,
  loadError,
  loadMoreItems,
  locale,
  me,
  rebuild,
} from "../appstate.ts";
import { filterCatalog, normalizeCatalogSort } from "../lib/catalog-filter.ts";
import { tagLabel, t } from "../lib/i18n.ts";
import { setPageTitle } from "../lib/nav-history.ts";
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
  let chipsRef: HTMLDivElement | undefined;
  let composing = false;
  const [chipsCanPrev, setChipsCanPrev] = createSignal(false);
  const [chipsCanNext, setChipsCanNext] = createSignal(false);

  const syncChipsScroll = () => {
    const el = chipsRef;
    if (!el) return;
    setChipsCanPrev(el.scrollLeft > 4);
    setChipsCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

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
      if (
        e.isComposing ||
        e.keyCode === 229 ||
        e.defaultPrevented ||
        e.key !== "/" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      ) {
        return;
      }
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
        searchInputRef.select();
      }
    };
    window.addEventListener("keydown", onGlobalKey);
    window.addEventListener("resize", syncChipsScroll);
    onCleanup(() => {
      window.removeEventListener("keydown", onGlobalKey);
      window.removeEventListener("resize", syncChipsScroll);
    });
  });

  createEffect(() => {
    setPageTitle(t("appName", locale()));
  });

  createEffect(() => {
    const q = fQuery();
    if (!composing && searchInputRef && searchInputRef.value !== q) {
      searchInputRef.value = q;
    }
  });

  const facetTags = createMemo(() => {
    const set = new Set<string>();
    for (const it of agg().items) for (const tg of it.tags ?? []) set.add(tg);
    const active = fTag().trim();
    if (active) set.add(active);
    return [...set].sort();
  });

  // Keep mobile tag-strip edge fades in sync and reveal deep-linked active chips.
  createEffect(() => {
    const active = fTag();
    void facetTags().length;
    void locale();
    queueMicrotask(() => {
      const el = chipsRef;
      if (!el) return;
      if (active && el.scrollWidth > el.clientWidth + 4) {
        el.querySelector<HTMLButtonElement>(".chip.active")?.scrollIntoView({
          inline: "nearest",
          block: "nearest",
        });
      }
      syncChipsScroll();
    });
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

        <Show when={agg().items.length > 0 || filtersActive()}>
          <div class="catalog-controls">
            <div class="catalog-toolbar">
              <div class="search-field">
                <label class="sr-only" for="catalog-search">
                  {t("searchLabel", locale())}
                </label>
                <input
                  ref={(el) => {
                    searchInputRef = el;
                    el.value = fQuery();
                  }}
                  id="catalog-search"
                  name="q"
                  type="search"
                  class="search-input"
                  placeholder={t("searchPlaceholder", locale())}
                  autocomplete="off"
                  spellcheck={false}
                  onCompositionStart={() => {
                    composing = true;
                  }}
                  onCompositionEnd={(e) => {
                    composing = false;
                    setFQuery(e.currentTarget.value);
                  }}
                  onInput={(e) => {
                    if (!e.isComposing && !composing) {
                      setFQuery(e.currentTarget.value);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.isComposing || e.keyCode === 229) return;
                    if (
                      e.key === "Escape" &&
                      (fQuery() || e.currentTarget.value)
                    ) {
                      e.preventDefault();
                      e.currentTarget.value = "";
                      setFQuery("");
                    }
                  }}
                />
                <Show
                  when={fQuery()}
                  fallback={
                    <kbd class="search-kbd" aria-hidden="true">
                      /
                    </kbd>
                  }
                >
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
                class="chips-wrap"
                classList={{
                  "has-prev": chipsCanPrev(),
                  "has-next": chipsCanNext(),
                }}
              >
                <div
                  ref={chipsRef}
                  class="chips"
                  role="group"
                  aria-label={t("tagFilters", locale())}
                  onScroll={syncChipsScroll}
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
              </div>
            </Show>
          </div>
        </Show>

        <Show
          when={
            filtersActive() &&
            !firstLoad() &&
            !(loadError() && agg().items.length === 0)
          }
        >
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
          <SkeletonGrid count={8} label={t("loading", locale())} />
        </Show>

        <Show when={!firstLoad() && loadError() && agg().items.length === 0}>
          <ErrorState
            title={t("errorTitle", locale())}
            message={t("errorHint", locale())}
            retryLabel={t("retry", locale())}
            onRetry={() => void rebuild()}
          />
        </Show>

        <Show
          when={
            !firstLoad() &&
            !(loadError() && agg().items.length === 0) &&
            displayed().length === 0
          }
        >
          <Show
            when={filtersActive() || agg().items.length > 0}
            fallback={
              <EmptyState
                glyph="📦"
                title={t("emptyCatalogTitle", locale())}
                message={t("emptyCatalogHint", locale())}
                action={
                  <Show when={me()}>
                    <A href="/publish" class="btn btn-primary">
                      {t("publishFirst", locale())}
                    </A>
                  </Show>
                }
              />
            }
          >
            <EmptyState
              title={t("noResults", locale())}
              message={
                !agg().done && !loadError() && filtersActive()
                  ? t("partialResultsHint", locale())
                  : t("noResultsHint", locale())
              }
              action={
                <Show when={filtersActive()}>
                  <div class="state-actions">
                    <Show when={!agg().done && !loadError()}>
                      <button
                        type="button"
                        class="btn btn-primary"
                        disabled={agg().loading}
                        onClick={() => void loadMoreItems()}
                      >
                        {agg().loading
                          ? t("loading", locale())
                          : t("loadMoreMatches", locale())}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="btn btn-secondary"
                      onClick={resetFilters}
                    >
                      {t("resetFilters", locale())}
                    </button>
                  </div>
                </Show>
              }
            />
          </Show>
        </Show>

        <Show when={showShelf()}>
          <CategoryShelf
            title={t("recentlyAdded", locale())}
            items={recent()}
            locale={locale()}
          />
          <h2 class="shelf-title grid-heading">{t("allApps", locale())}</h2>
        </Show>

        <Show when={displayed().length > 0}>
          <section class="app-grid" aria-label={t("apps", locale())}>
            <For each={displayed()}>
              {(listing) => <AppCard listing={listing} locale={locale()} />}
            </For>
          </section>
        </Show>

        <Show when={!firstLoad() && loadError() && agg().items.length > 0}>
          <div class="inline-error-bar" role="alert">
            <span>{t("loadMoreFailed", locale())}</span>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={agg().loading}
              onClick={() => void loadMoreItems()}
            >
              {agg().loading ? t("loading", locale()) : t("retry", locale())}
            </button>
          </div>
        </Show>

        <Show
          when={
            !agg().done &&
            !loadError() &&
            agg().items.length > 0 &&
            displayed().length > 0
          }
        >
          <div class="loadmore">
            <Show when={filtersActive()}>
              <p class="loadmore-hint muted">
                {t("partialResultsHint", locale())}
              </p>
            </Show>
            <button
              type="button"
              class="btn btn-secondary"
              disabled={agg().loading}
              onClick={() => void loadMoreItems()}
            >
              {agg().loading
                ? t("loading", locale())
                : filtersActive()
                  ? t("loadMoreMatches", locale())
                  : t("loadMore", locale())}
            </button>
          </div>
        </Show>
      </div>
    </main>
  );
};
