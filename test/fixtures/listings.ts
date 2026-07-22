import type { Listing, LocalizedText } from "../../spec/listing.ts";
import type { StoreDb } from "../../src/backend/db/client.ts";
import { insertListingsIgnoreConflict } from "../../src/backend/db/listings-store.ts";

/**
 * Test fixtures for the listings store / read API. The production catalog is
 * account-driven (no official seed), so tests insert their own representative
 * listings. Identities use the `scope/slug` model (id === `${scope}/${slug}`).
 */
const t = (ja: string, en: string): LocalizedText => ({ ja, en });
const BASE = Date.parse("2026-06-24T00:00:00.000Z");
const ts = (offsetMinutes: number): string =>
  new Date(BASE + offsetMinutes * 60_000).toISOString();
const publisher = { handle: "takos", displayName: "Takos" } as const;

function app(
  slug: string,
  offset: number,
  fields: Omit<
    Listing,
    | "id"
    | "scope"
    | "slug"
    | "kind"
    | "surface"
    | "provider"
    | "suggestedName"
    | "publisher"
    | "createdAt"
    | "updatedAt"
  >,
): Listing {
  return {
    id: `takos/${slug}`,
    scope: "takos",
    slug,
    kind: "worker",
    surface: "service",
    provider: "cloudflare",
    suggestedName: slug,
    publisher,
    createdAt: ts(offset),
    updatedAt: ts(offset),
    ...fields,
  };
}

export const TEST_LISTINGS: readonly Listing[] = [
  app("takos", 60, {
    source: {
      git: "https://github.com/tako0614/takos.git",
      path: "deploy/opentofu",
    },
    category: "workspace",
    tags: ["workspace", "ai"],
    name: t("Takos", "Takos"),
    description: t("自分専用の AI ワークスペース。", "Your own AI workspace."),
    badge: t("ワークスペース", "Workspace"),
  }),
  app("yurucommu", 50, {
    source: {
      git: "https://github.com/tako0614/yurucommu.git",
      path: "",
    },
    category: "social",
    tags: ["social", "activitypub"],
    name: t("Yurucommu", "Yurucommu"),
    description: t(
      "ActivityPub でつながるコミュニティSNS。",
      "A community SNS connected over ActivityPub.",
    ),
    badge: t("SNS", "Social"),
  }),
  app("takos-office", 40, {
    source: {
      git: "https://github.com/tako0614/takos-office.git",
      path: "",
    },
    category: "productivity",
    tags: ["productivity", "office"],
    name: t("Office", "Office"),
    description: t(
      "ドキュメント・スライド・シートのオフィススイート。",
      "A docs, slides, and sheets office suite.",
    ),
    badge: t("オフィス", "Office"),
  }),
  app("takos-computer", 30, {
    source: {
      git: "https://github.com/tako0614/takos-computer.git",
      path: "",
    },
    category: "tools",
    tags: ["tools"],
    name: t("Computer", "Computer"),
    description: t("ブラウザで動く作業環境。", "A browser-based workspace."),
    badge: t("ツール", "Tools"),
  }),
];

/** Insert the test fixtures, skipping rows that already exist. */
export async function insertTestListings(db: StoreDb): Promise<void> {
  await insertListingsIgnoreConflict(db, TEST_LISTINGS);
}
