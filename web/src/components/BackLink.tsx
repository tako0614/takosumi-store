import type { Component } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { locale } from "../appstate.ts";
import { t } from "../lib/i18n.ts";
import { navTracker } from "../lib/nav-history.ts";

/**
 * "‹ Back" link. When the previous history entry is inside this app it goes
 * back for real, so the catalog keeps the visitor's search, tag filter and
 * scroll position. Otherwise (deep link, reload) it navigates to `href`.
 * Modified clicks (new tab, etc.) keep the native link behavior.
 */
export const BackLink: Component<{ href?: string }> = (props) => {
  const navigate = useNavigate();
  const href = () => props.href ?? "/";
  return (
    <A
      href={href()}
      class="back-link"
      onClick={(e) => {
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }
        e.preventDefault();
        if (navTracker.canGoBack()) history.back();
        else navigate(href());
      }}
    >
      <span aria-hidden="true">‹</span> {t("back", locale())}
    </A>
  );
};
