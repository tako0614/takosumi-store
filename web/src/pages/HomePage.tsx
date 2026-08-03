import {
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { agg, loadError, loadMoreItems, locale, rebuild } from "../appstate.ts";
import type { ListSort } from "../../../spec/api.ts";
import { tagLabel, t } from "../lib/i18n.ts";
import { AppCard } from "../components/AppCard.tsx";
import { CategoryShelf } from "../components/CategoryShelf.tsx";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/states.tsx";

const SHELF_MIN_TOTAL = 12;

export const HomePage: Component = () => {
  const [fTag, setFTag] = createSignal("");

  onMount(() => void rebuild());

  const facetTags = createMemo(() => {
    const set = new Set<string>();
    for (const it of agg().items) for (const tg of it.tags ?? []) set.add(tg);
    return [...set].sort();
  });
  const displayed = createMemo(() =>
    agg().items.filter((l) => !fTag() || (l.tags ?? []).includes(fTag())),
  );

  const filtersActive = () => Boolean(fTag());
  const showShelf = () =>
    !filtersActive() && agg().items.length >= SHELF_MIN_TOTAL;
  const recent = createMemo(() => agg().items.slice(0, 12));

  const onSort = (value: ListSort) => void rebuild({ sort: value });

  const firstLoad = () => agg().loading && agg().items.length === 0;

  return (
    <main class="page home">
      <div class="container">
        <Show when={agg().items.length > 0 || !firstLoad()}>
          <div class="filterbar">
            <div class="chips" role="tablist" aria-label="Tags">
              <button
                type="button"
                class="chip"
                classList={{ active: !fTag() }}
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
                    onClick={() => setFTag(fTag() === tg ? "" : tg)}
                  >
                    {tagLabel(tg, locale())}
                  </button>
                )}
              </For>
            </div>
            <div class="filterbar-right">
              <select
                class="sort"
                value={agg().sort}
                onChange={(e) => onSort(e.currentTarget.value as ListSort)}
                aria-label={t("sortUpdated", locale())}
              >
                <option value="updated">{t("sortUpdated", locale())}</option>
              </select>
            </div>
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
          <section class="app-grid">
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
