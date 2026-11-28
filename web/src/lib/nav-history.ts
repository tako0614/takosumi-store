/**
 * In-app navigation bookkeeping for the SPA shell.
 *
 * - `canGoBack()` tells the "‹ Back" links whether the previous history entry
 *   belongs to this app, so they can call `history.back()` (restoring the
 *   catalog's search/tag filters and scroll position) instead of always
 *   pushing a fresh `/`. When unsure (deep link, reload, forward navigation)
 *   it answers `false` and the link falls back to its plain `href`.
 * - Route changes are reported so the shell can move focus to the new page's
 *   `<main>` and announce its title for keyboard and screen-reader users.
 */
export interface NavTracker {
  /** Call on every pathname change after the first render. */
  onRouteChange(popped: boolean): void;
  /** Whether `history.back()` lands on a page inside this app. */
  canGoBack(): boolean;
}

export function createNavTracker(): NavTracker {
  let depth = 0;
  return {
    onRouteChange(popped) {
      // A pop is almost always "back"; treating a rare forward-pop as back
      // only makes the Back link fall back to its href, never leave the app.
      depth = popped ? Math.max(0, depth - 1) : depth + 1;
    },
    canGoBack() {
      return depth > 0;
    },
  };
}

/** Shared tracker instance for the running app. */
export const navTracker = createNavTracker();

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
