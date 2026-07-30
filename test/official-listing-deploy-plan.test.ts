import { describe, expect, test } from "bun:test";
import {
  casMutationSql,
  gitRepositoryAncestor,
  officialNamespaceRowIds,
  publicListingExpectation,
  rollbackSql,
  workerVersionD1BindingId,
} from "../scripts/deploy-official-listings.ts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Listing } from "../spec/listing.ts";

const listing: Listing = {
  id: "tako/yurucommu",
  scope: "tako",
  slug: "yurucommu",
  source: {
    git: "https://github.com/tako0614/yurucommu",
    path: "deploy/takoform",
  },
  kind: "worker",
  surface: "service",
  provider: "takoform",
  category: "social",
  tags: ["social"],
  suggestedName: "yurucommu",
  name: { ja: "yurucommu", en: "yurucommu" },
  description: { ja: "新しい説明", en: "New description" },
  badge: { ja: "追加候補", en: "Installable" },
  publisher: { handle: "tako", displayName: "Takos" },
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

const before = {
  id: "tako/yurucommu",
  scope: "tako",
  slug: "yurucommu",
  git: "https://github.com/tako0614/yurucommu",
  path: ".",
  kind: "worker",
  surface: "service",
  provider: "cloudflare",
  category: "social",
  tags: '["social"]',
  suggested_name: "yurucommu",
  name_ja: "yurucommu",
  name_en: "yurucommu",
  description_ja: "古い説明",
  description_en: "Old description",
  badge_ja: "追加候補",
  badge_en: "Installable",
  icon_url: "https://store.takosumi.com/icons/validated",
  publisher_id: "publisher_operator_owned",
  publisher_handle: "operator-owned",
  publisher_display_name: "Operator owned",
  badges: '["reviewed"]',
  status: "hidden",
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

describe("official listing deploy plan", () => {
  test("updates only manifest-owned fields and CAS-guards their prior values", () => {
    const sql = casMutationSql({ desired: [listing], before: [before] });

    expect(sql).toContain("UPDATE listings SET");
    expect(sql).toContain("path='deploy/takoform'");
    expect(sql).toContain("provider='takoform'");
    expect(sql).toContain("path IS '.'");
    expect(sql).toContain("provider IS 'cloudflare'");
    expect(sql).not.toContain("status=");
    expect(sql).not.toContain("badges=");
    expect(sql).not.toContain("icon_url=");
    expect(sql).not.toContain("publisher_handle=");
  });

  test("rollback restores only manifest-owned fields under an after-state CAS", () => {
    const sql = rollbackSql({ desired: [listing], before: [before] });

    expect(sql).toContain("path='.'");
    expect(sql).toContain("provider='cloudflare'");
    expect(sql).toContain("path IS 'deploy/takoform'");
    expect(sql).toContain("provider IS 'takoform'");
    expect(sql).not.toContain("status=");
    expect(sql).not.toContain("badges=");
    expect(sql).not.toContain("icon_url=");
    expect(sql).not.toContain("publisher_handle=");
  });

  test("new rows are create-only and their rollback is exact", () => {
    const mutation = casMutationSql({ desired: [listing], before: [] });
    const rollback = rollbackSql({ desired: [listing], before: [] });

    expect(mutation).toContain(
      "WHERE NOT EXISTS (SELECT 1 FROM listings WHERE id IS 'tako/yurucommu')",
    );
    expect(rollback).toContain(
      "DELETE FROM listings WHERE id IS 'tako/yurucommu' AND",
    );
    expect(rollback).toContain("provider IS 'takoform'");
  });

  test("retired rows are deleted only when their complete snapshot still matches", () => {
    const retired = { ...before, id: "tako/office" };
    const sql = casMutationSql({ desired: [listing], before: [retired] });

    expect(sql).toContain("DELETE FROM listings WHERE id IS 'tako/office'");
    expect(sql).toContain("status IS 'hidden'");
    expect(sql).toContain("badges IS '[\"reviewed\"]'");
  });

  test("accepts Wrangler raw and projected D1 identities only when exact", () => {
    expect(
      workerVersionD1BindingId({
        type: "d1",
        name: "DB",
        id: "database-production",
      }),
    ).toBe("database-production");
    expect(
      workerVersionD1BindingId({
        type: "d1",
        name: "DB",
        id: "database-production",
        database_id: "database-production",
      }),
    ).toBe("database-production");
    expect(
      workerVersionD1BindingId({
        type: "d1",
        name: "DB",
        id: "database-a",
        database_id: "database-b",
      }),
    ).toBeUndefined();
  });

  test("public readback expectation uses preserved moderation-owned presentation", () => {
    const expected = publicListingExpectation(listing, before);
    expect(expected.publisher).toEqual({
      handle: "operator-owned",
      displayName: "Operator owned",
    });
    expect(expected.badges).toEqual(["reviewed"]);
    expect(expected.iconUrl).toBe("https://store.takosumi.com/icons/validated");
    expect(expected.createdAt).toBe("2026-06-01T00:00:00.000Z");

    const withoutPresentation = publicListingExpectation(listing, {
      ...before,
      publisher_handle: null,
      publisher_display_name: null,
      badges: null,
      icon_url: null,
    });
    expect(withoutPresentation.publisher).toBeUndefined();
    expect(withoutPresentation.badges).toBeUndefined();
    expect(withoutPresentation.iconUrl).toBeUndefined();
  });

  test("validates the complete official namespace closure", () => {
    expect(
      officialNamespaceRowIds([{ id: "tako/yurucommu" }, { id: "tako/takos" }]),
    ).toEqual(["tako/takos", "tako/yurucommu"]);
    expect(() => officialNamespaceRowIds([{ id: "other/yurucommu" }])).toThrow(
      "invalid id",
    );
    expect(() =>
      officialNamespaceRowIds([
        { id: "tako/yurucommu" },
        { id: "tako/yurucommu" },
      ]),
    ).toThrow("duplicate ids");
  });

  test("rejects release state below a Git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "takosumi-store-state-test-"));
    mkdirSync(join(root, ".git"));
    expect(gitRepositoryAncestor(join(root, "state", "nested"))).toBe(root);

    const outside = mkdtempSync(join(tmpdir(), "takosumi-store-state-test-"));
    expect(gitRepositoryAncestor(join(outside, "state"))).toBeUndefined();
  });
});
