/**
 * Manual light/dark theme override with OS `prefers-color-scheme` fallback.
 * When no explicit choice is stored under `tcs.theme`, the app tracks the
 * visitor's system color scheme live; toggling persists the chosen mode and
 * keeps `documentElement.dataset.theme` + `<meta name="theme-color">` in sync.
 */
export type ThemeMode = "dark" | "light";

export const THEME_STORAGE_KEY = "tcs.theme";

export const THEME_COLOR: Readonly<Record<ThemeMode, string>> = {
  dark: "#0a0a0a",
  light: "#f7f7f8",
};

export function readSavedTheme(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): ThemeMode | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return raw === "dark" || raw === "light" ? raw : null;
  } catch {
    return null;
  }
}

export function saveTheme(
  mode: ThemeMode,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* ignore storage errors (private mode / quota) */
  }
}

export function systemPrefersLight(
  win: { matchMedia?: Window["matchMedia"] } | null = typeof window !==
  "undefined"
    ? window
    : null,
): boolean {
  if (!win || typeof win.matchMedia !== "function") return false;
  try {
    return win.matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    return false;
  }
}

export function resolveTheme(
  override: ThemeMode | null,
  prefersLight: boolean,
): ThemeMode {
  return override ?? (prefersLight ? "light" : "dark");
}

export function applyThemeToDocument(
  override: ThemeMode | null,
  resolved: ThemeMode,
  doc: Pick<
    Document,
    "documentElement" | "querySelectorAll"
  > | null = typeof document !== "undefined" ? document : null,
): void {
  if (!doc) return;
  if (override) {
    doc.documentElement.dataset.theme = override;
  } else {
    delete doc.documentElement.dataset.theme;
  }
  const metas = doc.querySelectorAll('meta[name="theme-color"]');
  for (const meta of metas) {
    if (override) {
      meta.setAttribute("content", THEME_COLOR[resolved]);
    } else {
      const media = meta.getAttribute("media") ?? "";
      meta.setAttribute(
        "content",
        media.includes("light") ? THEME_COLOR.light : THEME_COLOR.dark,
      );
    }
  }
}
