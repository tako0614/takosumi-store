import {
  createEffect,
  createMemo,
  createResource,
  For,
  Show,
  type Component,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import { agg, locale } from "../appstate.ts";
import type { ListingV2 } from "../../../spec/v2/listing.ts";
import type { Locale } from "../../../spec/api.ts";
import { pick, t, tagLabel } from "../lib/i18n.ts";
import {
  fetchListingByScopeSlug,
  fetchListingReadme,
} from "../lib/tcs-client.ts";
import { homeBase } from "../lib/servers.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { IconTile } from "../components/IconTile.tsx";
import { InstallPanel } from "../components/InstallPanel.tsx";
import { EmptyState, ErrorState } from "../components/states.tsx";

function repoUrl(git: string): string {
  return git.replace(/\.git$/i, "");
}

function formatDate(iso: string | undefined, loc: Locale): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  try {
    return new Intl.DateTimeFormat(loc === "ja" ? "ja-JP" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(ms));
  } catch {
    return iso.slice(0, 10);
  }
}

export const AppDetailPage: Component = () => {
  const params = useParams();
  const id = () => `${params.scope}/${params.slug}`;
  const fromFeed = () => agg().items.find((l) => l.id === id()) ?? null;

  // Deep-link fallback: fetch the single listing from this store if the feed
  // hasn't loaded it (e.g. the visitor opened /:scope/:slug directly).
  const [fetched, { refetch }] = createResource(
    () =>
      fromFeed()
        ? null
        : ([params.scope, params.slug] as readonly [string, string]),
    ([scope, slug]: readonly [string, string]) =>
      fetchListingByScopeSlug(homeBase(), scope, slug),
  );

  const listing = createMemo<ListingV2 | null>(
    () => fromFeed() ?? (fetched.error ? null : (fetched() ?? null)),
  );
  const seenOn = () => fromFeed()?.seenOn ?? [];
  const resolving = () => !listing() && fetched.loading;
  const fetchFailed = () =>
    !listing() && !fetched.loading && Boolean(fetched.error);

  createEffect(() => {
    const l = listing();
    document.title = l
      ? `${pick(l.name, locale())} — ${t("appName", locale())}`
      : t("appName", locale());
  });

  // README from the source repo — registry-grade detail. Fetched lazily once
  // the listing resolves; absent READMEs simply omit the section.
  const [readme] = createResource(
    () =>
      listing()
        ? ([params.scope, params.slug] as readonly [string, string])
        : null,
    ([scope, slug]: readonly [string, string]) =>
      fetchListingReadme(homeBase(), scope, slug),
  );

  return (
    <main id="main" tabIndex={-1} class="page detail">
      <div class="container container-narrow">
        <A href="/" class="back-link">
          ‹ {t("back", locale())}
        </A>

        <Show when={resolving()}>
          <div class="detail-hero" aria-busy="true">
            <span class="icon-tile skel skel-icon-lg" />
            <div class="detail-hero-text">
              <span class="skel skel-line" style={{ width: "50%" }} />
              <span class="skel skel-line" style={{ width: "30%" }} />
            </div>
          </div>
        </Show>

        <Show when={fetchFailed()}>
          <ErrorState
            title={t("errorTitle", locale())}
            message={t("errorHint", locale())}
            retryLabel={t("retry", locale())}
            onRetry={() => void refetch()}
          />
        </Show>

        <Show when={!resolving() && !fetchFailed() && !listing()}>
          <EmptyState glyph="🧩" title={t("noResults", locale())} />
        </Show>

        <Show when={listing()}>
          {(l) => (
            <>
              <header class="detail-hero">
                <IconTile
                  label={pick(l().name, locale())}
                  seed={l().id}
                  iconUrl={l().iconUrl}
                  size={88}
                />
                <div class="detail-hero-text">
                  <h1 class="detail-title">{pick(l().name, locale())}</h1>
                  <p class="detail-developer">
                    <A
                      href={`/${encodeURIComponent(l().scope)}`}
                      class="linklike"
                    >
                      {l().scope}
                    </A>
                    <span class="detail-id-sep">/</span>
                    {l().slug}
                  </p>
                  <Show when={(l().tags ?? []).length > 0}>
                    <div class="detail-chips">
                      <For each={l().tags ?? []}>
                        {(tg) => (
                          <A
                            href={`/?tag=${encodeURIComponent(tg)}`}
                            end
                            class="chip chip-solid chip-link"
                          >
                            {tagLabel(tg, locale())}
                          </A>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </header>

              <InstallPanel listing={l()} locale={locale()} />

              <section class="detail-section">
                <h2>{t("about", locale())}</h2>
                <p class="detail-desc">{pick(l().description, locale())}</p>
              </section>

              <Show when={readme()}>
                {(doc) => (
                  <section class="detail-section">
                    <h2>{t("readme", locale())}</h2>
                    <div
                      class="md"
                      // Safe: renderMarkdown escapes all input and only emits a
                      // whitelist of tags with scheme-checked link targets.
                      innerHTML={renderMarkdown(
                        doc().markdown,
                        doc().sourceUrl,
                        { headingOffset: 2 },
                      )}
                    />
                    <p class="muted readme-src">
                      <a
                        class="linklike"
                        href={doc().sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {t("readmeFrom", locale())} ↗
                      </a>
                    </p>
                  </section>
                )}
              </Show>

              <section class="detail-section">
                <h2>{t("source", locale())}</h2>
                <dl class="kv">
                  <dt>git</dt>
                  <dd class="mono">{l().source.git}</dd>
                  <Show when={l().source.path}>
                    {(modPath) => (
                      <>
                        <dt>{t("modulePath", locale())}</dt>
                        <dd class="mono">{modPath()}</dd>
                      </>
                    )}
                  </Show>
                  <Show when={formatDate(l().updatedAt, locale())}>
                    {(dateLabel) => (
                      <>
                        <dt>{t("updatedAt", locale())}</dt>
                        <dd>{dateLabel()}</dd>
                      </>
                    )}
                  </Show>
                </dl>
                <a
                  class="linklike detail-repo-link"
                  href={repoUrl(l().source.git)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t("openRepo", locale())} ↗
                </a>
              </section>

              <Show when={seenOn().length > 1}>
                <section class="detail-section">
                  <h2>{t("alsoOnStores", locale())}</h2>
                  <ul class="bare">
                    <For each={seenOn()}>
                      {(base) => <li class="mono muted">{base}</li>}
                    </For>
                  </ul>
                </section>
              </Show>
            </>
          )}
        </Show>
      </div>
    </main>
  );
};
