import { createSignal, Show, type Component } from "solid-js";
import type { Listing } from "../../../spec/listing.ts";
import type { Locale } from "../../../spec/api.ts";
import { t } from "../lib/i18n.ts";
import { buildInstallUrl } from "../lib/install-link.ts";
import { getTakosOrigin, setTakosOrigin } from "../lib/takos-origin.ts";

/**
 * The install call-to-action. The store never installs anything itself — it
 * builds a deep link to the visitor's OWN Takos `/install` screen, where they
 * confirm. The visitor sets their Takos origin once (kept in localStorage).
 */
export const InstallPanel: Component<{
  listing: Listing;
  locale: Locale;
}> = (props) => {
  const [origin, setOrigin] = createSignal(getTakosOrigin());
  const [editing, setEditing] = createSignal(!getTakosOrigin());
  const [draft, setDraft] = createSignal(getTakosOrigin());
  const [copied, setCopied] = createSignal(false);

  const installUrl = () =>
    origin() ? buildInstallUrl(origin(), props.listing) : "";

  const saveOrigin = (e: Event) => {
    e.preventDefault();
    const normalized = setTakosOrigin(draft());
    if (normalized) {
      setOrigin(normalized);
      setEditing(false);
    }
  };

  const copy = async () => {
    const url = installUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard may be unavailable; the link itself still works */
    }
  };

  return (
    <div class="install-panel">
      <Show
        when={origin() && !editing()}
        fallback={
          <form class="install-origin" onSubmit={saveOrigin}>
            <label for="takos-origin">{t("whereInstall", props.locale)}</label>
            <div class="install-origin-row">
              <input
                id="takos-origin"
                type="url"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                placeholder={t("takosOriginPlaceholder", props.locale)}
                autocomplete="url"
              />
              <button type="submit" class="btn btn-secondary">
                {t("save", props.locale)}
              </button>
            </div>
            <p class="install-hint">{t("installHint", props.locale)}</p>
          </form>
        }
      >
        <div class="install-actions">
          <a
            class="btn btn-primary btn-lg"
            href={installUrl()}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("openInTakos", props.locale)} ↗
          </a>
          <button type="button" class="btn btn-secondary" onClick={copy}>
            {copied() ? t("copied", props.locale) : t("copyLink", props.locale)}
          </button>
        </div>
        <p class="install-hint">
          {t("installHint", props.locale)}{" "}
          <button
            type="button"
            class="linklike"
            onClick={() => {
              setDraft(origin());
              setEditing(true);
            }}
          >
            {origin()} ({t("change", props.locale)})
          </button>
        </p>
      </Show>
    </div>
  );
};
