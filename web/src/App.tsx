import { onMount, type Component, type ParentComponent } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { TopBar } from "./components/TopBar.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { AppDetailPage } from "./pages/AppDetailPage.tsx";
import { ScopePage } from "./pages/ScopePage.tsx";
import { PublishPage } from "./pages/PublishPage.tsx";
import { ManagePage } from "./pages/ManagePage.tsx";
import { loadAccount, locale } from "./appstate.ts";
import { t } from "./lib/i18n.ts";

const Layout: ParentComponent = (props) => {
  onMount(() => void loadAccount());
  return (
    <div class="app">
      <TopBar />
      {props.children}
      <footer class="footer">
        <div class="container">
          <span>{t("appName", locale())}</span>
          <span class="footer-sep">·</span>
          <span class="muted">{t("tagline", locale())}</span>
        </div>
      </footer>
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
