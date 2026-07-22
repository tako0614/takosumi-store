import { createResource, For, Show, type Component } from "solid-js";
import { A, useParams } from "@solidjs/router";
import { locale } from "../appstate.ts";
import { homeBase } from "../lib/servers.ts";
import { fetchListingsPage } from "../lib/tcs-client.ts";
import { t } from "../lib/i18n.ts";
import { AppCard } from "../components/AppCard.tsx";
import { EmptyState, SkeletonGrid } from "../components/states.tsx";

/** A publisher namespace page — all apps under one `scope`. */
export const ScopePage: Component = () => {
  const params = useParams();
  const [page] = createResource(
    () => params.scope,
    (scope: string) =>
      fetchListingsPage(homeBase(), { scope, sort: "updated", limit: 100 }),
  );
  const items = () => page()?.items ?? [];

  return (
    <main class="page scope-page">
      <div class="container">
        <A href="/" class="back-link">
          ‹ {t("back", locale())}
        </A>
        <header class="scope-head">
          <h1 class="scope-name">{params.scope}</h1>
          <p class="muted">{t("scopeSubtitle", locale())}</p>
        </header>

        <Show when={page.loading}>
          <SkeletonGrid count={4} />
        </Show>
        <Show when={!page.loading && items().length === 0}>
          <EmptyState glyph="📦" title={t("scopeEmpty", locale())} />
        </Show>
        <Show when={items().length > 0}>
          <section class="app-grid">
            <For each={items()}>
              {(listing) => <AppCard listing={listing} locale={locale()} />}
            </For>
          </section>
        </Show>
      </div>
    </main>
  );
};
