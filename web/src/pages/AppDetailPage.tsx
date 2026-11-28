import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
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
import { BackLink } from "../components/BackLink.tsx";
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
  const notFound = () => !resolving() && !fetchFailed() && !listing();

  createEffect(() => {
    const l = listing();
    const loc = locale();
    const label = l
      ? pick(l.name, loc)
      : notFound()
        ? t("listingNotFoundTitle", loc)
        : fetchFailed()
          ? t("errorTitle", loc)
          : "";
    document.title = label
      ? `${label} — ${t("appName", loc)}`
      : t("appName", loc);
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

  const [codeCopyStatus, setCodeCopyStatus] = createSignal("");
  let mdRef: HTMLDivElement | undefined;

  // Enhance rendered README fenced code blocks with accessible copy buttons.
  createEffect(() => {
    const doc = readme();
    const loc = locale();
    const root = mdRef;
    setCodeCopyStatus("");
    if (!doc || !root) return;

    let disposed = false;
    const cleanups: (() => void)[] = [];
    const buttonTimers = new Map<
      HTMLButtonElement,
      ReturnType<typeof setTimeout>
    >();
    const pres = Array.from(
      root.querySelectorAll<HTMLPreElement>("pre.md-code"),
    );
    for (const pre of pres) {
      let wrap = pre.parentElement;
      if (!wrap || !wrap.classList.contains("md-code-block")) {
        wrap = document.createElement("div");
        wrap.className = "md-code-block";
        pre.parentNode?.insertBefore(wrap, pre);
        wrap.appendChild(pre);
      }
      wrap.querySelector(".md-code-copy")?.remove();

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "md-code-copy";
      btn.textContent = t("copyCode", loc);
      btn.setAttribute("aria-label", t("copyCodeLabel", loc));

      const onClick = async () => {
        const text =
          pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        let ok = false;
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch {
          ok = false;
        }
        if (disposed) return;
        if (ok) {
          btn.textContent = t("copied", loc);
          btn.dataset.copied = "true";
          setCodeCopyStatus(t("copied", loc));
        } else {
          btn.textContent = t("actionFailed", loc);
          delete btn.dataset.copied;
          setCodeCopyStatus(t("copyFailed", loc));
        }
        const existingTimer = buttonTimers.get(btn);
        if (existingTimer !== undefined) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          buttonTimers.delete(btn);
          if (disposed) return;
          btn.textContent = t("copyCode", loc);
          delete btn.dataset.copied;
          setCodeCopyStatus("");
        }, 2000);
        buttonTimers.set(btn, timer);
      };

      btn.addEventListener("click", onClick);
      wrap.appendChild(btn);
      cleanups.push(() => {
        btn.removeEventListener("click", onClick);
      });
    }

    onCleanup(() => {
      disposed = true;
      for (const fn of cleanups) fn();
      for (const timer of buttonTimers.values()) clearTimeout(timer);
      buttonTimers.clear();
    });
  });

  return (
    <main id="main" tabIndex={-1} class="page detail">
      <div class="container container-narrow">
        <BackLink />

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
            heading
            title={t("errorTitle", locale())}
            message={t("errorHint", locale())}
            retryLabel={t("retry", locale())}
            onRetry={() => void refetch()}
          />
        </Show>

        <Show when={notFound()}>
          <EmptyState
            heading
            glyph="🧩"
            title={t("listingNotFoundTitle", locale())}
            message={t("listingNotFoundHint", locale())}
            action={
              <A href="/" class="btn btn-primary">
                {t("browseCatalog", locale())}
              </A>
            }
          />
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
                      ref={mdRef}
                      class="md"
                      // Safe: renderMarkdown escapes all input and only emits a
                      // whitelist of tags with scheme-checked link targets.
                      innerHTML={renderMarkdown(
                        doc().markdown,
                        doc().sourceUrl,
                        { headingOffset: 2 },
                      )}
                    />
                    <span class="sr-only" aria-live="polite">
                      {codeCopyStatus()}
                    </span>
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
