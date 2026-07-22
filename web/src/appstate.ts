/**
 * Small shared app state for the store SPA: the visitor locale, the aggregated
 * listing feed (fetched once, reused across routes), and the publisher account.
 * Pages read these signals and call the actions; nothing here renders.
 */
import { createSignal } from "solid-js";
import type { Locale, ListSort } from "../../spec/api.ts";
import {
  type AggregateState,
  initState,
  loadMore as aggLoadMore,
  sortItems,
} from "./lib/aggregate.ts";
import { getServers } from "./lib/servers.ts";
import { fetchAccountConfig, fetchMe, type Me } from "./lib/account-client.ts";

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

const [agg, setAgg] = createSignal<AggregateState>(
  initState(getServers(), { sort: "updated", locale: initialLocale() }),
);
export { agg };

const [me, setMe] = createSignal<Me | null>(null);
const [oidcEnabled, setOidcEnabled] = createSignal(false);
export { me, oidcEnabled, setMe };

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

let reqToken = 0;
export async function rebuild(
  opts: { sort?: ListSort; q?: string } = {},
): Promise<void> {
  const token = ++reqToken;
  const base = initState(getServers(), {
    sort: opts.sort ?? agg().sort,
    locale: localeSig(),
    ...(opts.q ? { q: opts.q } : {}),
  });
  setAgg({ ...base, loading: true });
  const next = await aggLoadMore(base);
  if (token === reqToken) setAgg(next);
}

export async function loadMoreItems(): Promise<void> {
  setAgg((p) => ({ ...p, loading: true }));
  setAgg(await aggLoadMore(agg()));
}

export async function loadAccount(): Promise<void> {
  const [config, who] = await Promise.all([fetchAccountConfig(), fetchMe()]);
  setOidcEnabled(config.oidc);
  setMe(who);
}

/** First server that failed with a real (non "search unsupported") error. */
export function loadError(): string | null {
  const bad = agg().status.find((s) => !s.ok && s.error);
  return bad?.error ?? null;
}
