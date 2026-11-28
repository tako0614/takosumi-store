import {
  createEffect,
  createMemo,
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
  const [items, { mutate, refetch }] = createResource<OwnedListing[], unknown>(
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

  // Keep the list mounted during background `refetch()` ("refreshing") so
  // actions like Unpublish / Refresh never flash the whole-page skeleton or
  // tear down focused controls.
  const initialLoading = () =>
    items.state === "pending" || items.state === "unresolved";
  const initialError = () => items.state === "errored";
  const currentItems = createMemo<readonly OwnedListing[]>(() =>
    items.state === "errored" ? [] : (items.latest ?? []),
  );
  const listingById = createMemo(
    () => new Map(currentItems().map((item) => [item.id, item])),
  );
  const listingIds = createMemo(() => currentItems().map((item) => item.id));

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
    onOptimisticSuccess?: () => void,
  ): Promise<boolean> {
    const activeBefore = document.activeElement;
    const trigger =
      kind !== "delete" &&
      activeBefore instanceof HTMLElement &&
      activeBefore.closest(".manage-item-actions")
        ? activeBefore
        : null;
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
      onOptimisticSuccess?.();
      invalidateListings();
      void refetch();
      const label = pick(l.name, locale());
      announce(`${label}: ${t(successKey, locale())}`);
    } else {
      setErrId(l.id);
    }
    // Disabling a focused button drops focus to <body> in browsers; restore it
    // once re-enabled unless the user moved focus elsewhere in the meantime.
    if (trigger && trigger.isConnected) {
      queueMicrotask(() => {
        const active = document.activeElement;
        if (
          trigger.isConnected &&
          (!active ||
            active === document.body ||
            active === document.documentElement)
        ) {
          trigger.focus({ preventScroll: true });
        }
      });
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
      () => {
        mutate((prev) =>
          prev?.map((item) =>
            item.id === l.id ? { ...item, status: next } : item,
          ),
        );
      },
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
        () => {
          mutate((prev) => prev?.filter((item) => item.id !== target.id));
        },
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
            <Show when={!initialLoading()} fallback={<ManageSkeleton />}>
              <Show
                when={!initialError()}
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
                  when={listingIds().length > 0}
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
                    <For each={listingIds()}>
                      {(id) => {
                        const listing = () => listingById().get(id);
                        return (
                          <Show when={listing()}>
                            {(l) => {
                              const displayName = () =>
                                pick(l().name, locale());
                              const refreshLabel = () =>
                                isActionBusy(id, "refresh")
                                  ? t("refreshing", locale())
                                  : t("refreshVersion", locale());
                              const toggleLabel = () =>
                                isActionBusy(id, "toggle")
                                  ? l().status === "visible"
                                    ? t("unpublishing", locale())
                                    : t("republishing", locale())
                                  : l().status === "visible"
                                    ? t("unpublish", locale())
                                    : t("republish", locale());
                              const deleteLabel = () =>
                                isActionBusy(id, "delete")
                                  ? t("deleting", locale())
                                  : t("deleteAction", locale());
                              return (
                                <li
                                  class="manage-item"
                                  classList={{
                                    "is-hidden": l().status === "hidden",
                                  }}
                                >
                                  <IconTile
                                    label={displayName()}
                                    seed={l().id}
                                    iconUrl={l().iconUrl}
                                    size={52}
                                  />
                                  <div class="manage-item-main">
                                    <div class="manage-item-head">
                                      <Show
                                        when={l().status === "visible"}
                                        fallback={
                                          <span class="manage-item-name">
                                            {displayName()}
                                          </span>
                                        }
                                      >
                                        <A
                                          href={`/${encodeURIComponent(l().scope)}/${encodeURIComponent(l().slug)}`}
                                          class="manage-item-name"
                                        >
                                          {displayName()}
                                        </A>
                                      </Show>
                                      <span
                                        class="chip chip-mini"
                                        classList={{
                                          "chip-ok": l().status === "visible",
                                          "chip-muted": l().status === "hidden",
                                        }}
                                      >
                                        {l().status === "visible"
                                          ? t("statusVisible", locale())
                                          : t("statusHidden", locale())}
                                      </span>
                                    </div>
                                    <div class="manage-item-meta mono muted">
                                      {l().scope}/{l().slug}
                                    </div>
                                    <Show when={errId() === id}>
                                      <div class="field-error" role="alert">
                                        {t("actionFailed", locale())}
                                      </div>
                                    </Show>
                                  </div>
                                  <div class="manage-item-actions">
                                    <A
                                      href={`/publish?edit=${encodeURIComponent(l().id)}`}
                                      class="btn btn-secondary btn-sm"
                                      aria-label={`${t("edit", locale())}: ${displayName()}`}
                                    >
                                      {t("edit", locale())}
                                    </A>
                                    <button
                                      type="button"
                                      class="btn btn-ghost btn-sm"
                                      disabled={isBusy(id)}
                                      aria-label={`${refreshLabel()}: ${displayName()}`}
                                      onClick={() => void refresh(l())}
                                    >
                                      {refreshLabel()}
                                    </button>
                                    <button
                                      type="button"
                                      class="btn btn-ghost btn-sm"
                                      disabled={isBusy(id)}
                                      aria-label={`${toggleLabel()}: ${displayName()}`}
                                      onClick={() => void toggle(l())}
                                    >
                                      {toggleLabel()}
                                    </button>
                                    <button
                                      type="button"
                                      class="btn btn-ghost btn-sm btn-danger"
                                      disabled={isBusy(id)}
                                      aria-label={`${deleteLabel()}: ${displayName()}`}
                                      onClick={() => setPendingDelete(l())}
                                    >
                                      {deleteLabel()}
                                    </button>
                                  </div>
                                </li>
                              );
                            }}
                          </Show>
                        );
                      }}
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
