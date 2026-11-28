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
import { Route, Router, useLocation } from "@solidjs/router";
import { TopBar } from "./components/TopBar.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { AppDetailPage } from "./pages/AppDetailPage.tsx";
import { ScopePage } from "./pages/ScopePage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { loadAccount, locale } from "./appstate.ts";
import { t } from "./lib/i18n.ts";
import { focusMainAfterNavigation, navTracker } from "./lib/nav-history.ts";

const PublishPage = lazy(async () => ({
  default: (await import("./pages/PublishPage.tsx")).PublishPage,
}));
const ManagePage = lazy(async () => ({
  default: (await import("./pages/ManagePage.tsx")).ManagePage,
}));

const Layout: ParentComponent = (props) => {
  const location = useLocation();
  const [routeAnnouncement, setRouteAnnouncement] = createSignal("");
  let popped = false;
  let cancelFocus: (() => void) | undefined;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    void loadAccount();
    const onPop = () => {
      popped = true;
    };
    window.addEventListener("popstate", onPop);
    onCleanup(() => window.removeEventListener("popstate", onPop));
  });
  onCleanup(() => {
    cancelFocus?.();
    if (announceTimer) clearTimeout(announceTimer);
  });

  createEffect(() => {
    document.documentElement.lang = locale();
  });

  // On client-side route changes (not query-only filter updates), move focus to
  // the new page's <main> and announce its title, so keyboard and screen-reader
  // users land on the new content instead of a lost focus on <body>.
  createEffect(
    on(
      () => location.pathname,
      () => {
        navTracker.onRouteChange(popped);
        popped = false;
        cancelFocus?.();
        cancelFocus = focusMainAfterNavigation();
        if (announceTimer) clearTimeout(announceTimer);
        setRouteAnnouncement("");
        // Page titles are set by each page's own effect; read it a beat later.
        announceTimer = setTimeout(
          () => setRouteAnnouncement(document.title),
          120,
        );
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
