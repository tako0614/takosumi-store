import { Show, type Component } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { locale, me, oidcEnabled, setLocale, setMe } from "../appstate.ts";
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
    alt=""
    aria-hidden="true"
    decoding="async"
    class="brand-mark"
  />
);

export const TopBar: Component = () => {
  const navigate = useNavigate();
  const route = useLocation();

  const onLogout = async () => {
    await logout();
    setMe(null);
    navigate("/");
  };

  return (
    <header class="topbar">
      <div class="topbar-inner">
        <A href="/" class="brand">
          <Mark />
          <span class="brand-name">{t("appName", locale())}</span>
        </A>

        <div class="topbar-end">
          <Show when={me() || oidcEnabled()}>
            <nav class="topbar-actions" aria-label={t("primaryNav", locale())}>
              <Show
                when={me()}
                fallback={
                  <a
                    class="btn btn-ghost btn-sm"
                    href={loginUrl(route.pathname + route.search)}
                    rel="external"
                  >
                    {t("signIn", locale())}
                  </a>
                }
              >
                <A
                  href="/manage"
                  class="btn btn-ghost btn-sm"
                  aria-current={
                    route.pathname === "/manage" ? "page" : undefined
                  }
                >
                  {t("manage", locale())}
                </A>
                <A
                  href="/publish"
                  class="btn btn-secondary btn-sm"
                  aria-current={
                    route.pathname === "/publish" ? "page" : undefined
                  }
                >
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
            </nav>
          </Show>
          <button
            type="button"
            class="btn btn-ghost btn-sm lang-toggle"
            lang={locale() === "ja" ? "en" : "ja"}
            aria-label={t("switchLanguageLabel", locale())}
            onClick={() => setLocale(locale() === "ja" ? "en" : "ja")}
          >
            <span aria-hidden="true" class="lang-toggle-glyph">
              文A
            </span>
            {t("switchLanguage", locale())}
          </button>
        </div>
      </div>
    </header>
  );
};
