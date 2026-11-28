import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import {
  locale,
  me,
  oidcEnabled,
  setLocale,
  setMe,
  setThemePreference,
  themePreference,
} from "../appstate.ts";
import type { Locale } from "../../../spec/api.ts";
import { t } from "../lib/i18n.ts";
import type { ThemePreference } from "../lib/theme.ts";
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

const MonitorIcon: Component = () => (
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
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

const CheckIcon: Component = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const THEME_OPTIONS: readonly ThemePreference[] = ["system", "light", "dark"];

function themeOptionLabel(pref: ThemePreference, loc: Locale): string {
  if (pref === "light") return t("themeLight", loc);
  if (pref === "dark") return t("themeDark", loc);
  return t("themeSystem", loc);
}

const ThemeIcon: Component<{ pref: ThemePreference }> = (props) => (
  <Show
    when={props.pref === "system"}
    fallback={
      <Show when={props.pref === "light"} fallback={<MoonIcon />}>
        <SunIcon />
      </Show>
    }
  >
    <MonitorIcon />
  </Show>
);

export const TopBar: Component = () => {
  const navigate = useNavigate();
  const route = useLocation();
  const themeMenuId = createUniqueId();
  const [loggingOut, setLoggingOut] = createSignal(false);
  const [logoutFailed, setLogoutFailed] = createSignal(false);
  const [themeMenuOpen, setThemeMenuOpen] = createSignal(false);
  let logoutErrTimer: ReturnType<typeof setTimeout> | undefined;
  let themeWrapRef: HTMLDivElement | undefined;
  let themeBtnRef: HTMLButtonElement | undefined;
  const menuItemRefs: (HTMLButtonElement | undefined)[] = [];

  onCleanup(() => {
    if (logoutErrTimer) clearTimeout(logoutErrTimer);
  });

  createEffect(
    on(
      () => route.pathname,
      () => {
        setThemeMenuOpen(false);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!themeMenuOpen()) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!themeWrapRef?.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!themeWrapRef?.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (!themeWrapRef?.contains(document.activeElement)) {
        setThemeMenuOpen(false);
        return;
      }
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setThemeMenuOpen(false);
        themeBtnRef?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onWindowKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onWindowKeyDown);
    });
  });

  const openThemeMenu = (focusIndex?: number) => {
    setThemeMenuOpen(true);
    const idx =
      focusIndex ?? Math.max(0, THEME_OPTIONS.indexOf(themePreference()));
    queueMicrotask(() => {
      menuItemRefs[idx]?.focus({ preventScroll: true });
    });
  };

  const selectTheme = (pref: ThemePreference) => {
    setThemePreference(pref);
    setThemeMenuOpen(false);
    themeBtnRef?.focus({ preventScroll: true });
  };

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

  const themeButtonLabel = () => {
    const loc = locale();
    const current = themeOptionLabel(themePreference(), loc);
    return loc === "ja"
      ? `${t("themeMenuLabel", loc)}（${current}）`
      : `${t("themeMenuLabel", loc)} (${current})`;
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
                  disabled={loggingOut()}
                  onClick={() => void onLogout()}
                >
                  {t("signOut", locale())}
                </button>
              </Show>
            </nav>
          </Show>
          <div class="topbar-prefs">
            <div ref={themeWrapRef} class="theme-menu-wrap">
              <button
                ref={themeBtnRef}
                type="button"
                class="btn btn-ghost btn-sm theme-toggle"
                aria-haspopup="menu"
                aria-expanded={themeMenuOpen()}
                aria-controls={themeMenuOpen() ? themeMenuId : undefined}
                aria-label={themeButtonLabel()}
                title={themeButtonLabel()}
                onClick={() => {
                  if (themeMenuOpen()) setThemeMenuOpen(false);
                  else openThemeMenu();
                }}
                onKeyDown={(e) => {
                  if (e.isComposing || e.keyCode === 229) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    openThemeMenu();
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    openThemeMenu(THEME_OPTIONS.length - 1);
                  }
                }}
              >
                <ThemeIcon pref={themePreference()} />
              </button>
              <Show when={themeMenuOpen()}>
                <div
                  id={themeMenuId}
                  class="theme-menu"
                  role="menu"
                  aria-label={t("themeLabel", locale())}
                  onKeyDown={(e) => {
                    if (e.isComposing || e.keyCode === 229) return;
                    if (e.key === "Tab") {
                      // Return focus to the trigger before unmounting the menu
                      // so native Tab / Shift+Tab advances from the button
                      // instead of resetting to <body>.
                      themeBtnRef?.focus({ preventScroll: true });
                      setThemeMenuOpen(false);
                      return;
                    }
                    const current = menuItemRefs.findIndex(
                      (el) => el === document.activeElement,
                    );
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      const next =
                        (current < 0 ? 0 : current + 1) % THEME_OPTIONS.length;
                      menuItemRefs[next]?.focus({ preventScroll: true });
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      const prev =
                        (current <= 0 ? THEME_OPTIONS.length : current) - 1;
                      menuItemRefs[prev]?.focus({ preventScroll: true });
                    } else if (e.key === "Home") {
                      e.preventDefault();
                      menuItemRefs[0]?.focus({ preventScroll: true });
                    } else if (e.key === "End") {
                      e.preventDefault();
                      menuItemRefs[THEME_OPTIONS.length - 1]?.focus({
                        preventScroll: true,
                      });
                    }
                  }}
                >
                  <For each={THEME_OPTIONS}>
                    {(opt, idx) => (
                      <button
                        ref={(el) => {
                          menuItemRefs[idx()] = el;
                        }}
                        type="button"
                        role="menuitemradio"
                        tabIndex={-1}
                        aria-checked={themePreference() === opt}
                        class="theme-menu-item"
                        classList={{ active: themePreference() === opt }}
                        onClick={() => selectTheme(opt)}
                      >
                        <ThemeIcon pref={opt} />
                        <span class="theme-menu-label">
                          {themeOptionLabel(opt, locale())}
                        </span>
                        <span class="theme-menu-check" aria-hidden="true">
                          <Show when={themePreference() === opt}>
                            <CheckIcon />
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
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
