import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import { A } from "@solidjs/router";
import {
  accountLoaded,
  invalidateListings,
  locale,
  me,
  oidcEnabled,
} from "../appstate.ts";
import { pick, t, type StringKey } from "../lib/i18n.ts";
import { loginUrl } from "../lib/account-client.ts";
import {
  bodyFromListing,
  deleteListing,
  listMine,
  setVisibility,
  updateListing,
  type OwnedListing,
} from "../lib/publish-client.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { BackLink } from "../components/BackLink.tsx";
import { setPageTitle } from "../lib/nav-history.ts";
import { IconTile } from "../components/IconTile.tsx";
import { EmptyState, ErrorState } from "../components/states.tsx";

type ManageActionKind = "refresh" | "toggle" | "delete";

const ManageSkeleton: Component = () => (
  <div class="manage-list" aria-busy="true">
    <span class="sr-only" role="status">
      {t("loading", locale())}
    </span>
    <For each={[0, 1, 2]}>
      {() => (
        <div class="manage-item" aria-hidden="true">
          <span class="skel skel-icon manage-skel-icon" />
          <div class="manage-item-main">
            <span class="skel skel-line" style={{ width: "40%" }} />
            <span class="skel skel-line" style={{ width: "28%" }} />
          </div>
        </div>
      )}
    </For>
  </div>
);

