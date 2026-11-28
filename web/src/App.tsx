import {
  createEffect,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  type Component,
  type ParentComponent,
} from "solid-js";
import { Route, Router, useBeforeLeave, useLocation } from "@solidjs/router";
import { TopBar } from "./components/TopBar.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { AppDetailPage } from "./pages/AppDetailPage.tsx";
import { ScopePage } from "./pages/ScopePage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import {
  loadAccount,
  locale,
  syncSystemTheme,
  theme,
  themeOverride,
} from "./appstate.ts";
import { t } from "./lib/i18n.ts";
import { applyThemeToDocument } from "./lib/theme.ts";
import {
  focusMainAfterNavigation,
  navTracker,
  routeAnnouncer,
} from "./lib/nav-history.ts";

const PublishPage = lazy(async () => ({
  default: (await import("./pages/PublishPage.tsx")).PublishPage,
}));
const ManagePage = lazy(async () => ({
  default: (await import("./pages/ManagePage.tsx")).ManagePage,
}));

const Layout: ParentComponent = (props) => {
  const location = useLocation();
  const [routeAnnouncement, setRouteAnnouncement] = createSignal("");
  let cancelFocus: (() => void) | undefined;
  let announceFrame: number | undefined;

  navTracker.reset(location.pathname + location.search + location.hash);
  useBeforeLeave((e) => {
    navTracker.onBeforeLeave(e);
  });

  const unsubscribeAnnouncer = routeAnnouncer.subscribe((text) => {
    if (announceFrame !== undefined) {
      cancelAnimationFrame(announceFrame);
      announceFrame = undefined;
    }
    if (!text) {
      setRouteAnnouncement("");
      return;
    }
    // Clear first and write on the next frame so screen readers always detect
    // the live-region update even when two routes share the same title.
    setRouteAnnouncement("");
    announceFrame = requestAnimationFrame(() => {
      announceFrame = undefined;
      setRouteAnnouncement(text);
    });
  });

  onMount(() => {
    void loadAccount();
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
    ) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      syncSystemTheme(mq.matches);
      const onThemeChange = (e: MediaQueryListEvent) =>
        syncSystemTheme(e.matches);
      mq.addEventListener("change", onThemeChange);
      onCleanup(() => mq.removeEventListener("change", onThemeChange));
    }
  });
  onCleanup(() => {
    unsubscribeAnnouncer();
    cancelFocus?.();
    if (announceFrame !== undefined) cancelAnimationFrame(announceFrame);
  });

  createEffect(() => {
    document.documentElement.lang = locale();
  });

  createEffect(() => {
    applyThemeToDocument(themeOverride(), theme());
  });

  // On client-side route changes (not query-only filter updates), move focus to
  // the new page's <main> and arm the route announcer so it reads the settled
  // page title once the route (including lazy chunks and async fetches) loads.
  createEffect(
    on(
      () => location.pathname,
      () => {
        cancelFocus?.();
        cancelFocus = focusMainAfterNavigation();
        routeAnnouncer.beginNavigation();
      },
      { defer: true },
    ),
  );

  return (
    <div class="app">
      <a href="#main" class="skip-link">
        {t("skipToContent", locale())}
      </a>
      <TopBar />
      {props.children}
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {routeAnnouncement()}
      </div>
    </div>
  );
};

const App: Component = () => (
  <Router root={Layout}>
    <Route path="/" component={HomePage} />
    <Route path="/publish" component={PublishPage} />
    <Route path="/manage" component={ManagePage} />
    <Route path="/:scope/:slug" component={AppDetailPage} />
    <Route path="/:scope" component={ScopePage} />
    <Route path="*" component={NotFoundPage} />
  </Router>
);

export default App;
