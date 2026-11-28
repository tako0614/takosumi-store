import { describe, expect, test } from "bun:test";
import { bodyFromListing } from "../web/src/lib/publish-client.ts";
import {
  MAX_TAGS,
  normalizeTagInput,
  parseTagInput,
  validateGitUrl,
  validateHandle,
} from "../web/src/lib/publish-validation.ts";
import {
  appendScopePage,
  applyInitialScopeError,
  applyInitialScopePage,
  applyScopeLoadMoreError,
  initialScopeState,
  startScopeLoadMore,
} from "../web/src/lib/scope-pagination.ts";
import { renderMarkdown } from "../web/src/lib/markdown.ts";
import { t, type StringKey } from "../web/src/lib/i18n.ts";
import type { ListingV2 } from "../spec/v2/listing.ts";

function sampleListing(
  slug: string,
  overrides: Partial<ListingV2> = {},
): ListingV2 {
  return {
    id: `takos/${slug}`,
    scope: "takos",
    slug,
    source: { git: `https://github.com/tako0614/${slug}.git` },
    category: "tools",
    tags: ["tools"],
    suggestedName: slug,
    name: { ja: slug, en: slug },
    description: { ja: slug, en: slug },
    badge: { ja: "tools", en: "tools" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    ...overrides,
  };
}

describe("bodyFromListing reviewed module path preservation", () => {
  test("preserves source.path when present and omits it when absent", () => {
    const withPath = sampleListing("mono", {
      source: {
        git: "https://github.com/tako0614/monorepo.git",
        path: "capsules/web",
      },
    });
    expect(bodyFromListing(withPath).source).toEqual({
      git: "https://github.com/tako0614/monorepo.git",
      path: "capsules/web",
    });

    const rootOnly = sampleListing("root-app");
    expect(bodyFromListing(rootOnly).source).toEqual({
      git: "https://github.com/tako0614/root-app.git",
    });
    expect("path" in bodyFromListing(rootOnly).source).toBe(false);
  });
});

describe("PublishPage tag normalization & inline feedback", () => {
  test("surfaces non-ASCII drops, duplicates, and cap limits while supporting Japanese commas", () => {
    expect(parseTagInput("日本語", [])).toEqual({
      next: [],
      added: [],
      feedback: "non_ascii",
    });

    expect(parseTagInput("Social、ActivityPub，日本語", [])).toEqual({
      next: ["social", "activitypub"],
      added: ["social", "activitypub"],
      feedback: "non_ascii",
    });

    expect(parseTagInput("social", ["social"])).toEqual({
      next: ["social"],
      added: [],
      feedback: "duplicate",
    });

    expect(parseTagInput("social, ai", ["social"])).toEqual({
      next: ["social", "ai"],
      added: ["ai"],
      feedback: "",
    });

    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i + 1}`);
    expect(parseTagInput("extra", full)).toEqual({
      next: full,
      added: [],
      feedback: "limit_reached",
    });

    // 24-char truncation must not leave a trailing hyphen.
    expect(normalizeTagInput(`${"a".repeat(23)} b`)).toBe("a".repeat(23));
    expect(normalizeTagInput(`${"a".repeat(23)} b`).endsWith("-")).toBe(false);
  });

  test("client validation aligns with backend HTTPS Git URL and handle contracts", () => {
    expect(validateGitUrl("https://github.com/tako0614/app.git")).toBeNull();
    expect(validateGitUrl("http://github.com/tako0614/app.git")).toBe(
      "invalid",
    );
    expect(validateGitUrl("https://store.local/org/app")).toBe("invalid");
    expect(validateHandle("tako_dev")).toBeNull();
    expect(validateHandle("x")).toBe("invalid");
  });
});

describe("ScopePage cursor pagination state transitions", () => {
  test("appends paginated pages with dedup and preserves items + cursor across transient load-more errors", () => {
    let state = initialScopeState();
    expect(state.loading).toBe(true);

    const a1 = sampleListing("a1");
    const a2 = sampleListing("a2");
    const a3 = sampleListing("a3");

    state = applyInitialScopePage({ items: [a1, a2], nextCursor: "cursor-2" });
    expect(state.loading).toBe(false);
    expect(state.items.map((i) => i.slug)).toEqual(["a1", "a2"]);
    expect(state.nextCursor).toBe("cursor-2");

    // Transient page-2 failure retains loaded items and nextCursor for Retry.
    state = startScopeLoadMore(state);
    expect(state.loadingMore).toBe(true);
    state = applyScopeLoadMoreError(state);
    expect(state.loadingMore).toBe(false);
    expect(state.loadMoreError).toBe(true);
    expect(state.nextCursor).toBe("cursor-2");
    expect(state.items.map((i) => i.slug)).toEqual(["a1", "a2"]);

    // Retry appends page 2, deduplicating overlapping entries and clearing cursor.
    state = startScopeLoadMore(state);
    state = appendScopePage(state, { items: [a2, a3] });
    expect(state.loadMoreError).toBe(false);
    expect(state.nextCursor).toBeNull();
    expect(state.items.map((i) => i.slug)).toEqual(["a1", "a2", "a3"]);

    // Initial load failure sets error cleanly.
    const errored = applyInitialScopeError();
    expect(errored.error).toBe(true);
    expect(errored.items).toEqual([]);
  });
});

describe("markdown in-page anchor links", () => {
  test("keeps fragment anchor links in-page without target=_blank while keeping external links opening safely", () => {
    const html = renderMarkdown(
      "[Jump](#install) and [Docs](https://example.com/docs)",
    );
    expect(html).toContain('<a href="#install">Jump</a>');
    expect(html).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer nofollow">Docs</a>',
    );
  });
});

describe("wave 6 copy", () => {
  test("all new user-facing strings exist in both ja and en", () => {
    const keys: StringKey[] = [
      "tagsNonAsciiHint",
      "tagsDuplicateHint",
      "handleHint",
      "publicIdLockedHint",
      "networkError",
    ];
    for (const key of keys) {
      expect(t(key, "ja").trim()).not.toBe("");
      expect(t(key, "en").trim()).not.toBe("");
    }
    // Updated Git URL error no longer advertises unsupported http://.
    expect(t("gitUrlInvalid", "en")).not.toContain("http://");
    expect(t("gitUrlInvalid", "ja")).not.toContain("http://");
  });
});
