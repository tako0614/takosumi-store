import {
  createEffect,
  createMemo,
  createResource,
  For,
  Show,
  type Component,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import { locale } from "../appstate.ts";
import { homeBase } from "../lib/servers.ts";
import { fetchListingsPage } from "../lib/tcs-client.ts";
import { t } from "../lib/i18n.ts";
import { AppCard } from "../components/AppCard.tsx";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/states.tsx";

/** A publisher namespace page — all apps under one `scope`. */
export const ScopePage: Component = () => {
  const params = useParams();
  const [page, { refetch }] = createResource(
    () => params.scope,
    (scope: string) =>
      fetchListingsPage(homeBase(), { scope, sort: "updated", limit: 100 }),
  );
  const items = () => page()?.items ?? [];

  const publisherDisplayName = createMemo(() => {
    const scope = params.scope ?? "";
    for (const item of items()) {
      const display = item.publisher?.displayName?.trim();
      if (display && display !== scope) return display;
    }
    return "";
  });

  const countLabel = () => {
    const n = items().length;
    const loc = locale();
    if (n === 1) return t("scopeCountSingle", loc);
    return loc === "ja"
      ? `${n} ${t("scopeCountPlural", loc)}`
      : `${n} ${t("scopeCountPlural", loc)}`;
  };

  createEffect(() => {
    const label = publisherDisplayName() || params.scope;
    document.title = label
      ? `${label} — ${t("appName", locale())}`
      : t("appName", locale());
  });

  return (
    <main id="main" tabIndex={-1} class="page scope-page">
      <div class="container">
        <A href="/" class="back-link">
          ‹ {t("back", locale())}
        </A>
        <header class="scope-head">
          <div class="scope-head-row">
            <h1
              class="scope-name"
              classList={{
                "scope-name-display": Boolean(publisherDisplayName()),
              }}
            >
              {publisherDisplayName() || params.scope}
            </h1>
            <Show when={!page.loading && !page.error && items().length > 0}>
              <span class="scope-count">{countLabel()}</span>
            </Show>
          </div>
          <Show when={publisherDisplayName()}>
            <p class="scope-handle mono muted">{params.scope}</p>
          </Show>
          <p class="muted scope-subtitle">{t("scopeSubtitle", locale())}</p>
        </header>

        <Show when={page.loading}>
          <SkeletonGrid count={4} />
        </Show>
        <Show when={!page.loading && Boolean(page.error)}>
          <ErrorState
            title={t("errorTitle", locale())}
            message={t("errorHint", locale())}
            retryLabel={t("retry", locale())}
            onRetry={() => void refetch()}
          />
        </Show>
        <Show when={!page.loading && !page.error && items().length === 0}>
          <EmptyState glyph="📦" title={t("scopeEmpty", locale())} />
        </Show>
        <Show when={!page.error && items().length > 0}>
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
