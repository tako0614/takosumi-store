import {
  createEffect,
  createResource,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import {
  invalidateListings,
  locale,
  me,
  oidcEnabled,
  setMe,
} from "../appstate.ts";
import { t, tagLabel } from "../lib/i18n.ts";
import { loginUrl, setHandle } from "../lib/account-client.ts";
import {
  bodyFromListing,
  createListing,
  updateListing,
  type PublishBody,
} from "../lib/publish-client.ts";
import {
  repoNameFromGitUrl,
  validateGitUrl,
  validateHandle,
  validateLogoUrl,
  validateSlug,
} from "../lib/publish-validation.ts";
import { fetchListingByScopeSlug } from "../lib/tcs-client.ts";
import { homeBase } from "../lib/servers.ts";
import { IconTile } from "../components/IconTile.tsx";
import type { ListingV2 } from "../../../spec/v2/listing.ts";

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

  createEffect(() => {
    const heading = editId()
      ? t("editApp", locale())
      : t("publishApp", locale());
    document.title = `${heading} — ${t("appName", locale())}`;
  });

  const [handleDraft, setHandleDraft] = createSignal("");
  const [handleErr, setHandleErr] = createSignal("");
  const submitHandle = async (e: Event) => {
    e.preventDefault();
    const check = validateHandle(handleDraft());
    if (check === "required") {
      setHandleErr(t("handleRequired", locale()));
      return;
    }
    if (check === "invalid") {
      setHandleErr(t("handleInvalid", locale()));
      return;
    }
    setHandleErr("");
    const r = await setHandle(handleDraft().trim());
    if (r.ok) setMe(r.me);
    else setHandleErr(r.message);
  };

  // Primary inputs — just a Git URL, a logo, and an optional name.
  const [git, setGit] = createSignal("");
  const [iconUrl, setIconUrl] = createSignal("");
  const [name, setName] = createSignal("");
  // Advanced — only user-meaningful presentation overrides.
  const [slug, setSlug] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagDraft, setTagDraft] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [errors, setErrors] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);

  // Touched flags for calm, non-nagging inline field validation.
  const [gitTouched, setGitTouched] = createSignal(false);
  const [logoTouched, setLogoTouched] = createSignal(false);
  const [slugTouched, setSlugTouched] = createSignal(false);

  const gitErr = (): string => {
    if (!gitTouched()) return "";
    const code = validateGitUrl(git());
    if (code === "required") return t("gitUrlRequired", locale());
    if (code === "invalid") return t("gitUrlInvalid", locale());
    return "";
  };
  const logoErr = (): string => {
    if (!logoTouched()) return "";
    return validateLogoUrl(iconUrl()) === "invalid"
      ? t("logoUrlInvalid", locale())
      : "";
  };
  const slugErr = (): string => {
    if (!slugTouched() || Boolean(editId())) return "";
    return validateSlug(slug()) === "invalid" ? t("slugInvalid", locale()) : "";
  };

  // Edit mode: load the existing discovery listing and prefill editable fields.
  // Install UX remains outside Store. A repository may propose it to Takosumi
  // through `.well-known/takosumi.json`, which Store never reads or edits.
  const [editListing] = createResource(
    () => editId() || null,
    async (id: string): Promise<ListingV2 | null> => {
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
    setTags([...(l.tags ?? [])]);
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

  const repoName = (): string => repoNameFromGitUrl(git());
  const effectiveName = () => name().trim() || repoName();
  const autoSlug = () => slugify(effectiveName());
  const previewIconUrl = () => {
    const trimmed = iconUrl().trim();
    return trimmed && validateLogoUrl(trimmed) === null ? trimmed : undefined;
  };
  const previewTagsText = () =>
    tags()
      .slice(0, 3)
      .map((tg) => tagLabel(tg, locale()))
      .join(" · ");

  const submit = async (e: Event) => {
    e.preventDefault();
    setGitTouched(true);
    setLogoTouched(true);
    setSlugTouched(true);
    if (gitErr() || logoErr() || slugErr()) {
      const focusId = gitErr()
        ? "publish-git"
        : logoErr()
          ? "publish-logo"
          : "publish-slug";
      const target = document.getElementById(focusId);
      const details = target?.closest("details");
      if (details && !details.open) details.open = true;
      target?.focus();
      return;
    }

    setBusy(true);
    setErrors([]);
    const display = effectiveName();
    const existing = editListing();

    // In edit mode, start from the existing discovery listing, then overlay the
    // editable display/source fields. Installer-owned UX is not a listing field.
    const base: PublishBody = existing
      ? bodyFromListing(existing)
      : {
          source: { git: "" },
          suggestedName: slugify(display),
          name: { ja: display, en: display },
          description: { ja: "", en: "" },
          badge: { ja: "", en: "" },
        };
    const body: PublishBody = {
      ...base,
      source: { git: git().trim() },
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
      invalidateListings();
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
    <main id="main" tabIndex={-1} class="page publish">
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
                <form
                  class="form handle-step"
                  onSubmit={submitHandle}
                  noValidate
                >
                  <label class="field" for="publish-handle">
                    <span>{t("setHandle", locale())}</span>
                    <input
                      id="publish-handle"
                      name="handle"
                      value={handleDraft()}
                      aria-invalid={Boolean(handleErr()) || undefined}
                      aria-describedby={
                        handleErr() ? "publish-handle-error" : undefined
                      }
                      onInput={(e) => {
                        setHandleDraft(e.currentTarget.value);
                        if (handleErr()) setHandleErr("");
                      }}
                      placeholder={t("handlePlaceholder", locale())}
                      autocomplete="username"
                    />
                  </label>
                  <Show when={handleErr()}>
                    <p
                      id="publish-handle-error"
                      class="field-error"
                      role="alert"
                    >
                      {handleErr()}
                    </p>
                  </Show>
                  <button type="submit" class="btn btn-primary">
                    {t("save", locale())}
                  </button>
                </form>
              }
            >
              <section
                class="publish-preview"
                aria-label={t("livePreview", locale())}
              >
                <span class="publish-preview-label muted">
                  {t("livePreview", locale())}
                </span>
                <div class="app-card publish-preview-card">
                  <IconTile
                    label={
                      effectiveName() || t("previewFallbackName", locale())
                    }
                    seed={`${who().handle}/${slug().trim() || autoSlug() || "preview"}`}
                    iconUrl={previewIconUrl()}
                    size={60}
                  />
                  <div class="app-card-text">
                    <span class="app-card-name">
                      {effectiveName() || t("previewFallbackName", locale())}
                    </span>
                    <span class="app-card-sub">
                      {previewTagsText() ||
                        `${who().handle}/${slug().trim() || autoSlug() || "app"}`}
                    </span>
                    <span class="app-card-desc">
                      {description().trim() ||
                        t("previewFallbackDesc", locale())}
                    </span>
                  </div>
                </div>
              </section>

              <form class="form publish-form" onSubmit={submit} noValidate>
                <div class="field">
                  <label for="publish-git">{t("gitUrl", locale())}</label>
                  <input
                    id="publish-git"
                    name="git"
                    type="url"
                    value={git()}
                    aria-invalid={Boolean(gitErr()) || undefined}
                    aria-describedby={
                      gitErr() ? "publish-git-error" : undefined
                    }
                    onInput={(e) => setGit(e.currentTarget.value)}
                    onBlur={() => setGitTouched(true)}
                    placeholder="https://github.com/you/app.git"
                    autocomplete="off"
                    required
                  />
                  <Show when={gitErr()}>
                    <p id="publish-git-error" class="field-error" role="alert">
                      {gitErr()}
                    </p>
                  </Show>
                </div>

                <div class="field">
                  <label for="publish-name">{t("displayName", locale())}</label>
                  <input
                    id="publish-name"
                    name="name"
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                    placeholder={
                      repoName() || t("displayNamePlaceholder", locale())
                    }
                    autocomplete="off"
                  />
                </div>

                <div class="field">
                  <label for="publish-logo">{t("logoUrl", locale())}</label>
                  <input
                    id="publish-logo"
                    name="iconUrl"
                    type="url"
                    value={iconUrl()}
                    aria-invalid={Boolean(logoErr()) || undefined}
                    aria-describedby={
                      logoErr() ? "publish-logo-error" : undefined
                    }
                    onInput={(e) => setIconUrl(e.currentTarget.value)}
                    onBlur={() => setLogoTouched(true)}
                    placeholder="https://…/icon.png"
                    autocomplete="off"
                  />
                  <Show when={logoErr()}>
                    <p id="publish-logo-error" class="field-error" role="alert">
                      {logoErr()}
                    </p>
                  </Show>
                </div>

                <details class="adv">
                  <summary>{t("advanced", locale())}</summary>
                  <div class="field">
                    <label for="publish-slug">{t("publicId", locale())}</label>
                    <div class="slug-row">
                      <span class="slug-scope">{who().handle}</span>
                      <span class="slug-sep">/</span>
                      <input
                        id="publish-slug"
                        name="slug"
                        value={slug()}
                        aria-invalid={Boolean(slugErr()) || undefined}
                        aria-describedby={
                          slugErr()
                            ? "publish-slug-error publish-slug-hint"
                            : "publish-slug-hint"
                        }
                        onInput={(e) => setSlug(e.currentTarget.value)}
                        onBlur={() => setSlugTouched(true)}
                        placeholder={
                          autoSlug() || t("slugPlaceholder", locale())
                        }
                        autocomplete="off"
                        disabled={Boolean(editId())}
                      />
                    </div>
                    <Show when={slugErr()}>
                      <p
                        id="publish-slug-error"
                        class="field-error"
                        role="alert"
                      >
                        {slugErr()}
                      </p>
                    </Show>
                    <span id="publish-slug-hint" class="field-hint">
                      {t("publicIdHint", locale())}
                    </span>
                  </div>

                  <div class="field">
                    <label for="publish-tags">{t("tagsField", locale())}</label>
                    <div class="tag-input">
                      <For each={tags()}>
                        {(tg) => (
                          <span class="tag-chip">
                            {tg}
                            <button
                              type="button"
                              class="tag-x"
                              aria-label={`${t("removeTag", locale())}: ${tg}`}
                              onClick={() => removeTag(tg)}
                            >
                              ×
                            </button>
                          </span>
                        )}
                      </For>
                      <input
                        id="publish-tags"
                        name="tags"
                        class="tag-entry"
                        value={tagDraft()}
                        aria-describedby="publish-tags-hint"
                        onInput={(e) => setTagDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.isComposing || e.keyCode === 229) return;
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
                    <span id="publish-tags-hint" class="field-hint">
                      {t("tagsHint", locale())}
                    </span>
                  </div>

                  <div class="field">
                    <label for="publish-description">
                      {t("descriptionField", locale())}
                    </label>
                    <textarea
                      id="publish-description"
                      name="description"
                      value={description()}
                      onInput={(e) => setDescription(e.currentTarget.value)}
                      rows={3}
                    />
                  </div>
                </details>

                <Show when={errors().length > 0}>
                  <ul class="form-errors" role="alert">
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