export const ManagePage: Component = () => {
  const [items, { refetch }] = createResource<OwnedListing[], unknown>(
    me,
    async (who) => (who ? await listMine() : []),
  );
  const [busyAction, setBusyAction] = createSignal<{
    id: string;
    kind: ManageActionKind;
  } | null>(null);
  const [errId, setErrId] = createSignal("");
  const [statusMessage, setStatusMessage] = createSignal("");
  const [pendingDelete, setPendingDelete] = createSignal<OwnedListing | null>(
    null,
  );
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  const isBusy = (id: string) => busyAction()?.id === id;
  const isActionBusy = (id: string, kind: ManageActionKind) =>
    busyAction()?.id === id && busyAction()?.kind === kind;

  const announce = (msg: string) => {
    if (statusTimer) clearTimeout(statusTimer);
    setStatusMessage(msg);
    statusTimer = setTimeout(() => {
      setStatusMessage("");
      statusTimer = undefined;
    }, 4000);
  };

  onCleanup(() => {
    if (statusTimer) clearTimeout(statusTimer);
  });

  createEffect(() => {
    setPageTitle(`${t("myListings", locale())} — ${t("appName", locale())}`);
  });

  async function run(
    l: OwnedListing,
    kind: ManageActionKind,
    action: () => Promise<boolean>,
    successKey: StringKey,
  ): Promise<boolean> {
    setBusyAction({ id: l.id, kind });
    setErrId("");
    let ok = false;
    try {
      ok = await action();
    } catch {
      ok = false;
    } finally {
      setBusyAction(null);
    }
    if (ok) {
      invalidateListings();
      refetch();
      const label = pick(l.name, locale());
      announce(`${label}: ${t(successKey, locale())}`);
    } else {
      setErrId(l.id);
    }
    return ok;
  }

  const refresh = (l: OwnedListing) =>
    run(
      l,
      "refresh",
      async () => (await updateListing(l.id, bodyFromListing(l))).ok,
      "refreshed",
    );

  const toggle = (l: OwnedListing) => {
    const next = l.status === "visible" ? "hidden" : "visible";
    return run(
      l,
      "toggle",
      () => setVisibility(l.id, next),
      next === "hidden" ? "unpublished" : "republished",
    );
  };

  const confirmRemove = async () => {
    const target = pendingDelete();
    if (!target || isBusy(target.id)) return;
    try {
      await run(
        target,
        "delete",
        () => deleteListing(target.id, true),
        "deleted",
      );
    } finally {
      setPendingDelete(null);
    }
  };

  const deleteMessage = () => {
    const target = pendingDelete();
    if (!target) return "";
    const label = pick(target.name, locale());
    return `${label} (${target.scope}/${target.slug}) — ${t("confirmDelete", locale())}`;
  };

  return (
    <main id="main" tabIndex={-1} class="page manage">
      <div class="container container-narrow">
        <BackLink />
        <h1 class="page-title">{t("myListings", locale())}</h1>
        <p class="muted manage-sub">{t("manageSubtitle", locale())}</p>

        <div class="manage-status-wrap" role="status" aria-live="polite">
          <Show when={statusMessage()}>
            {(msg) => <p class="manage-status">{msg()}</p>}
          </Show>
        </div>

        <Show when={accountLoaded()} fallback={<ManageSkeleton />}>
          <Show
            when={me()}
            fallback={
              <div class="notice">
                <Show
                  when={oidcEnabled()}
                  fallback={
                    <p class="muted notice-text">{t("readOnly", locale())}</p>
                  }
                >
                  <p class="notice-text">{t("signInToManage", locale())}</p>
                  <a
                    class="btn btn-primary"
                    href={loginUrl("/manage")}
                    rel="external"
                  >
                    {t("signIn", locale())}
                  </a>
                </Show>
              </div>
            }
          >
            <Show when={!items.loading} fallback={<ManageSkeleton />}>
              <Show
                when={!items.error}
                fallback={
                  <ErrorState
                    title={t("errorTitle", locale())}
                    message={t("errorHint", locale())}
                    retryLabel={t("retry", locale())}
                    onRetry={() => void refetch()}
                  />
                }
              >
                <Show
                  when={(items() ?? []).length > 0}
                  fallback={
                    <EmptyState
                      glyph="📦"
                      title={t("noListings", locale())}
                      action={
                        <A href="/publish" class="btn btn-primary">
                          {t("publishFirst", locale())}
                        </A>
                      }
                    />
                  }
                >
                  <ul class="manage-list">
                    <For each={items()}>
                      {(l) => (
                        <li
                          class="manage-item"
                          classList={{ "is-hidden": l.status === "hidden" }}
                        >
                          <IconTile
                            label={pick(l.name, locale())}
                            seed={l.id}
                            iconUrl={l.iconUrl}
                            size={52}
                          />
                          <div class="manage-item-main">
                            <div class="manage-item-head">
                              <Show
                                when={l.status === "visible"}
                                fallback={
                                  <span class="manage-item-name">
                                    {pick(l.name, locale())}
                                  </span>
                                }
                              >
                                <A
                                  href={`/${encodeURIComponent(l.scope)}/${encodeURIComponent(l.slug)}`}
                                  class="manage-item-name"
                                >
                                  {pick(l.name, locale())}
                                </A>
                              </Show>
                              <span
                                class="chip chip-mini"
                                classList={{
                                  "chip-ok": l.status === "visible",
                                  "chip-muted": l.status === "hidden",
                                }}
                              >
                                {l.status === "visible"
                                  ? t("statusVisible", locale())
                                  : t("statusHidden", locale())}
                              </span>
                            </div>
                            <div class="manage-item-meta mono muted">
                              {l.scope}/{l.slug}
                            </div>
                            <Show when={errId() === l.id}>
                              <div class="field-error" role="alert">
                                {t("actionFailed", locale())}
                              </div>
                            </Show>
                          </div>
                          <div class="manage-item-actions">
                            <A
                              href={`/publish?edit=${encodeURIComponent(l.id)}`}
                              class="btn btn-secondary btn-sm"
                            >
                              {t("edit", locale())}
                            </A>
                            <button
                              type="button"
                              class="btn btn-ghost btn-sm"
                              disabled={isBusy(l.id)}
                              onClick={() => void refresh(l)}
                            >
                              {isActionBusy(l.id, "refresh")
                                ? t("refreshing", locale())
                                : t("refreshVersion", locale())}
                            </button>
                            <button
                              type="button"
                              class="btn btn-ghost btn-sm"
                              disabled={isBusy(l.id)}
                              onClick={() => void toggle(l)}
                            >
                              {isActionBusy(l.id, "toggle")
                                ? l.status === "visible"
                                  ? t("unpublishing", locale())
                                  : t("republishing", locale())
                                : l.status === "visible"
                                  ? t("unpublish", locale())
                                  : t("republish", locale())}
                            </button>
                            <button
                              type="button"
                              class="btn btn-ghost btn-sm btn-danger"
                              disabled={isBusy(l.id)}
                              onClick={() => setPendingDelete(l)}
                            >
                              {isActionBusy(l.id, "delete")
                                ? t("deleting", locale())
                                : t("deleteAction", locale())}
                            </button>
                          </div>
                        </li>
                      )}
                    </For>
                  </ul>
                  <p class="manage-hint">
                    <A href="/publish" class="btn btn-secondary">
                      + {t("publish", locale())}
                    </A>
                  </p>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete())}
        title={t("confirmDeleteTitle", locale())}
        message={deleteMessage()}
        confirmLabel={
          pendingDelete() && isActionBusy(pendingDelete()!.id, "delete")
            ? t("deleting", locale())
            : t("deleteAction", locale())
        }
        cancelLabel={t("cancel", locale())}
        danger
        busy={Boolean(pendingDelete() && isBusy(pendingDelete()!.id))}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmRemove()}
      />
    </main>
  );
};
