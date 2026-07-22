import { Show, type Component } from "solid-js";
import { A } from "@solidjs/router";
import type { Listing } from "../../../spec/listing.ts";
import type { Locale } from "../../../spec/api.ts";
import { kindLabel, pick, tagLabel } from "../lib/i18n.ts";
import { IconTile } from "./IconTile.tsx";

/**
 * One app in the grid or a shelf. Icon-forward (Google Play style); the whole
 * card is a link to the detail page. `compact` shelf cards drop the description.
 */
export const AppCard: Component<{
  listing: Listing;
  locale: Locale;
  compact?: boolean;
}> = (props) => {
  const l = () => props.listing;
  // Prefer the publisher's tags; fall back to the kind when none were set.
  const sub = () => {
    const tags = l().tags;
    if (tags.length > 0) {
      return tags
        .slice(0, 3)
        .map((x) => tagLabel(x, props.locale))
        .join(" · ");
    }
    return kindLabel(l().kind, props.locale);
  };
  return (
    <A
      href={`/${encodeURIComponent(l().scope)}/${encodeURIComponent(l().slug)}`}
      class="app-card"
      classList={{ "app-card-compact": props.compact }}
    >
      <IconTile
        label={pick(l().name, props.locale)}
        seed={l().id}
        iconUrl={l().iconUrl}
        size={props.compact ? 52 : 60}
      />
      <div class="app-card-text">
        <span class="app-card-name">{pick(l().name, props.locale)}</span>
        <span class="app-card-sub">{sub()}</span>
        <Show when={!props.compact}>
          <span class="app-card-desc">
            {pick(l().description, props.locale)}
          </span>
        </Show>
      </div>
    </A>
  );
};
