import { describe, expect, test } from "bun:test";
import {
  filterCatalog,
  normalizeCatalogSort,
} from "../web/src/lib/catalog-filter.ts";
import { tagLabel } from "../web/src/lib/i18n.ts";
import type { AggregatedListing } from "../web/src/lib/aggregate.ts";

function listing(
  overrides: Partial<AggregatedListing> & {
    id: string;
    slug: string;
    name: { ja: string; en: string };
    description: { ja: string; en: string };
  },
): AggregatedListing {
  return {
    scope: "tako",
    source: { git: `https://github.com/example/${overrides.slug}.git` },
    suggestedName: overrides.slug,
    badge: { ja: "", en: "" },
    tags: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    seenOn: ["https://store.example"],
    primaryServer: "https://store.example",
    primaryHome: true,
    ...overrides,
  };
}

const ITEMS: readonly AggregatedListing[] = [
  listing({
    id: "tako/takos",
    slug: "takos",
    name: { ja: "Takos", en: "Takos" },
    description: {
      ja: "AI ワークスペースをホストします。",
      en: "Host the Takos AI workspace.",
    },
    tags: ["workspace", "ai"],
    updatedAt: "2026-11-26T00:00:00.000Z",
  }),
  listing({
    id: "tako/yurucommu",
    slug: "yurucommu",
    name: { ja: "yurucommu", en: "yurucommu" },
    description: {
      ja: "ActivityPub コミュニティ SNS。",
      en: "Community SNS over ActivityPub.",
    },
    tags: ["social", "activitypub"],
    updatedAt: "2026-11-25T00:00:00.000Z",
  }),
  listing({
    id: "tako/alpha-git",
    slug: "alpha-git",
    name: { ja: "Alpha Git", en: "Alpha Git" },
    description: {
      ja: "Git リポジトリサービス。",
      en: "Git repository service.",
    },
    tags: ["developer", "git"],
    updatedAt: "2026-11-20T00:00:00.000Z",
  }),
];

describe("catalog-filter", () => {
  test("filters by query across localized name, description, slug, and tags", () => {
    expect(
      filterCatalog(ITEMS, {
        query: "activitypub",
        tag: "",
        sort: "updated",
        locale: "ja",
      }).map((i) => i.slug),
    ).toEqual(["yurucommu"]);

    expect(
      filterCatalog(ITEMS, {
        query: "ワークスペース",
        tag: "",
        sort: "updated",
        locale: "ja",
      }).map((i) => i.slug),
    ).toEqual(["takos"]);

    expect(
      filterCatalog(ITEMS, {
        query: "開発者向け",
        tag: "",
        sort: "updated",
        locale: "ja",
      }).map((i) => i.slug),
    ).toEqual(["alpha-git"]);
  });

  test("combines tag and query filters and respects sort order", () => {
    expect(
      filterCatalog(ITEMS, {
        query: "",
        tag: "ai",
        sort: "updated",
        locale: "en",
      }).map((i) => i.slug),
    ).toEqual(["takos"]);

    expect(
      filterCatalog(ITEMS, {
        query: "git",
        tag: "social",
        sort: "updated",
        locale: "en",
      }),
    ).toEqual([]);

    expect(
      filterCatalog(ITEMS, {
        query: "",
        tag: "",
        sort: "name",
        locale: "en",
      }).map((i) => i.slug),
    ).toEqual(["alpha-git", "takos", "yurucommu"]);
  });

  test("normalizes unsupported sort parameters to updated", () => {
    expect(normalizeCatalogSort("name")).toBe("name");
    expect(normalizeCatalogSort("updated")).toBe("updated");
    expect(normalizeCatalogSort("unknown")).toBe("updated");
    expect(normalizeCatalogSort(undefined)).toBe("updated");
  });
});

describe("tagLabel", () => {
  test("preserves proper capitalization for common acronyms and protocols", () => {
    expect(tagLabel("ai", "ja")).toBe("AI");
    expect(tagLabel("activitypub", "en")).toBe("ActivityPub");
    expect(tagLabel("git", "en")).toBe("Git");
    expect(tagLabel("object-storage", "en")).toBe("Object Storage");
    expect(tagLabel("http-api", "en")).toBe("HTTP API");
  });
});
