import { createEffect, type Component } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { locale } from "../appstate.ts";
import { t } from "../lib/i18n.ts";
import { setPageTitle } from "../lib/nav-history.ts";
import { EmptyState } from "../components/states.tsx";

/** Catch-all for URLs that match no store route. */
export const NotFoundPage: Component = () => {
  const location = useLocation();
  createEffect(() => {
    void location.pathname;
    setPageTitle(`${t("notFoundTitle", locale())} — ${t("appName", locale())}`);
  });
  return (
    <main id="main" tabIndex={-1} class="page not-found">
      <div class="container container-narrow">
        <EmptyState
          heading
          glyph="🧭"
          title={t("notFoundTitle", locale())}
          message={t("notFoundHint", locale())}
          action={
            <A href="/" class="btn btn-primary">
              {t("browseCatalog", locale())}
            </A>
          }
        />
      </div>
    </main>
  );
};
