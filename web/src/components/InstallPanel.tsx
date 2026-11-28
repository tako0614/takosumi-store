import { createSignal, onCleanup, Show, type Component } from "solid-js";
import type { ListingV2 } from "../../../spec/v2/listing.ts";
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
  listing: ListingV2;
  locale: Locale;
}> = (props) => {
  const [origin, setOrigin] = createSignal(getTakosOrigin());
  const [editing, setEditing] = createSignal(!getTakosOrigin());
  const [draft, setDraft] = createSignal(getTakosOrigin());
  const [originErr, setOriginErr] = createSignal("");
  const [copyStatus, setCopyStatus] = createSignal<"" | "copied" | "failed">(
    "",
  );
  let originInputRef: HTMLInputElement | undefined;
  let openLinkRef: HTMLAnchorElement | undefined;
  let changeBtnRef: HTMLButtonElement | undefined;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  const clearCopyStatus = () => {
    if (copyTimer) {
      clearTimeout(copyTimer);
      copyTimer = undefined;
    }
    setCopyStatus("");
  };
  onCleanup(() => {
    if (copyTimer) clearTimeout(copyTimer);
  });

  const installUrl = () =>
    origin() ? buildInstallUrl(origin(), props.listing) : "";

  const cancelEdit = () => {
    if (!origin()) return;
    setDraft(origin());
    setOriginErr("");
    setEditing(false);
    queueMicrotask(() => changeBtnRef?.focus());
  };

  const saveOrigin = (e: Event) => {
    e.preventDefault();
    const normalized = setTakosOrigin(draft());
    if (normalized) {
      clearCopyStatus();
      setOrigin(normalized);
      setDraft(normalized);
      setOriginErr("");
      setEditing(false);
      queueMicrotask(() => openLinkRef?.focus());
    } else {
      setOriginErr(t("invalidOriginError", props.locale));
      queueMicrotask(() => originInputRef?.focus());
    }
  };

  const copy = async () => {
    const url = installUrl();
    if (!url) return;
    if (copyTimer) clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("copied");
      copyTimer = setTimeout(() => setCopyStatus(""), 2000);
    } catch {
      setCopyStatus("failed");
      copyTimer = setTimeout(() => setCopyStatus(""), 3000);
    }
  };

  return (
    <div class="install-panel">
      <Show
        when={origin() && !editing()}
        fallback={
          <form
            class="install-origin"
            onSubmit={saveOrigin}
            noValidate
            onKeyDown={(e) => {
              if (e.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape" && origin()) {
                e.preventDefault();
                cancelEdit();
              }
            }}
          >
            <label for="takos-origin">{t("whereInstall", props.locale)}</label>
            <div class="install-origin-row">
              <input
                ref={originInputRef}
                id="takos-origin"
                type="url"
                value={draft()}
                aria-invalid={Boolean(originErr()) || undefined}
                aria-describedby={
                  originErr() ? "takos-origin-error" : "takos-origin-hint"
                }
                onInput={(e) => {
                  setDraft(e.currentTarget.value);
                  if (originErr()) setOriginErr("");
                }}
                placeholder={t("takosOriginPlaceholder", props.locale)}
                autocomplete="url"
              />
              <div class="install-origin-buttons">
                <button type="submit" class="btn btn-primary">
                  {t("save", props.locale)}
                </button>
                <Show when={origin()}>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onClick={cancelEdit}
                  >
                    {t("cancel", props.locale)}
                  </button>
                </Show>
              </div>
            </div>
            <Show when={originErr()}>
              <p
                id="takos-origin-error"
                class="field-error install-error"
                role="alert"
              >
                {originErr()}
              </p>
            </Show>
            <p id="takos-origin-hint" class="install-hint">
              {t("installHint", props.locale)}
            </p>
          </form>
        }
      >
        <div class="install-actions">
          <a
            ref={openLinkRef}
            class="btn btn-primary btn-lg"
            href={installUrl()}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("openInTakos", props.locale)} ↗
          </a>
          <button type="button" class="btn btn-secondary" onClick={copy}>
            {copyStatus() === "copied"
              ? t("copied", props.locale)
              : t("copyLink", props.locale)}
          </button>
        </div>
        <div class="install-target-row">
          <span class="install-target-label">
            {t("installTarget", props.locale)}
          </span>
          <span class="install-target-origin mono">{origin()}</span>
          <button
            ref={changeBtnRef}
            type="button"
            class="btn btn-ghost btn-sm install-change-btn"
            onClick={() => {
              clearCopyStatus();
              setDraft(origin());
              setOriginErr("");
              setEditing(true);
              queueMicrotask(() => {
                originInputRef?.focus();
                originInputRef?.select();
              });
            }}
          >
            {t("change", props.locale)}
          </button>
        </div>
        <Show when={copyStatus() === "failed"}>
          <p class="field-error install-error" role="alert">
            {t("copyFailed", props.locale)}
          </p>
        </Show>
        <span class="sr-only" aria-live="polite">
          {copyStatus() === "copied" ? t("copied", props.locale) : ""}
        </span>
        <p class="install-hint">{t("installHint", props.locale)}</p>
      </Show>
    </div>
  );
};
