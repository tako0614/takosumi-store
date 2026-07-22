import { createEffect, createSignal, Show, type Component } from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { locale, me, oidcEnabled, setMe } from "../appstate.ts";
import { t } from "../lib/i18n.ts";
import { loginUrl, logout } from "../lib/account-client.ts";

/**
 * Takosumi brand mark — the canonical `tako.png` logo, identical to the one the
 * Takosumi dashboard (app.takosumi.com) renders via its LogoMark. The image is
 * copied into this store's public assets so it serves from the same origin.
 */
const Mark: Component = () => (
  <img
    src="/tako.png"
    width={26}
    height={26}
    alt="Takosumi"
    decoding="async"
    class="brand-mark"
  />
);

export const TopBar: Component = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [query, setQuery] = createSignal<string>(
    typeof params.q === "string" ? params.q : "",
  );

  // Keep the box in sync when the URL query changes (e.g. back button).
  createEffect(() => {
    const q = typeof params.q === "string" ? params.q : "";
    setQuery(q);
  });

  const submit = (e: Event) => {
    e.preventDefault();
    const q = query().trim();
    navigate(q ? `/?q=${encodeURIComponent(q)}` : "/");
  };

  const onLogout = async () => {
    await logout();
    setMe(null);
    navigate("/");
  };

  return (
    <header class="topbar">
      <div class="topbar-inner">
        <A href="/" class="brand" aria-label="Takosumi Store">
          <Mark />
          <span class="brand-name">{t("appName", locale())}</span>
        </A>

        <form class="topbar-search" onSubmit={submit} role="search">
          <svg
            class="topbar-search-icon"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              cx="11"
              cy="11"
              r="7"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            />
            <line
              x1="16.5"
              y1="16.5"
              x2="21"
              y2="21"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
          <input
            type="search"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder={t("searchPlaceholder", locale())}
            aria-label={t("searchPlaceholder", locale())}
          />
        </form>

        <div class="topbar-actions">
          <Show
            when={me()}
            fallback={
              <Show when={oidcEnabled()}>
                <a
                  class="btn btn-ghost btn-sm"
                  href={loginUrl(location.pathname + location.search)}
                  rel="external"
                >
                  {t("signIn", locale())}
                </a>
              </Show>
            }
          >
            <A href="/manage" class="btn btn-ghost btn-sm">
              {t("manage", locale())}
            </A>
            <A href="/publish" class="btn btn-secondary btn-sm">
              {t("publish", locale())}
            </A>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={onLogout}
            >
              {t("signOut", locale())}
            </button>
          </Show>
        </div>
      </div>
    </header>
  );
};
