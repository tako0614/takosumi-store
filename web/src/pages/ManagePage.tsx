import {
  createResource,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";
import { A } from "@solidjs/router";
import { locale, me, oidcEnabled } from "../appstate.ts";
import { pick, t } from "../lib/i18n.ts";
import { loginUrl } from "../lib/account-client.ts";
import {
  bodyFromListing,
  deleteListing,
  listMine,
  setVisibility,
  updateListing,
  type OwnedListing,
} from "../lib/publish-client.ts";
import { IconTile } from "../components/IconTile.tsx";
import { EmptyState } from "../components/states.tsx";

export const ManagePage: Component = () => {
  const [items, { refetch }] = createResource<OwnedListing[], unknown>(
    me,
    async (who) => (who ? await listMine() : []),
  );
  const [busyId, setBusyId] = createSignal("");
  const [errId, setErrId] = createSignal("");

  async function run(id: string, action: () => Promise<boolean>) {
    setBusyId(id);
    setErrId("");
    const ok = await action();
    setBusyId("");
    if (ok) refetch();
    else setErrId(id);
  }

  const refresh = (l: OwnedListing) =>
    run(l.id, async () => (await updateListing(l.id, bodyFromListing(l))).ok);

  const toggle = (l: OwnedListing) =>
    run(l.id, () =>
      setVisibility(l.id, l.status === "visible" ? "hidden" : "visible"),
    );

  const remove = (l: OwnedListing) => {
    if (!window.confirm(t("confirmDelete", locale()))) return;
    run(l.id, () => deleteListing(l.id, true));
  };

  return (
    <main class="page manage">
      <div class="container container-narrow">
        <A href="/" class="back-link">
          ‹ {t("back", locale())}
        </A>
        <h1 class="page-title">{t("myListings", locale())}</h1>
        <p class="muted manage-sub">{t("manageSubtitle", locale())}</p>

        <Show
          when={me()}
          fallback={
            <div class="notice">
              <Show
                when={oidcEnabled()}
                fallback={
                  <p class="muted">
                    {locale() === "ja"
                      ? "このストアは現在 読み取り専用です。"
                      : "This store is currently read-only."}
                  </p>
                }
              >
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
          <Show
            when={!items.loading}
            fallback={<p class="muted">{t("loading", locale())}</p>}
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
                          <A
                            href={`/${encodeURIComponent(l.scope)}/${encodeURIComponent(l.slug)}`}
                            class="manage-item-name"
                          >
                            {pick(l.name, locale())}
                          </A>
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
                          <Show when={l.source.path && l.source.path !== "."}>
                            {" "}
                            · {l.source.path}
                          </Show>
                        </div>
                        <Show when={errId() === l.id}>
                          <div class="field-error">
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
                          disabled={busyId() === l.id}
                          onClick={() => refresh(l)}
                        >
                          {busyId() === l.id
                            ? t("refreshing", locale())
                            : t("refreshVersion", locale())}
                        </button>
                        <button
                          type="button"
                          class="btn btn-ghost btn-sm"
                          disabled={busyId() === l.id}
                          onClick={() => toggle(l)}
                        >
                          {l.status === "visible"
                            ? t("unpublish", locale())
                            : t("republish", locale())}
                        </button>
                        <button
                          type="button"
                          class="btn btn-ghost btn-sm btn-danger"
                          disabled={busyId() === l.id}
                          onClick={() => remove(l)}
                        >
                          {t("deleteAction", locale())}
                        </button>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
              <p class="muted manage-hint">
                <A href="/publish" class="linklike">
                  + {t("publish", locale())}
                </A>
              </p>
            </Show>
          </Show>
        </Show>
      </div>
    </main>
  );
};
