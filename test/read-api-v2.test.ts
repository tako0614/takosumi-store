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

describe("TCS 2.0 read API", () => {
  test("server-info advertises the canonical v2 contract", async () => {
    const res = await get("/tcs/v2/server-info");
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.spec.version).toBe("2.0");
    expect(info.spec.compatibleVersions).toContain("1.0");
    expect(info.spec.capabilities).not.toContain("search");
    expect(info.spec.capabilities).toContain("filter.scope");
    expect(info.server.baseUrl).toBe("https://store.test");
    expect(info).not.toHaveProperty("kinds");
    expect(info).not.toHaveProperty("providers");
  });

  test("well-known v1 info advertises both versions additively", async () => {
    const res = await get("/.well-known/tcs");
    const info = await res.json();
    expect(info.spec.version).toBe("1.0");
    expect(info.spec.versions).toEqual(["1.0", "2.0"]);
  });

  test("list returns presentation metadata and a URL-only source", async () => {
    const res = await get("/tcs/v2/listings?limit=2");
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      expect(Object.keys(item.source)).toEqual(["git"]);
      expect(item.source.git).toMatch(/^https:\/\//);
      expect(item).not.toHaveProperty("path");
      expect(item).not.toHaveProperty("provider");
      expect(item).not.toHaveProperty("kind");
      expect(item).not.toHaveProperty("surface");
    }
  });

  test("search is explicitly unsupported and scope detail uses the v2 source shape", async () => {
    const search = await get("/tcs/v2/listings/search?q=office");
    expect(search.status).toBe(501);
    expect((await search.json()).error.code).toBe("not_implemented");

    const detail = await get("/tcs/v2/listings/takos/yurucommu");
    expect(detail.status).toBe(200);
    const listing = await detail.json();
    expect(listing.source).toEqual({
      git: "https://github.com/tako0614/yurucommu",
    });
    expect(listing).not.toHaveProperty("path");
  });

  test("v2 rejects execution-looking legacy facets", async () => {
    const res = await get("/tcs/v2/listings?provider=cloudflare");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_argument");
  });

  test("v2 rejects unbounded search and tag predicates", async () => {
    for (const query of ["q=office", "tag=tools"]) {
      const res = await get(`/tcs/v2/listings?${query}`);
      expect(res.status).toBe(501);
      expect((await res.json()).error.code).toBe("not_implemented");
    }
  });

  test("v2 rejects the unindexed category plus scope combination", async () => {
    const res = await get("/tcs/v2/listings?category=tools&scope=takos");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_argument");
  });

  test("v1 remains an explicit path-bearing compatibility adapter", async () => {
    const res = await get("/tcs/v1/listings/takos/yurucommu");
    expect(res.status).toBe(200);
    const listing = await res.json();
    expect(listing.source.path).toBe("deploy/takoform");
  });
});
