import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.ts";
import type { StoreDb } from "../src/backend/db/client.ts";
import { queryListingsV2 } from "../src/backend/db/listings-store.ts";
import { insertTestListings, TEST_LISTINGS } from "./fixtures/listings.ts";

let db: StoreDb;

beforeEach(async () => {
  db = await createTestDb();
  await insertTestListings(db);
});

describe("TCS 2.0 indexed listing query", () => {
  test("keyset pagination covers unique Git URLs", async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const result = await queryListingsV2(db, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(result.cursorError).toBe(false);
      ids.push(...result.page.items.map((item) => item.id));
      if (!result.page.nextCursor) break;
      cursor = result.page.nextCursor;
    }
    expect(ids).toHaveLength(TEST_LISTINGS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("updated list plan uses the visibility/sort index", async () => {
    const plan = await db.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT id FROM listings
      WHERE status = 'visible'
      ORDER BY updated_at DESC, id DESC
      LIMIT 51
    `);
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "listings_v2_visible_updated_idx",
    );
  });

  test("scope list plan uses the visibility/scope/sort index", async () => {
    const plan = await db.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT id FROM listings
      WHERE status = 'visible' AND scope = 'takos'
      ORDER BY updated_at DESC, id DESC
      LIMIT 51
    `);
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "listings_v2_visible_scope_updated_idx",
    );
  });

  test("category created plan uses the visibility/category/sort index", async () => {
    const plan = await db.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT id FROM listings
      WHERE status = 'visible' AND category = 'social'
      ORDER BY created_at DESC, id DESC
      LIMIT 51
    `);
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "listings_v2_visible_category_created_idx",
    );
  });
});
