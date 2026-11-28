/**
 * Small shared app state for the store SPA: the visitor locale, the aggregated
 * listing feed (fetched once, reused across routes), and the publisher account.
 * Pages read these signals and call the actions; nothing here renders.
 */
import { createSignal } from "solid-js";
import type { Locale } from "../../spec/api.ts";
import {
  type AggregateState,
  initState,
  loadMore as aggLoadMore,
  sortItems,
} from "./lib/aggregate.ts";
import { getServers } from "./lib/servers.ts";
import { fetchAccountConfig, fetchMe, type Me } from "./lib/account-client.ts";
import {
  readSavedTheme,
  resolveTheme,
  saveTheme,
  systemPrefersLight,
  type ThemeMode,
} from "./lib/theme.ts";

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem("tcs.locale");
    if (saved === "ja" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
  }
  return "ja";
}

const [localeSig, setLocaleSig] = createSignal<Locale>(initialLocale());
export const locale = localeSig;

const [themeOverrideSig, setThemeOverrideSig] = createSignal<ThemeMode | null>(
  readSavedTheme(),
);
const [prefersLightSig, setPrefersLightSig] =
  createSignal<boolean>(systemPrefersLight());
export const themeOverride = themeOverrideSig;
export const theme = (): ThemeMode =>
  resolveTheme(themeOverrideSig(), prefersLightSig());

export function setTheme(mode: ThemeMode): void {
  setThemeOverrideSig(mode);
  saveTheme(mode);
}

export function toggleTheme(): void {
  setTheme(theme() === "dark" ? "light" : "dark");
}

export function syncSystemTheme(prefersLight: boolean): void {
  setPrefersLightSig(prefersLight);
}

const freshCatalog = () =>
  initState(getServers(), { sort: "updated", locale: localeSig() });
const [agg, setAgg] = createSignal<AggregateState>(freshCatalog());
export { agg };

const [me, setMe] = createSignal<Me | null>(null);
const [oidcEnabled, setOidcEnabled] = createSignal(false);
const [accountLoaded, setAccountLoaded] = createSignal(false);
export { accountLoaded, me, oidcEnabled, setMe };

export function setLocale(value: Locale): void {
  setLocaleSig(value);
  try {
    localStorage.setItem("tcs.locale", value);
  } catch {
    /* ignore */
  }
  setAgg((p) => ({
    ...p,
    locale: value,
    items: sortItems(p.items, p.sort, value),
  }));
}

const CATALOG_MAX_AGE_MS = 60_000;
let loadedAt: number | undefined;
let reqToken = 0;

export function ensureListings(): void {
  if (loadedAt === undefined || Date.now() - loadedAt >= CATALOG_MAX_AGE_MS) {
    void rebuild();
  }
}

export function invalidateListings(): void {
  reqToken += 1;
  loadedAt = undefined;
  setAgg(freshCatalog());
}

export async function rebuild(): Promise<void> {
  if (agg().loading) return;
  const token = ++reqToken;
  setAgg((p) => ({ ...p, loading: true }));
  const next = await aggLoadMore(freshCatalog());
  if (token !== reqToken) return;
  loadedAt = next.status.every((s) => s.ok) ? Date.now() : undefined;
  setAgg({ ...next, locale: localeSig() });
}

export async function loadMoreItems(): Promise<void> {
  const current = agg();
  if (current.loading || current.done) return;
  const token = ++reqToken;
  setAgg({ ...current, loading: true });
  const next = await aggLoadMore(current);
  if (token === reqToken) setAgg({ ...next, locale: localeSig() });
}

export async function loadAccount(): Promise<void> {
  try {
    const config = await fetchAccountConfig();
    setOidcEnabled(config.oidc);
    if (!config.oidc) {
      setMe(null);
      return;
    }
    const who = await fetchMe();
    setMe(who);
  } finally {
    setAccountLoaded(true);
  }
}

/** First server that failed with a real (non-capability) error. */
export function loadError(): string | null {
  const bad = agg().status.find((s) => !s.ok && s.error);
  return bad?.error ?? null;
}
