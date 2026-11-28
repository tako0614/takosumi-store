import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import { locale } from "../appstate.ts";
import { homeBase } from "../lib/servers.ts";
import { fetchListingsPage } from "../lib/tcs-client.ts";
import {
  appendScopePage,
  applyInitialScopeError,
  applyInitialScopePage,
  applyScopeLoadMoreError,
  initialScopeState,
  startScopeLoadMore,
  type ScopePageState,
} from "../lib/scope-pagination.ts";
import { t } from "../lib/i18n.ts";
import { setPageTitle } from "../lib/nav-history.ts";
import { AppCard } from "../components/AppCard.tsx";
import { BackLink } from "../components/BackLink.tsx";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/states.tsx";

const SCOPE_PAGE_LIMIT = 100;

/** A publisher namespace page — all apps under one `scope`. */
export const ScopePage: Component = () => {
  const params = useParams();
  const [state, setState] = createSignal<ScopePageState>(initialScopeState());
  let reqToken = 0;
  let activeController: AbortController | undefined;

  const abortActive = () => {
    activeController?.abort();
    activeController = undefined;
  };

  const loadInitial = async (scope: string) => {
    abortActive();
    const token = ++reqToken;
    const ctrl = new AbortController();
    activeController = ctrl;
    setState(initialScopeState());
    try {
      const page = await fetchListingsPage(homeBase(), {
        scope,
        sort: "updated",
        limit: SCOPE_PAGE_LIMIT,
        signal: ctrl.signal,
      });
      if (token !== reqToken) return;
      setState(applyInitialScopePage(page));
    } catch {
      if (token !== reqToken) return;
      setState(applyInitialScopeError());
    } finally {
      if (activeController === ctrl) activeController = undefined;
    }
  };

  const loadMore = async () => {
    const scope = params.scope;
    const current = state();
    if (!scope || !current.nextCursor || current.loading || current.loadingMore)
      return;
    abortActive();
    const token = ++reqToken;
    const ctrl = new AbortController();
    activeController = ctrl;
    setState((prev) => startScopeLoadMore(prev));
    try {
      const page = await fetchListingsPage(homeBase(), {
        scope,
        sort: "updated",
        limit: SCOPE_PAGE_LIMIT,
        cursor: current.nextCursor,
        signal: ctrl.signal,
      });
      if (token !== reqToken) return;
      setState((prev) => appendScopePage(prev, page));
    } catch {
      if (token !== reqToken) return;
      setState((prev) => applyScopeLoadMoreError(prev));
    } finally {
      if (activeController === ctrl) activeController = undefined;
    }
  };

  createEffect(() => {
    const scope = params.scope;
    if (scope) void loadInitial(scope);
  });

  onCleanup(() => {
    reqToken += 1;
    abortActive();
  });

  const items = () => state().items;

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
    if (state().nextCursor) {
      return `${n}+ ${t("scopeCountPlural", loc)}`;
    }
    if (n === 1) return t("scopeCountSingle", loc);
    return `${n} ${t("scopeCountPlural", loc)}`;
  };

  createEffect(() => {
    const label = publisherDisplayName() || params.scope;
    setPageTitle(
      label ? `${label} — ${t("appName", locale())}` : t("appName", locale()),
      state().loading,
    );
  });

  return (
    <main id="main" tabIndex={-1} class="page scope-page">
      <div class="container">
        <BackLink />
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
            <Show
              when={!state().loading && !state().error && items().length > 0}
            >
              <span class="scope-count">{countLabel()}</span>
            </Show>
          </div>
          <Show when={publisherDisplayName()}>
            <p class="scope-handle mono muted">{params.scope}</p>
          </Show>
          <p class="muted scope-subtitle">{t("scopeSubtitle", locale())}</p>
        </header>

        <Show when={state().loading}>
          <SkeletonGrid count={4} label={t("loading", locale())} />
        </Show>
        <Show when={!state().loading && state().error}>
          <ErrorState
            title={t("errorTitle", locale())}
            message={t("errorHint", locale())}
            retryLabel={t("retry", locale())}
            onRetry={() => {
              if (params.scope) void loadInitial(params.scope);
            }}
          />
        </Show>
        <Show when={!state().loading && !state().error && items().length === 0}>
          <EmptyState
            glyph="📦"
            title={t("scopeEmpty", locale())}
            action={
              <A href="/" class="btn btn-primary">
                {t("browseCatalog", locale())}
              </A>
            }
          />
        </Show>
        <Show when={!state().error && items().length > 0}>
          <section class="app-grid" aria-label={t("apps", locale())}>
            <For each={items()}>
              {(listing) => <AppCard listing={listing} locale={locale()} />}
            </For>
          </section>
        </Show>
        <Show when={state().loadMoreError && items().length > 0}>
          <div class="inline-error-bar" role="alert">
            <span>{t("loadMoreFailed", locale())}</span>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={state().loadingMore}
              onClick={() => void loadMore()}
            >
              {state().loadingMore
                ? t("loading", locale())
                : t("retry", locale())}
            </button>
          </div>
        </Show>
        <Show
          when={
            !state().loading &&
            !state().error &&
            !state().loadMoreError &&
            Boolean(state().nextCursor) &&
            items().length > 0
          }
        >
          <div class="loadmore">
            <button
              type="button"
              class="btn btn-secondary"
              disabled={state().loadingMore}
              onClick={() => void loadMore()}
            >
              {state().loadingMore
                ? t("loading", locale())
                : t("loadMore", locale())}
            </button>
          </div>
        </Show>
      </div>
    </main>
  );
};
