/**
 * In-app navigation bookkeeping for the SPA shell.
 *
 * - `NavTracker` follows `@solidjs/router`'s `useBeforeLeave` lifecycle so it
 *   knows every push, replace, and browser back/forward `delta` in the exact
 *   order the router processes them.
 * - `backDelta()` tells the "‹ Back" links how many history entries to pop to
 *   reach the nearest earlier in-app page on a different pathname (restoring
 *   the catalog's search/tag filters and scroll position, and skipping same-page
 *   hash jumps like `#main`), or `0` when there is no earlier in-app page so
 *   the link falls back to its plain `href` instead of leaving the store.
 * - `routeAnnouncer` / `setPageTitle` announce the resolved page title once a
 *   route (including lazy chunks and async detail fetches) finishes setting it.
 */
export interface BeforeLeaveLike {
  to: string | number;
  options?: { replace?: boolean };
  defaultPrevented?: boolean;
}

export interface NavTracker {
  /** Seed the in-app history stack with the initial URL (pathname+search+hash). */
  reset(initialUrl?: string): void;
  /** Feed every event from `@solidjs/router`'s `useBeforeLeave` hook. */
  onBeforeLeave(event: BeforeLeaveLike): void;
  /**
   * Negative history delta to the nearest earlier in-app entry on a different
   * pathname, or `0` if there is no earlier in-app page.
   */
  backDelta(): number;
  /** Whether `BackLink` has an earlier in-app page to return to via history. */
  canGoBack(): boolean;
  /** Pathname of the entry `backDelta()` would land on, or `null` if none. */
  previousPathname(): string | null;
}

function normalizeUrl(raw: string, base = "/"): string {
  try {
    const originBase = base.startsWith("/") ? base : "/";
    const u = new URL(raw, `http://t.local${originBase}`);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
}

function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const end = q === -1 ? h : h === -1 ? q : Math.min(q, h);
  return end === -1 ? url : url.slice(0, end);
}

export function createNavTracker(initialUrl = "/"): NavTracker {
  let entries: string[] = [normalizeUrl(initialUrl)];
  let index = 0;

  const findPreviousPageIndex = (): number => {
    const currentPath = pathnameOf(entries[index] ?? "");
    for (let i = index - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      // An empty slot marks an unrecorded history entry (e.g. forward jump past
      // this session's stack); never pop across unknown history.
      if (!entry) return -1;
      if (pathnameOf(entry) !== currentPath) return i;
    }
    return -1;
  };

  return {
    reset(url = "/") {
      entries = [normalizeUrl(url)];
      index = 0;
    },
    onBeforeLeave(event) {
      if (event.defaultPrevented) return;
      if (typeof event.to === "number") {
        if (event.to === 0) return;
        const next = index + event.to;
        if (next <= 0) {
          index = 0;
          return;
        }
        if (next < entries.length) {
          index = next;
          return;
        }
        // Forward jump past entries recorded in this session (e.g. a native
        // hash jump or forward into a pre-reload entry). In a browser,
        // `window.location` already holds the popstate destination.
        const dest =
          typeof window !== "undefined"
            ? normalizeUrl(
                window.location.pathname +
                  window.location.search +
                  window.location.hash,
              )
            : "";
        while (entries.length <= next) entries.push("");
        entries[next] = dest;
        index = next;
        return;
      }
      const resolved = normalizeUrl(event.to, entries[index] || "/");
      if (event.options?.replace) {
        entries[index] = resolved;
        return;
      }
      if (resolved === entries[index]) return;
      entries = entries.slice(0, index + 1);
      entries.push(resolved);
      index = entries.length - 1;
    },
    backDelta() {
      const target = findPreviousPageIndex();
      return target === -1 ? 0 : target - index;
    },
    canGoBack() {
      return findPreviousPageIndex() !== -1;
    },
    previousPathname() {
      const target = findPreviousPageIndex();
      return target === -1 ? null : pathnameOf(entries[target]!);
    },
  };
}

/** Shared tracker instance for the running app. */
export const navTracker = createNavTracker();

export interface RouteAnnouncer {
  /** Mark that a client-side pathname navigation began and clear live text. */
  beginNavigation(): void;
  /**
   * Report the current page's title. While `pending` is true (e.g. an async
   * detail fetch is still in flight), announcements wait for the resolved title.
   */
  reportTitle(title: string, pending?: boolean): void;
  /** Subscribe to announcement updates (`""` on clear, then the settled title). */
  subscribe(listener: (announcement: string) => void): () => void;
}

export function createRouteAnnouncer(): RouteAnnouncer {
  let awaiting = false;
  const listeners = new Set<(announcement: string) => void>();
  const emit = (text: string) => {
    for (const listener of listeners) listener(text);
  };
  return {
    beginNavigation() {
      awaiting = true;
      emit("");
    },
    reportTitle(title, pending = false) {
      if (!awaiting || pending) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      awaiting = false;
      emit(trimmed);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Shared announcer instance for the running app. */
export const routeAnnouncer = createRouteAnnouncer();

/** Update `document.title` and notify the route announcer once settled. */
export function setPageTitle(title: string, pending = false): void {
  if (typeof document !== "undefined") document.title = title;
  routeAnnouncer.reportTitle(title, pending);
}

/**
 * Focus the page's `<main>` landmark after a client-side route change without
 * scrolling. Keeps watching for a few frames because lazily loaded routes
 * mount (or replace) their `<main>` asynchronously, which would otherwise drop
 * focus back to `<body>`. It only ever moves focus that is on `<body>` (or
 * outside the new page), so it never fights a field the page focused itself.
 * Returns a cancel function.
 */
export function focusMainAfterNavigation(
  doc: Document = document,
  maxFrames = 60,
): () => void {
  let frames = 0;
  let cancelled = false;
  let handle = 0;
  let focusedOnce = false;
  const tick = () => {
    if (cancelled) return;
    const main = doc.getElementById("main");
    if (main) {
      const active = doc.activeElement;
      const lost = !active || active === doc.body;
      if (lost || (!focusedOnce && !main.contains(active))) {
        main.focus({ preventScroll: true });
        focusedOnce = true;
      }
    }
    if (++frames < maxFrames) handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(handle);
  };
}
