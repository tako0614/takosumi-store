import {
  createMemo,
  createResource,
  For,
  Show,
  type Component,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import { agg, locale } from "../appstate.ts";
import type { Listing } from "../../../spec/listing.ts";
import { kindLabel, pick, t, tagLabel } from "../lib/i18n.ts";
import {
  fetchListingByScopeSlug,
  fetchListingReadme,
} from "../lib/tcs-client.ts";
import { homeBase } from "../lib/servers.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { IconTile } from "../components/IconTile.tsx";
import { InstallPanel } from "../components/InstallPanel.tsx";
import { EmptyState } from "../components/states.tsx";

function repoUrl(git: string, path: string): string {
  const base = git.replace(/\.git$/i, "");
  if (/github\.com/i.test(base)) {
    const sub = path && path !== "." ? `/${path.replace(/^\.?\/+/, "")}` : "";
    return sub ? `${base}/tree/HEAD${sub}` : base;
  }
  return base;
}

export const AppDetailPage: Component = () => {
  const params = useParams();
  const id = () => `${params.scope}/${params.slug}`;
  const fromFeed = () => agg().items.find((l) => l.id === id()) ?? null;

  // Deep-link fallback: fetch the single listing from this store if the feed
  // hasn't loaded it (e.g. the visitor opened /:scope/:slug directly).
  const [fetched] = createResource(
    () =>
      fromFeed()
        ? null
        : ([params.scope, params.slug] as readonly [string, string]),
    ([scope, slug]: readonly [string, string]) =>
      fetchListingByScopeSlug(homeBase(), scope, slug),
  );

  const listing = createMemo<Listing | null>(
    () => fromFeed() ?? fetched() ?? null,
  );
  const seenOn = () => fromFeed()?.seenOn ?? [];
  const resolving = () => !listing() && fetched.loading;

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
    <main class="page detail">
      <div class="container container-narrow">
        <A href="/" class="back-link">
          ‹ {t("back", locale())}
        </A>

        <Show when={resolving()}>
          <div class="detail-hero">
            <span class="icon-tile skel skel-icon-lg" />
            <div class="detail-hero-text">
              <span class="skel skel-line" style={{ width: "50%" }} />
              <span class="skel skel-line" style={{ width: "30%" }} />
            </div>
          </div>
        </Show>

        <Show when={!resolving() && !listing()}>
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
                  <div class="detail-chips">
                    <For each={l().tags}>
                      {(tg) => (
                        <span class="chip chip-solid">
                          {tagLabel(tg, locale())}
                        </span>
                      )}
                    </For>
                    <span class="chip chip-outline">
                      {kindLabel(l().kind, locale())}
                    </span>
                    <span class="chip chip-outline">{l().provider}</span>
                  </div>
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
                      innerHTML={renderMarkdown(doc().markdown)}
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
                  <Show when={l().source.path && l().source.path !== "."}>
                    <dt>path</dt>
                    <dd class="mono">{l().source.path}</dd>
                  </Show>
                </dl>
                <a
                  class="linklike"
                  href={repoUrl(l().source.git, l().source.path)}
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
