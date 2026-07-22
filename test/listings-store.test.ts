import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "./helpers/test-db.ts";
import type { StoreDb } from "../src/backend/db/client.ts";
import {
  facetCounts,
  getListingById,
  queryListings,
} from "../src/backend/db/listings-store.ts";
import { TEST_LISTINGS, insertTestListings } from "./fixtures/listings.ts";

let db: StoreDb;

beforeEach(async () => {
  db = await createTestDb();
  await insertTestListings(db);
});

describe("listings store", () => {
  test("fixtures populate the account-driven store", async () => {
    const { page } = await queryListings(db, { limit: 100 });
    expect(page.items.length).toBe(TEST_LISTINGS.length);
  });

  test("default sort is updated desc (newest first)", async () => {
    const { page } = await queryListings(db, {});
    expect(page.items[0]?.id).toBe("takos/takos");
  });

  test("fixture insertion is idempotent (unique git,path)", async () => {
    await insertTestListings(db);
    const { page } = await queryListings(db, { limit: 100 });
    expect(page.items.length).toBe(TEST_LISTINGS.length);
  });

  test("keyset paging covers every row exactly once and terminates", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const {
        page,
      }: { page: { items: readonly { id: string }[]; nextCursor?: string } } =
        await queryListings(db, { limit: 3, cursor });
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.length).toBe(TEST_LISTINGS.length);
    expect(new Set(seen).size).toBe(TEST_LISTINGS.length);
  });

  test("malformed cursor flags cursorError", async () => {
    const { cursorError } = await queryListings(db, { cursor: "@@bad@@" });
    expect(cursorError).toBe(true);
  });

  test("filters by kind / provider / category", async () => {
    const workers = await queryListings(db, { kind: "worker", limit: 100 });
    expect(workers.page.items.length).toBe(TEST_LISTINGS.length);

    const cf = await queryListings(db, { provider: "cloudflare", limit: 100 });
    expect(cf.page.items.length).toBe(TEST_LISTINGS.length);

    const social = await queryListings(db, { category: "social", limit: 100 });
    expect(social.page.items.map((i) => i.id)).toEqual(["takos/yurucommu"]);

    const productivity = await queryListings(db, {
      category: "productivity",
      limit: 100,
    });
    expect(productivity.page.items.map((i) => i.id)).toEqual([
      "takos/takos-office",
    ]);
  });

  test("search matches name/description case-insensitively", async () => {
    const office = await queryListings(db, { q: "office", limit: 100 });
    expect(office.page.items.map((i) => i.id)).toEqual(["takos/takos-office"]);

    const social = await queryListings(db, { q: "ActivityPub", limit: 100 });
    expect(social.page.items.map((i) => i.id)).toEqual(["takos/yurucommu"]);
  });

  test("sort=name orders ascending by localized name", async () => {
    const { page } = await queryListings(db, {
      sort: "name",
      locale: "en",
      limit: 100,
    });
    const names = page.items.map((i) => i.name.en.toLowerCase());
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test("getListingById round-trips a full listing; unknown → null", async () => {
    const got = await getListingById(db, "takos/yurucommu");
    expect(got?.source.git).toBe("https://github.com/tako0614/yurucommu.git");
    expect(got?.publisher?.handle).toBe("takos");
    expect(await getListingById(db, "nope")).toBeNull();
  });

  test("does not expose install setup from store listings", async () => {
    const got = await getListingById(db, "takos/yurucommu");
    expect("inputs" in (got ?? {})).toBe(false);
    expect("installExperience" in (got ?? {})).toBe(false);
    expect("outputAllowlist" in (got ?? {})).toBe(false);
  });

  test("facetCounts reports totals and groupings", async () => {
    const f = await facetCounts(db);
    expect(f.total).toBe(TEST_LISTINGS.length);
    const kindMap = Object.fromEntries(f.kinds.map((k) => [k.key, k.count]));
    expect(kindMap.worker).toBe(TEST_LISTINGS.length);
  });
});
