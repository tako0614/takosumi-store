import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "./helpers/test-db.ts";
import type { StoreDb } from "../src/backend/db/client.ts";
import { createReadRoutes } from "../src/backend/routes/spec-read.ts";
import { insertTestListings } from "./fixtures/listings.ts";
import type { Env } from "../src/backend/types.ts";

let db: StoreDb;
let app: ReturnType<typeof createReadRoutes>;

const ENV = { APP_URL: "https://store.test" } as unknown as Env;

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`https://store.test${path}`), ENV);
}

beforeEach(async () => {
  db = await createTestDb();
  await insertTestListings(db);
  app = createReadRoutes(() => db);
});

describe("read api", () => {
  test("GET /.well-known/tcs returns valid ServerInfo", async () => {
    const res = await get("/.well-known/tcs");
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.spec.version).toBe("1.0");
    expect(info.spec.capabilities).toContain("search");
    expect(info.server.baseUrl).toBe("https://store.test");
    expect(info.listings.count).toBeGreaterThan(0);
  });

  test("GET /tcs/v1/server-info aliases ServerInfo", async () => {
    const res = await get("/tcs/v1/server-info");
    expect(res.status).toBe(200);
    expect((await res.json()).spec.version).toBe("1.0");
  });

  test("GET /tcs/v1/listings paginates without overlap and terminates", async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const res = await get(
        `/tcs/v1/listings?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(res.status).toBe(200);
      const page = await res.json();
      ids.push(...page.items.map((i: { id: string }) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });

  test("filters compose", async () => {
    const res = await get(
      "/tcs/v1/listings?provider=cloudflare&category=social&limit=100",
    );
    const page = await res.json();
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([
      "takos/yurucommu",
    ]);
  });

  test("search returns matches", async () => {
    const res = await get("/tcs/v1/listings/search?q=office");
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([
      "takos/takos-office",
    ]);
  });

  test("search without q → 400 envelope", async () => {
    const res = await get("/tcs/v1/listings/search");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_argument");
    expect(typeof body.error.requestId).toBe("string");
  });

  test("GET /tcs/v1/listings/:id returns a full Listing", async () => {
    const res = await get("/tcs/v1/listings/takos/yurucommu");
    expect(res.status).toBe(200);
    const listing = await res.json();
    expect(listing.source.git).toBe(
      "https://github.com/tako0614/yurucommu.git",
    );
    expect(listing.name.ja).toBe("Yurucommu");
  });

  test("unknown id → 404 envelope", async () => {
    const res = await get("/tcs/v1/listings/does-not-exist");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  test("bad cursor → 400 envelope", async () => {
    const res = await get("/tcs/v1/listings?cursor=@@bad@@");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_argument");
  });

  test("bad limit → 400 envelope", async () => {
    const res = await get("/tcs/v1/listings?limit=0");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_argument");
  });

  test("unknown kind → 400 envelope", async () => {
    const res = await get("/tcs/v1/listings?kind=banana");
    expect(res.status).toBe(400);
  });
});
