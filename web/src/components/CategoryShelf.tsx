import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import type { AggregatedListing } from "../lib/aggregate.ts";
import type { Locale } from "../../../spec/api.ts";
import { t } from "../lib/i18n.ts";
import { AppCard } from "./AppCard.tsx";

/** A titled, horizontally scrolling row of apps (Google Play "shelf"). */
export const CategoryShelf: Component<{
  title: string;
  items: readonly AggregatedListing[];
  locale: Locale;
  onSeeAll?: () => void;
  seeAllLabel?: string;
}> = (props) => {
  let rowRef: HTMLDivElement | undefined;
  const [canPrev, setCanPrev] = createSignal(false);
  const [canNext, setCanNext] = createSignal(false);

  const syncScroll = () => {
    const el = rowRef;
    if (!el) return;
    setCanPrev(el.scrollLeft > 4);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  onMount(() => {
    syncScroll();
    window.addEventListener("resize", syncScroll);
    onCleanup(() => window.removeEventListener("resize", syncScroll));
  });

  createEffect(() => {
    void props.items.length;
    queueMicrotask(syncScroll);
  });

  const scrollByCards = (dir: -1 | 1) => {
    const el = rowRef;
    if (!el) return;
    const step = Math.max(240, Math.round(el.clientWidth * 0.75));
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  return (
    <section class="shelf">
      <div class="shelf-head">
        <h2 class="shelf-title">{props.title}</h2>
        <div class="shelf-head-right">
          <Show when={canPrev() || canNext()}>
            <div class="shelf-nav">
              <button
                type="button"
                class="shelf-nav-btn"
                aria-label={t("scrollPrev", props.locale)}
                disabled={!canPrev()}
                onClick={() => scrollByCards(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                class="shelf-nav-btn"
                aria-label={t("scrollNext", props.locale)}
                disabled={!canNext()}
                onClick={() => scrollByCards(1)}
              >
                ›
              </button>
            </div>
          </Show>
          <Show when={props.onSeeAll && props.seeAllLabel}>
            <button type="button" class="shelf-seeall" onClick={props.onSeeAll}>
              {props.seeAllLabel} ›
            </button>
          </Show>
        </div>
      </div>
      <div
        class="shelf-wrap"
        classList={{ "has-prev": canPrev(), "has-next": canNext() }}
      >
        <div ref={rowRef} class="shelf-row" onScroll={syncScroll}>
          <For each={props.items}>
            {(item) => <AppCard listing={item} locale={props.locale} compact />}
          </For>
        </div>
      </div>
    </section>
  );
};
