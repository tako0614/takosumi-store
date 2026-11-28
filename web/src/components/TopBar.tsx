import { createSignal, onCleanup, Show, type Component } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import {
  locale,
  me,
  oidcEnabled,
  setLocale,
  setMe,
  theme,
  toggleTheme,
} from "../appstate.ts";
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

const SunIcon: Component = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

const MoonIcon: Component = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

export const TopBar: Component = () => {
  const navigate = useNavigate();
  const route = useLocation();
  const [loggingOut, setLoggingOut] = createSignal(false);
  const [logoutFailed, setLogoutFailed] = createSignal(false);
  let logoutErrTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (logoutErrTimer) clearTimeout(logoutErrTimer);
  });

  const onLogout = async () => {
    if (loggingOut()) return;
    if (logoutErrTimer) {
      clearTimeout(logoutErrTimer);
      logoutErrTimer = undefined;
    }
    setLogoutFailed(false);
    setLoggingOut(true);
    try {
      const ok = await logout();
      if (ok) {
        setMe(null);
        navigate("/");
      } else {
        setLogoutFailed(true);
        logoutErrTimer = setTimeout(() => {
          setLogoutFailed(false);
          logoutErrTimer = undefined;
        }, 4000);
      }
    } finally {
      setLoggingOut(false);
    }
  };

  const themeLabel = () =>
    theme() === "dark"
      ? t("switchToLight", locale())
      : t("switchToDark", locale());

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
                  disabled={loggingOut()}
                  onClick={() => void onLogout()}
                >
                  {t("signOut", locale())}
                </button>
              </Show>
            </nav>
          </Show>
          <div class="topbar-prefs">
            <button
              type="button"
              class="btn btn-ghost btn-sm theme-toggle"
              aria-label={themeLabel()}
              title={themeLabel()}
              onClick={toggleTheme}
            >
              <Show when={theme() === "dark"} fallback={<MoonIcon />}>
                <SunIcon />
              </Show>
            </button>
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
      </div>
      <Show when={logoutFailed()}>
        <div class="topbar-error" role="alert">
          <div class="topbar-error-inner">{t("actionFailed", locale())}</div>
        </div>
      </Show>
    </header>
  );
};
