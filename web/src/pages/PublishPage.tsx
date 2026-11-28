import {
  createEffect,
  createResource,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";
import { A, useLocation, useNavigate, useSearchParams } from "@solidjs/router";
import {
  accountLoaded,
  invalidateListings,
  locale,
  me,
  oidcEnabled,
  setMe,
} from "../appstate.ts";
import { pick, t, tagLabel } from "../lib/i18n.ts";
import { loginUrl, setHandle } from "../lib/account-client.ts";
import {
  bodyFromListing,
  createListing,
  listMine,
  updateListing,
  type PublishBody,
} from "../lib/publish-client.ts";
import {
  draftFromLocalized,
  emptyLocalizedDraft,
  primaryText,
  resolveLocalized,
  secondaryText,
  setPrimaryText,
  setSecondaryText,
  type LocalizedDraft,
} from "../lib/publish-localized.ts";
import {
  deriveAutoSlug,
  MAX_TAGS,
  parseTagInput,
  repoNameFromGitUrl,
  slugify,
  validateDescriptionLength,
  validateGitUrl,
  validateHandle,
  validateLogoUrl,
  validateNameLength,
  validateSlug,
  type TagFeedbackReason,
} from "../lib/publish-validation.ts";
import { navTracker, setPageTitle } from "../lib/nav-history.ts";
import { BackLink } from "../components/BackLink.tsx";
import { IconTile } from "../components/IconTile.tsx";
import { EmptyState, ErrorState } from "../components/states.tsx";
import type { Locale } from "../../../spec/api.ts";
import type { ListingV2 } from "../../../spec/v2/listing.ts";

type LocaleTouched = { readonly ja: boolean; readonly en: boolean };
const UNTOUCHED_LOCALES: LocaleTouched = { ja: false, en: false };
const ALL_TOUCHED_LOCALES: LocaleTouched = { ja: true, en: true };
const otherLocale = (loc: Locale): Locale => (loc === "ja" ? "en" : "ja");

const PublishSkeleton: Component = () => (
  <div class="publish-skel" aria-busy="true">
    <span class="sr-only" role="status">
      {t("loading", locale())}
    </span>
    <div class="app-card skeleton-card" aria-hidden="true">
      <span class="skel skel-icon" />
      <div class="app-card-text">
        <span class="skel skel-line" style={{ width: "45%" }} />
        <span class="skel skel-line" style={{ width: "30%" }} />
        <span class="skel skel-line" style={{ width: "75%" }} />
      </div>
    </div>
    <span class="skel publish-skel-field" aria-hidden="true" />
    <span class="skel publish-skel-field" aria-hidden="true" />
    <span class="skel publish-skel-field" aria-hidden="true" />
  </div>
);

type HandleErrorState =
  "" | "required" | "invalid" | "network" | { server: string };

export const PublishPage: Component = () => {
  const navigate = useNavigate();
  const route = useLocation();
  const [searchParams] = useSearchParams();
  const editId = () =>
    typeof searchParams.edit === "string" ? searchParams.edit : "";

  const [handleDraft, setHandleDraft] = createSignal("");
  const [handleErrState, setHandleErrState] =
    createSignal<HandleErrorState>("");
  const [handleBusy, setHandleBusy] = createSignal(false);
  let handleInputRef: HTMLInputElement | undefined;
  const handleErr = (): string => {
    const state = handleErrState();
    if (!state) return "";
    if (state === "required") return t("handleRequired", locale());
    if (state === "invalid") return t("handleInvalid", locale());
    if (state === "network") return t("networkError", locale());
    return state.server;
  };
  const submitHandle = async (e: Event) => {
    e.preventDefault();
    if (handleBusy()) return;
    const check = validateHandle(handleDraft());
    if (check === "required" || check === "invalid") {
      setHandleErrState(check);
      queueMicrotask(() => handleInputRef?.focus());
      return;
    }
    setHandleErrState("");
    setHandleBusy(true);
    try {
      const r = await setHandle(handleDraft().trim());
      if (r.ok) setMe(r.me);
      else
        setHandleErrState(
          r.message === "Network error" ? "network" : { server: r.message },
        );
    } finally {
      setHandleBusy(false);
    }
  };

  // Primary inputs — just a Git URL, a logo, and an optional name.
  const [git, setGit] = createSignal("");
  const [iconUrl, setIconUrl] = createSignal("");
  const [nameDraft, setNameDraft] = createSignal<LocalizedDraft>(
    emptyLocalizedDraft(),
  );
  // Advanced — only user-meaningful presentation overrides (including optional
  // bilingual JA/EN overrides that keep single-language publishing effortless).
  const [slug, setSlug] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagDraft, setTagDraft] = createSignal("");
  const [tagFeedback, setTagFeedback] = createSignal<TagFeedbackReason>("");
  const [descDraft, setDescDraft] = createSignal<LocalizedDraft>(
    emptyLocalizedDraft(),
  );
  const [advOpen, setAdvOpen] = createSignal(false);
  const [errors, setErrors] = createSignal<string[]>([]);
  const [quotaErr, setQuotaErr] = createSignal(false);
  const [networkErr, setNetworkErr] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let tagInputRef: HTMLInputElement | undefined;

  // Touched flags for calm, non-nagging inline field validation.
  // Keyed by underlying locale (`ja`/`en`) for bilingual fields so switching
  // the UI language preserves error visibility on the same value.
  const [gitTouched, setGitTouched] = createSignal(false);
  const [nameTouched, setNameTouched] =
    createSignal<LocaleTouched>(UNTOUCHED_LOCALES);
  const [logoTouched, setLogoTouched] = createSignal(false);
  const [slugTouched, setSlugTouched] = createSignal(false);
  const [descTouched, setDescTouched] =
    createSignal<LocaleTouched>(UNTOUCHED_LOCALES);

  const touchPrimaryLocale = (
    draft: LocalizedDraft,
    setter: (fn: (prev: LocaleTouched) => LocaleTouched) => void,
  ) => {
    const loc = locale();
    setter((prev) =>
      draft.split ? { ...prev, [loc]: true } : ALL_TOUCHED_LOCALES,
    );
  };
  const touchSecondaryLocale = (
    setter: (fn: (prev: LocaleTouched) => LocaleTouched) => void,
  ) => {
    const alt = otherLocale(locale());
    setter((prev) => ({ ...prev, [alt]: true }));
  };

  const repoName = (): string => repoNameFromGitUrl(git());
  const resolvedName = () => resolveLocalized(nameDraft(), repoName());
  const resolvedDescription = () => resolveLocalized(descDraft());
  const autoSlug = () => deriveAutoSlug(resolvedName(), git());

  const gitErr = (): string => {
    if (!gitTouched()) return "";
    const code = validateGitUrl(git());
    if (code === "required") return t("gitUrlRequired", locale());
    if (code === "invalid") return t("gitUrlInvalid", locale());
    return "";
  };
  const nameErr = (): string => {
    const loc = locale();
    if (!nameTouched()[loc]) return "";
    return validateNameLength(primaryText(nameDraft(), loc)) === "too_long"
      ? t("nameTooLong", loc)
      : "";
  };
  const altNameErr = (): string => {
    const loc = locale();
    if (!nameTouched()[otherLocale(loc)]) return "";
    return validateNameLength(secondaryText(nameDraft(), loc)) === "too_long"
      ? t("nameTooLong", loc)
      : "";
  };
  const logoErr = (): string => {
    if (!logoTouched()) return "";
    return validateLogoUrl(iconUrl()) === "invalid"
      ? t("logoUrlInvalid", locale())
      : "";
  };
  const slugErr = (): string => {
    if (!slugTouched() || Boolean(editId())) return "";
    if (validateSlug(slug()) === "invalid") return t("slugInvalid", locale());
    if (!slug().trim() && validateGitUrl(git()) === null && !autoSlug()) {
      return t("slugRequiredAscii", locale());
    }
    return "";
  };
  const descErr = (): string => {
    const loc = locale();
    if (!descTouched()[loc]) return "";
    return validateDescriptionLength(primaryText(descDraft(), loc)) ===
      "too_long"
      ? t("descriptionTooLong", loc)
      : "";
  };
  const altDescErr = (): string => {
    const loc = locale();
    if (!descTouched()[otherLocale(loc)]) return "";
    return validateDescriptionLength(secondaryText(descDraft(), loc)) ===
      "too_long"
      ? t("descriptionTooLong", loc)
      : "";
  };

  // Edit mode: load from the publisher's own listings so unlisted (`hidden`)
  // listings are editable too and non-owned ids cleanly resolve as not-found.
  // Install UX remains outside Store. A repository may propose it to Takosumi
  // through `.well-known/takosumi.json`, which Store never reads or edits.
  const [editListing, { refetch: refetchEdit }] = createResource(
    () => (me() && editId() ? ([me()!.id, editId()] as const) : null),
    async ([, id]): Promise<ListingV2 | null> => {
      const mine = await listMine();
      return mine.find((item) => item.id === id) ?? null;
    },
  );
  const editLoading = () => Boolean(editId() && me() && editListing.loading);
  const editError = () =>
    Boolean(editId() && me() && !editListing.loading && editListing.error);
  const editNotFound = () =>
    Boolean(
      editId() &&
      me() &&
      !editListing.loading &&
      !editListing.error &&
      !editListing(),
    );

  createEffect(() => {
    const heading = editId()
      ? t("editApp", locale())
      : t("publishApp", locale());
    setPageTitle(
      `${heading} — ${t("appName", locale())}`,
      !accountLoaded() || editLoading(),
    );
  });

  let prefilledFor: string | null = null;
  const resetFormFields = () => {
    setGit("");
    setNameDraft(emptyLocalizedDraft());
    setIconUrl("");
    setSlug("");
    setTags([]);
    setTagDraft("");
    setTagFeedback("");
    setDescDraft(emptyLocalizedDraft());
    setErrors([]);
    setQuotaErr(false);
    setNetworkErr(false);
    setGitTouched(false);
    setNameTouched(UNTOUCHED_LOCALES);
    setLogoTouched(false);
    setSlugTouched(false);
    setDescTouched(UNTOUCHED_LOCALES);
    setAdvOpen(false);
  };
  createEffect(() => {
    const id = editId();
    if (!id) {
      if (prefilledFor !== null) {
        prefilledFor = null;
        resetFormFields();
      }
      return;
    }
    if (editListing.loading || editListing.error) return;
    const l = editListing();
    if (!l || prefilledFor === id) return;
    prefilledFor = id;
    const nextName = draftFromLocalized(l.name);
    const nextDesc = draftFromLocalized(l.description);
    setGit(l.source.git);
    setNameDraft(nextName);
    setIconUrl(l.iconUrl ?? "");
    setSlug(l.slug);
    setTags([...(l.tags ?? [])]);
    setTagDraft("");
    setTagFeedback("");
    setDescDraft(nextDesc);
    setErrors([]);
    setQuotaErr(false);
    setNetworkErr(false);
    setGitTouched(false);
    setNameTouched(UNTOUCHED_LOCALES);
    setLogoTouched(false);
    setSlugTouched(false);
    setDescTouched(UNTOUCHED_LOCALES);
    setAdvOpen(
      Boolean(
        (l.tags ?? []).length > 0 ||
        l.description.ja.trim() ||
        l.description.en.trim() ||
        nextName.split,
      ),
    );
  });

  // Free-form tag chips. Mirrors the server normalizer (lowercase ASCII slug, ≤8)
  // and surfaces a brief hint when non-ASCII/duplicate/over-limit tokens are skipped.
  const addTags = (raw: string) => {
    const result = parseTagInput(raw, tags(), MAX_TAGS);
    setTags(result.next);
    setTagFeedback(result.feedback);
    setTagDraft("");
  };
  const removeTag = (tag: string) => {
    setTags((prev) => prev.filter((x) => x !== tag));
    setTagFeedback("");
  };
  const tagFeedbackText = (): string => {
    const reason = tagFeedback();
    if (reason === "non_ascii") return t("tagsNonAsciiHint", locale());
    if (reason === "duplicate") return t("tagsDuplicateHint", locale());
    if (reason === "limit_reached") return t("tagsLimitReached", locale());
    return "";
  };

  const previewName = () => pick(resolvedName(), locale());
  const previewDesc = () => pick(resolvedDescription(), locale());
  const previewIconUrl = () => {
    const trimmed = iconUrl().trim();
    return trimmed && validateLogoUrl(trimmed) === null ? trimmed : undefined;
  };
  const previewTagsText = () =>
    tags()
      .slice(0, 3)
      .map((tg) => tagLabel(tg, locale()))
      .join(" · ");

  const displayedErrors = () =>
    quotaErr()
      ? [t("quotaReached", locale())]
      : networkErr()
        ? [t("networkError", locale())]
        : errors();

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    const existing = editId()
      ? editListing.error
        ? null
        : editListing()
      : null;
    if (editId() && !existing) return;
    setGitTouched(true);
    setNameTouched(ALL_TOUCHED_LOCALES);
    setLogoTouched(true);
    setSlugTouched(true);
    setDescTouched(ALL_TOUCHED_LOCALES);
    const firstInvalid = gitErr()
      ? { id: "publish-git", adv: false }
      : nameErr()
        ? { id: "publish-name", adv: false }
        : logoErr()
          ? { id: "publish-logo", adv: false }
          : slugErr()
            ? { id: "publish-slug", adv: true }
            : descErr()
              ? { id: "publish-description", adv: true }
              : altNameErr()
                ? { id: "publish-alt-name", adv: true }
                : altDescErr()
                  ? { id: "publish-alt-description", adv: true }
                  : null;
    if (firstInvalid) {
      if (firstInvalid.adv) setAdvOpen(true);
      queueMicrotask(() => document.getElementById(firstInvalid.id)?.focus());
      return;
    }

    setBusy(true);
    setErrors([]);
    setQuotaErr(false);
    setNetworkErr(false);
    const finalName = resolvedName();
    const finalDesc = resolvedDescription();
    const explicitSlug = slug().trim();
    const suggested = autoSlug() || slugify(explicitSlug);

    // In edit mode, start from the existing discovery listing, then overlay the
    // editable display/source fields while preserving any reviewed module path.
    const base: PublishBody = existing
      ? bodyFromListing(existing)
      : {
          source: { git: "" },
          suggestedName: suggested,
          name: finalName,
          description: finalDesc,
          badge: { ja: "", en: "" },
        };
    const body: PublishBody = {
      ...base,
      source: {
        git: git().trim(),
        ...(base.source.path ? { path: base.source.path } : {}),
      },
      ...(!existing && explicitSlug ? { slug: explicitSlug } : {}),
      tags: tags(),
      name: finalName,
      description: finalDesc,
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
      if (existing) {
        // When edit was opened from /manage, pop back so we don't leave a
        // duplicate /manage entry in browser history.
        const delta = navTracker.backDelta();
        if (delta < 0 && navTracker.previousPathname() === "/manage") {
          if (delta === -1) history.back();
          else history.go(delta);
        } else {
          navigate("/manage", { replace: true });
        }
      } else {
        // Replace the form entry so "Back" never returns to a submitted form.
        navigate(`/${res.listing.scope}/${res.listing.slug}`, {
          replace: true,
        });
      }
    } else if (res.status === 429) {
      setQuotaErr(true);
    } else if (res.status === 0) {
      setNetworkErr(true);
    } else {
      setErrors(res.errors ?? [res.message]);
    }
  };

  return (
    <main id="main" tabIndex={-1} class="page publish">
      <div class="container container-narrow">
        <BackLink />
        <h1 class="page-title">
          {editId() ? t("editApp", locale()) : t("publishApp", locale())}
        </h1>

        <Show when={accountLoaded()} fallback={<PublishSkeleton />}>
          <Show
            when={me()}
            fallback={
              <div class="notice">
                <Show
                  when={oidcEnabled()}
                  fallback={
                    <p class="muted notice-text">
                      {t("readOnlyPublish", locale())}
                    </p>
                  }
                >
                  <p class="notice-text">{t("signInToPublish", locale())}</p>
                  <a
                    class="btn btn-primary"
                    href={loginUrl(route.pathname + route.search)}
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
                    <div class="field">
                      <label for="publish-handle">
                        {t("setHandle", locale())}
                      </label>
                      <input
                        ref={handleInputRef}
                        id="publish-handle"
                        name="handle"
                        value={handleDraft()}
                        aria-invalid={Boolean(handleErr()) || undefined}
                        aria-describedby={
                          handleErr()
                            ? "publish-handle-error publish-handle-hint"
                            : "publish-handle-hint"
                        }
                        onInput={(e) => {
                          setHandleDraft(e.currentTarget.value);
                          if (handleErrState()) setHandleErrState("");
                        }}
                        placeholder={t("handlePlaceholder", locale())}
                        autocomplete="username"
                      />
                      <Show when={handleErr()}>
                        <p
                          id="publish-handle-error"
                          class="field-error"
                          role="alert"
                        >
                          {handleErr()}
                        </p>
                      </Show>
                      <span id="publish-handle-hint" class="field-hint">
                        {t("handleHint", locale())}
                      </span>
                    </div>
                    <button
                      type="submit"
                      class="btn btn-primary"
                      disabled={handleBusy()}
                    >
                      {handleBusy()
                        ? t("loading", locale())
                        : t("save", locale())}
                    </button>
                  </form>
                }
              >
                <Show when={!editLoading()} fallback={<PublishSkeleton />}>
                  <Show
                    when={!editError()}
                    fallback={
                      <ErrorState
                        title={t("errorTitle", locale())}
                        message={t("errorHint", locale())}
                        retryLabel={t("retry", locale())}
                        onRetry={() => void refetchEdit()}
                      />
                    }
                  >
                    <Show
                      when={!editNotFound()}
                      fallback={
                        <EmptyState
                          glyph="🧩"
                          title={t("editNotFoundTitle", locale())}
                          message={t("editNotFoundHint", locale())}
                          action={
                            <A href="/manage" class="btn btn-primary">
                              {t("backToManage", locale())}
                            </A>
                          }
                        />
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
                              previewName() ||
                              t("previewFallbackName", locale())
                            }
                            seed={`${who().handle}/${slug().trim() || autoSlug() || "preview"}`}
                            iconUrl={previewIconUrl()}
                            size={60}
                          />
                          <div class="app-card-text">
                            <span class="app-card-name">
                              {previewName() ||
                                t("previewFallbackName", locale())}
                            </span>
                            <span class="app-card-sub">
                              {previewTagsText() ||
                                `${who().handle}/${slug().trim() || autoSlug() || "app"}`}
                            </span>
                            <span class="app-card-desc">
                              {previewDesc() ||
                                t("previewFallbackDesc", locale())}
                            </span>
                          </div>
                        </div>
                      </section>

                      <form
                        class="form publish-form"
                        onSubmit={submit}
                        noValidate
                      >
                        <div class="field">
                          <label for="publish-git">
                            {t("gitUrl", locale())}
                          </label>
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
                            <p
                              id="publish-git-error"
                              class="field-error"
                              role="alert"
                            >
                              {gitErr()}
                            </p>
                          </Show>
                        </div>

                        <div class="field">
                          <label for="publish-name">
                            {t("displayName", locale())}
                          </label>
                          <input
                            id="publish-name"
                            name="name"
                            value={primaryText(nameDraft(), locale())}
                            aria-invalid={Boolean(nameErr()) || undefined}
                            aria-describedby={
                              nameErr() ? "publish-name-error" : undefined
                            }
                            onInput={(e) =>
                              setNameDraft((prev) =>
                                setPrimaryText(
                                  prev,
                                  locale(),
                                  e.currentTarget.value,
                                ),
                              )
                            }
                            onBlur={() =>
                              touchPrimaryLocale(nameDraft(), setNameTouched)
                            }
                            placeholder={
                              secondaryText(nameDraft(), locale()).trim() ||
                              repoName() ||
                              t("displayNamePlaceholder", locale())
                            }
                            autocomplete="off"
                          />
                          <Show when={nameErr()}>
                            <p
                              id="publish-name-error"
                              class="field-error"
                              role="alert"
                            >
                              {nameErr()}
                            </p>
                          </Show>
                        </div>

                        <div class="field">
                          <label for="publish-logo">
                            {t("logoUrl", locale())}
                          </label>
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
                            <p
                              id="publish-logo-error"
                              class="field-error"
                              role="alert"
                            >
                              {logoErr()}
                            </p>
                          </Show>
                        </div>

                        <details
                          class="adv"
                          open={advOpen()}
                          onToggle={(e) => setAdvOpen(e.currentTarget.open)}
                        >
                          <summary>{t("advanced", locale())}</summary>
                          <div class="field">
                            <label for="publish-slug">
                              {t("publicId", locale())}
                            </label>
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
                              {editId()
                                ? t("publicIdLockedHint", locale())
                                : t("publicIdHint", locale())}
                            </span>
                          </div>

                          <div class="field">
                            <div class="field-label-row">
                              <label for="publish-tags">
                                {t("tagsField", locale())}
                              </label>
                              <Show when={tags().length > 0}>
                                <span class="field-hint mono">
                                  {tags().length}/{MAX_TAGS}
                                </span>
                              </Show>
                            </div>
                            <div
                              class="tag-input"
                              onClick={(e) => {
                                if (
                                  !(e.target as HTMLElement).closest("button")
                                ) {
                                  tagInputRef?.focus();
                                }
                              }}
                            >
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
                                ref={tagInputRef}
                                id="publish-tags"
                                name="tags"
                                class="tag-entry"
                                value={tagDraft()}
                                aria-describedby={
                                  tagFeedbackText()
                                    ? "publish-tags-feedback publish-tags-hint"
                                    : "publish-tags-hint"
                                }
                                onInput={(e) => {
                                  setTagDraft(e.currentTarget.value);
                                  if (tagFeedback()) setTagFeedback("");
                                }}
                                onKeyDown={(e) => {
                                  if (e.isComposing || e.keyCode === 229)
                                    return;
                                  if (
                                    e.key === "Enter" ||
                                    e.key === "," ||
                                    e.key === "、" ||
                                    e.key === "，"
                                  ) {
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
                                  tags().length
                                    ? ""
                                    : t("tagsPlaceholder", locale())
                                }
                                autocomplete="off"
                              />
                            </div>
                            <Show when={tagFeedbackText()}>
                              {(msg) => (
                                <p
                                  id="publish-tags-feedback"
                                  class="tag-feedback"
                                  role="status"
                                  aria-live="polite"
                                >
                                  {msg()}
                                </p>
                              )}
                            </Show>
                            <span id="publish-tags-hint" class="field-hint">
                              {tags().length >= MAX_TAGS
                                ? t("tagsLimitReached", locale())
                                : t("tagsHint", locale())}
                            </span>
                          </div>

                          <div class="field">
                            <label for="publish-description">
                              {t("descriptionField", locale())}
                            </label>
                            <textarea
                              id="publish-description"
                              name="description"
                              value={primaryText(descDraft(), locale())}
                              aria-invalid={Boolean(descErr()) || undefined}
                              aria-describedby={
                                descErr() ? "publish-desc-error" : undefined
                              }
                              onInput={(e) =>
                                setDescDraft((prev) =>
                                  setPrimaryText(
                                    prev,
                                    locale(),
                                    e.currentTarget.value,
                                  ),
                                )
                              }
                              onBlur={() =>
                                touchPrimaryLocale(descDraft(), setDescTouched)
                              }
                              rows={3}
                            />
                            <Show when={descErr()}>
                              <p
                                id="publish-desc-error"
                                class="field-error"
                                role="alert"
                              >
                                {descErr()}
                              </p>
                            </Show>
                          </div>

                          <fieldset class="bilingual-group">
                            <legend>{t("bilingualHeading", locale())}</legend>
                            <p class="field-hint bilingual-hint">
                              {t("bilingualHint", locale())}
                            </p>

                            <div class="field">
                              <label for="publish-alt-name">
                                {t("altNameField", locale())}
                              </label>
                              <input
                                id="publish-alt-name"
                                name="altName"
                                value={secondaryText(nameDraft(), locale())}
                                aria-invalid={
                                  Boolean(altNameErr()) || undefined
                                }
                                aria-describedby={
                                  altNameErr()
                                    ? "publish-alt-name-error"
                                    : undefined
                                }
                                onInput={(e) =>
                                  setNameDraft((prev) =>
                                    setSecondaryText(
                                      prev,
                                      locale(),
                                      e.currentTarget.value,
                                    ),
                                  )
                                }
                                onBlur={() =>
                                  touchSecondaryLocale(setNameTouched)
                                }
                                placeholder={
                                  primaryText(nameDraft(), locale()).trim() ||
                                  repoName() ||
                                  t("displayNamePlaceholder", locale())
                                }
                                autocomplete="off"
                              />
                              <Show when={altNameErr()}>
                                <p
                                  id="publish-alt-name-error"
                                  class="field-error"
                                  role="alert"
                                >
                                  {altNameErr()}
                                </p>
                              </Show>
                            </div>

                            <div class="field">
                              <label for="publish-alt-description">
                                {t("altDescriptionField", locale())}
                              </label>
                              <textarea
                                id="publish-alt-description"
                                name="altDescription"
                                value={secondaryText(descDraft(), locale())}
                                aria-invalid={
                                  Boolean(altDescErr()) || undefined
                                }
                                aria-describedby={
                                  altDescErr()
                                    ? "publish-alt-desc-error"
                                    : undefined
                                }
                                onInput={(e) =>
                                  setDescDraft((prev) =>
                                    setSecondaryText(
                                      prev,
                                      locale(),
                                      e.currentTarget.value,
                                    ),
                                  )
                                }
                                onBlur={() =>
                                  touchSecondaryLocale(setDescTouched)
                                }
                                placeholder={
                                  primaryText(descDraft(), locale()).trim() ||
                                  t("previewFallbackDesc", locale())
                                }
                                rows={3}
                              />
                              <Show when={altDescErr()}>
                                <p
                                  id="publish-alt-desc-error"
                                  class="field-error"
                                  role="alert"
                                >
                                  {altDescErr()}
                                </p>
                              </Show>
                            </div>
                          </fieldset>
                        </details>

                        <Show when={displayedErrors().length > 0}>
                          <ul class="form-errors" role="alert">
                            <For each={displayedErrors()}>
                              {(err) => <li>{err}</li>}
                            </For>
                          </ul>
                        </Show>

                        <button
                          type="submit"
                          class="btn btn-primary"
                          disabled={busy()}
                        >
                          {busy()
                            ? t("loading", locale())
                            : editId()
                              ? t("updateAction", locale())
                              : t("publishAction", locale())}
                        </button>
                      </form>
                    </Show>
                  </Show>
                </Show>
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </main>
  );
};
