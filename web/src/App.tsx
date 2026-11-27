import {
  createEffect,
  lazy,
  onMount,
  type Component,
  type ParentComponent,
} from "solid-js";
import { Route, Router } from "@solidjs/router";
import { TopBar } from "./components/TopBar.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { AppDetailPage } from "./pages/AppDetailPage.tsx";
import { ScopePage } from "./pages/ScopePage.tsx";
import { loadAccount, locale } from "./appstate.ts";
import { t } from "./lib/i18n.ts";

const PublishPage = lazy(async () => ({
  default: (await import("./pages/PublishPage.tsx")).PublishPage,
}));
const ManagePage = lazy(async () => ({
  default: (await import("./pages/ManagePage.tsx")).ManagePage,
}));

const Layout: ParentComponent = (props) => {
  onMount(() => void loadAccount());
  createEffect(() => {
    document.documentElement.lang = locale();
  });
  return (
    <div class="app">
      <a href="#main" class="skip-link">
        {t("skipToContent", locale())}
      </a>
      <TopBar />
      {props.children}
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
    <Route path="*" component={HomePage} />
  </Router>
);

export default App;
