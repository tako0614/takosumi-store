/**
 * CLIENT-SIDE aggregation — the decentralization in action. Fans out the open
 * read spec to every known server IN THE BROWSER and merges the results. No
 * server-to-server calls. A slow / failed / non-conforming server is dropped
 * from the render (best-effort) and never blocks the others. Listings that
 * appear on multiple servers are de-duplicated by their normalized (git,path)
 * identity and annotated with `seenOn`.
 */
import { type Listing, listingIdentity } from "../../../spec/listing.ts";
import type { ListSort, Locale } from "../../../spec/api.ts";
import type { KnownServer } from "./servers.ts";
import {
  fetchListingsPage,
  NotSupportedError,
  type PageQuery,
} from "./tcs-client.ts";

export interface AggregatedListing extends Listing {
  /** Bases of every server this Capsule was found on. */
  readonly seenOn: string[];
  /** The server whose copy of the listing we display. */
  readonly primaryServer: string;
  readonly primaryHome: boolean;
}

export interface ServerStatus {
  readonly base: string;
  readonly home: boolean;
  readonly ok: boolean;
  readonly supported: boolean;
  readonly error?: string;
}

export interface AggregateState {
  readonly servers: readonly KnownServer[];
  readonly sort: ListSort;
  readonly locale: Locale;
  readonly q?: string;
  readonly limitPerServer: number;
  /** undefined = not yet fetched; null = exhausted; string = next cursor. */
  readonly cursors: Record<string, string | null | undefined>;
  readonly items: readonly AggregatedListing[];
  readonly status: readonly ServerStatus[];
  readonly done: boolean;
  readonly loading: boolean;
}

export function initState(
  servers: readonly KnownServer[],
  opts: { sort: ListSort; locale: Locale; q?: string; limitPerServer?: number },
): AggregateState {
  return {
    servers,
    sort: opts.sort,
    locale: opts.locale,
    q: opts.q,
    limitPerServer: opts.limitPerServer ?? 24,
    cursors: {},
    items: [],
    status: servers.map((s) => ({
      base: s.base,
      home: s.home,
      ok: true,
      supported: true,
    })),
    done: false,
    loading: false,
  };
}

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

function isBetterPrimary(
  candidate: AggregatedListing,
  current: AggregatedListing,
): boolean {
  if (candidate.primaryHome !== current.primaryHome)
    return candidate.primaryHome;
  return candidate.updatedAt > current.updatedAt;
}

function mergeRound(
  existing: readonly AggregatedListing[],
  incoming: { base: string; home: boolean; items: readonly Listing[] }[],
): AggregatedListing[] {
  const map = new Map<string, AggregatedListing>();
  for (const item of existing) map.set(listingIdentity(item.source), item);

  for (const { base, home, items } of incoming) {
    for (const listing of items) {
      const key = listingIdentity(listing.source);
      const prev = map.get(key);
      if (!prev) {
        map.set(key, {
          ...listing,
          seenOn: [base],
          primaryServer: base,
          primaryHome: home,
        });
        continue;
      }
      const seenOn = prev.seenOn.includes(base)
        ? prev.seenOn
        : [...prev.seenOn, base];
      const candidate: AggregatedListing = {
        ...listing,
        seenOn,
        primaryServer: base,
        primaryHome: home,
      };
      map.set(
        key,
        isBetterPrimary(candidate, prev) ? candidate : { ...prev, seenOn },
      );
    }
  }
  return [...map.values()];
}

export function sortItems(
  items: readonly AggregatedListing[],
  sort: ListSort,
  locale: Locale,
): AggregatedListing[] {
  const copy = [...items];
  copy.sort((a, b) => {
    if (sort === "name") {
      const an = (locale === "ja" ? a.name.ja : a.name.en).toLowerCase();
      const bn = (locale === "ja" ? b.name.ja : b.name.en).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : a.id < b.id ? -1 : 1;
    }
    const af = sort === "created" ? a.createdAt : a.updatedAt;
    const bf = sort === "created" ? b.createdAt : b.updatedAt;
    if (af !== bf) return af < bf ? 1 : -1; // desc
    return a.id < b.id ? 1 : -1;
  });
  return copy;
}

/** Fetch the next page from every not-yet-exhausted server and merge. */
export async function loadMore(
  state: AggregateState,
  timeoutMs = 8000,
): Promise<AggregateState> {
  const targets = state.servers.filter((s) => state.cursors[s.base] !== null);
  if (targets.length === 0) return { ...state, done: true, loading: false };

  const settled = await Promise.all(
    targets.map(async (server) => {
      const cursor = state.cursors[server.base];
      const query: PageQuery = {
        sort: state.sort,
        limit: state.limitPerServer,
        ...(state.q ? { q: state.q } : {}),
        ...(typeof cursor === "string" ? { cursor } : {}),
      };
      const { signal, cancel } = withTimeout(timeoutMs);
      try {
        const page = await fetchListingsPage(server.base, { ...query, signal });
        return {
          server,
          ok: true,
          supported: true,
          items: page.items,
          nextCursor: page.nextCursor ?? null,
        };
      } catch (err) {
        const unsupported = err instanceof NotSupportedError;
        return {
          server,
          ok: unsupported,
          supported: !unsupported,
          items: [] as readonly Listing[],
          nextCursor: null,
          error: unsupported
            ? undefined
            : String((err as Error)?.message ?? err),
        };
      } finally {
        cancel();
      }
    }),
  );

  const cursors = { ...state.cursors };
  for (const r of settled) cursors[r.server.base] = r.nextCursor;

  const merged = mergeRound(
    state.items,
    settled
      .filter((r) => r.items.length > 0)
      .map((r) => ({
        base: r.server.base,
        home: r.server.home,
        items: r.items,
      })),
  );

  const statusByBase = new Map<string, ServerStatus>();
  for (const s of state.status) statusByBase.set(s.base, s);
  for (const r of settled) {
    statusByBase.set(r.server.base, {
      base: r.server.base,
      home: r.server.home,
      ok: r.ok,
      supported: r.supported,
      ...(r.error ? { error: r.error } : {}),
    });
  }

  const done = state.servers.every((s) => cursors[s.base] === null);
  return {
    ...state,
    cursors,
    items: sortItems(merged, state.sort, state.locale),
    status: [...statusByBase.values()],
    done,
    loading: false,
  };
}
