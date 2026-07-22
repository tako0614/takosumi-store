import {
  createEffect,
  createResource,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { locale, me, oidcEnabled, setMe } from "../appstate.ts";
import { t } from "../lib/i18n.ts";
import { loginUrl, setHandle } from "../lib/account-client.ts";
import {
  bodyFromListing,
  createListing,
  updateListing,
  type PublishBody,
} from "../lib/publish-client.ts";
import { fetchListingByScopeSlug } from "../lib/tcs-client.ts";
import { homeBase } from "../lib/servers.ts";
import type { Listing } from "../../../spec/listing.ts";

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const PublishPage: Component = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editId = () =>
    typeof searchParams.edit === "string" ? searchParams.edit : "";

  const [handleDraft, setHandleDraft] = createSignal("");
  const [handleErr, setHandleErr] = createSignal("");
  const submitHandle = async (e: Event) => {
    e.preventDefault();
    setHandleErr("");
    const r = await setHandle(handleDraft().trim());
    if (r.ok) setMe(r.me);
    else setHandleErr(r.message);
  };

  // Primary inputs — just a Git URL, a logo, and an optional name.
  const [git, setGit] = createSignal("");
  const [iconUrl, setIconUrl] = createSignal("");
  const [name, setName] = createSignal("");
  // Advanced — only the user-meaningful overrides. Everything technical
  // (kind, surface, provider) is defaulted server-side / below.
  const [slug, setSlug] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagDraft, setTagDraft] = createSignal("");
  const [path, setPath] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [errors, setErrors] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);

  // Edit mode: load the existing discovery listing and prefill editable fields.
  // Setup metadata remains in the repository's `.well-known/tcs.json`.
  const [editListing] = createResource(
    () => editId() || null,
    async (id: string): Promise<Listing | null> => {
      const [scope, slug] = id.split("/");
      if (!scope || !slug) return null;
      return fetchListingByScopeSlug(homeBase(), scope, slug);
    },
  );
  let didPrefill = false;
  createEffect(() => {
    const l = editListing();
    if (!l || didPrefill) return;
    didPrefill = true;
    setGit(l.source.git);
    setName(l.name.ja || l.name.en);
    setIconUrl(l.iconUrl ?? "");
    setSlug(l.slug);
    setTags([...l.tags]);
    setPath(l.source.path && l.source.path !== "." ? l.source.path : "");
    setDescription(l.description.ja || l.description.en);
  });

  // Free-form tag chips. Mirrors the server normalizer (lowercase slug, ≤8).
  const normTag = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
  const addTags = (raw: string) => {
    setTags((prev) => {
      const next = [...prev];
      for (const part of raw.split(",")) {
        const tag = normTag(part);
        if (tag && !next.includes(tag) && next.length < 8) next.push(tag);
      }
      return next;
    });
    setTagDraft("");
  };
  const removeTag = (tag: string) =>
    setTags((prev) => prev.filter((x) => x !== tag));

  const repoName = (): string => {
    try {
      const u = new URL(git().trim());
      return (
        u.pathname
          .replace(/\.git$/i, "")
          .replace(/\/+$/, "")
          .split("/")
          .pop() ?? ""
      ).trim();
    } catch {
      return "";
    }
  };
  const effectiveName = () => name().trim() || repoName();
  const autoSlug = () => slugify(effectiveName());

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    const display = effectiveName();
    const existing = editListing();

    // In edit mode, start from the existing discovery listing, then overlay the
    // editable display/source fields. Setup metadata stays in Git.
    const base: PublishBody = existing
      ? bodyFromListing(existing)
      : {
          source: { git: "", path: "" },
          kind: "worker",
          surface: "service",
          provider: "cloudflare",
          suggestedName: slugify(display),
          name: { ja: display, en: display },
          description: { ja: "", en: "" },
          badge: { ja: "", en: "" },
        };
    const body: PublishBody = {
      ...base,
      source: {
        git: git().trim(),
        path: path().trim(),
      },
      ...(!existing && slug().trim() ? { slug: slug().trim() } : {}),
      tags: tags(),
      name: { ja: display, en: display },
      description: { ja: description().trim(), en: description().trim() },
      ...(iconUrl().trim()
        ? { iconUrl: iconUrl().trim() }
        : { iconUrl: undefined }),
    };

    const res = existing
      ? await updateListing(editId(), body)
      : await createListing(body);
    setBusy(false);
    if (res.ok) {
      navigate(
        existing ? "/manage" : `/${res.listing.scope}/${res.listing.slug}`,
      );
    } else if (res.status === 429) {
      setErrors([t("quotaReached", locale())]);
    } else {
      setErrors(res.errors ?? [res.message]);
    }
  };

  return (
    <main class="page publish">
      <div class="container container-narrow">
        <A href="/" class="back-link">
          ‹ {t("back", locale())}
        </A>
        <h1 class="page-title">
          {editId() ? t("editApp", locale()) : t("publishApp", locale())}
        </h1>

        <Show
          when={me()}
          fallback={
            <div class="notice">
              <Show
                when={oidcEnabled()}
                fallback={
                  <p class="muted">
                    {locale() === "ja"
                      ? "このストアは現在 読み取り専用です（公開は無効）。"
                      : "This store is currently read-only (publishing disabled)."}
                  </p>
                }
              >
                <a
                  class="btn btn-primary"
                  href={loginUrl("/publish")}
                  rel="external"
                >
                  {t("signIn", locale())}
                </a>
              </Show>
            </div>
          }
        >
          {(who) => (
            <Show
              when={who().handle}
              fallback={
                <form class="form handle-step" onSubmit={submitHandle}>
                  <label class="field">
                    <span>{t("setHandle", locale())}</span>
                    <input
                      value={handleDraft()}
                      onInput={(e) => setHandleDraft(e.currentTarget.value)}
                      placeholder={t("handlePlaceholder", locale())}
                    />
                  </label>
                  <Show when={handleErr()}>
                    <p class="field-error">{handleErr()}</p>
                  </Show>
                  <button type="submit" class="btn btn-primary">
                    {t("save", locale())}
                  </button>
                </form>
              }
            >
              <form class="form publish-form" onSubmit={submit}>
                <label class="field">
                  <span>{t("gitUrl", locale())}</span>
                  <input
                    value={git()}
                    onInput={(e) => setGit(e.currentTarget.value)}
                    placeholder="https://github.com/you/app.git"
                    autocomplete="off"
                    required
                  />
                </label>
                <label class="field">
                  <span>{t("displayName", locale())}</span>
                  <input
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                    placeholder={
                      repoName() || t("displayNamePlaceholder", locale())
                    }
                    autocomplete="off"
                  />
                </label>
                <label class="field">
                  <span>{t("logoUrl", locale())}</span>
                  <input
                    value={iconUrl()}
                    onInput={(e) => setIconUrl(e.currentTarget.value)}
                    placeholder="https://…/icon.png"
                    autocomplete="off"
                  />
                </label>

                <details class="adv">
                  <summary>{t("advanced", locale())}</summary>
                  <label class="field">
                    <span>{t("publicId", locale())}</span>
                    <div class="slug-row">
                      <span class="slug-scope">{who().handle}</span>
                      <span class="slug-sep">/</span>
                      <input
                        value={slug()}
                        onInput={(e) => setSlug(e.currentTarget.value)}
                        placeholder={
                          autoSlug() || t("slugPlaceholder", locale())
                        }
                        autocomplete="off"
                        disabled={Boolean(editId())}
                      />
                    </div>
                    <span class="field-hint">
                      {t("publicIdHint", locale())}
                    </span>
                  </label>
                  <label class="field">
                    <span>{t("tagsField", locale())}</span>
                    <div class="tag-input">
                      <For each={tags()}>
                        {(tg) => (
                          <span class="tag-chip">
                            {tg}
                            <button
                              type="button"
                              class="tag-x"
                              aria-label={t("removeTag", locale())}
                              onClick={() => removeTag(tg)}
                            >
                              ×
                            </button>
                          </span>
                        )}
                      </For>
                      <input
                        class="tag-entry"
                        value={tagDraft()}
                        onInput={(e) => setTagDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === ",") {
                            e.preventDefault();
                            addTags(tagDraft());
                          } else if (
                            e.key === "Backspace" &&
                            !tagDraft() &&
                            tags().length > 0
                          ) {
                            removeTag(tags()[tags().length - 1]!);
                          }
                        }}
                        onBlur={() => {
                          if (tagDraft().trim()) addTags(tagDraft());
                        }}
                        placeholder={
                          tags().length ? "" : t("tagsPlaceholder", locale())
                        }
                        autocomplete="off"
                      />
                    </div>
                    <span class="field-hint">{t("tagsHint", locale())}</span>
                  </label>
                  <label class="field">
                    <span>path</span>
                    <input
                      value={path()}
                      onInput={(e) => setPath(e.currentTarget.value)}
                      placeholder="(repo root)"
                    />
                  </label>
                  <label class="field">
                    <span>{t("descriptionField", locale())}</span>
                    <textarea
                      value={description()}
                      onInput={(e) => setDescription(e.currentTarget.value)}
                      rows={3}
                    />
                  </label>
                </details>

                <Show when={errors().length > 0}>
                  <ul class="form-errors">
                    <For each={errors()}>{(err) => <li>{err}</li>}</For>
                  </ul>
                </Show>

                <button type="submit" class="btn btn-primary" disabled={busy()}>
                  {busy()
                    ? t("loading", locale())
                    : editId()
                      ? t("updateAction", locale())
                      : t("publishAction", locale())}
                </button>
              </form>
            </Show>
          )}
        </Show>
      </div>
    </main>
  );
};
