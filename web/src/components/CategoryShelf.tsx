import { For, Show, type Component } from "solid-js";
import type { AggregatedListing } from "../lib/aggregate.ts";
import type { Locale } from "../../../spec/api.ts";
import { AppCard } from "./AppCard.tsx";

/** A titled, horizontally scrolling row of apps (Google Play "shelf"). */
export const CategoryShelf: Component<{
  title: string;
  items: readonly AggregatedListing[];
  locale: Locale;
  onSeeAll?: () => void;
  seeAllLabel?: string;
}> = (props) => {
  return (
    <section class="shelf">
      <div class="shelf-head">
        <h2 class="shelf-title">{props.title}</h2>
        <Show when={props.onSeeAll && props.seeAllLabel}>
          <button type="button" class="shelf-seeall" onClick={props.onSeeAll}>
            {props.seeAllLabel} ›
          </button>
        </Show>
      </div>
      <div class="shelf-row">
        <For each={props.items}>
          {(item) => <AppCard listing={item} locale={props.locale} compact />}
        </For>
      </div>
    </section>
  );
};
