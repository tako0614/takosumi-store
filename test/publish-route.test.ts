import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "./helpers/test-db.ts";
import { jreq } from "./helpers/http.ts";
import { login } from "./helpers/login.ts";
import type { StoreDb } from "../src/backend/db/client.ts";
import { createPublishRoutes } from "../src/backend/routes/publish.ts";
import { createReadRoutes } from "../src/backend/routes/spec-read.ts";

function body(over: Record<string, unknown> = {}) {
  return {
    source: { git: "https://github.com/o/r.git", path: "mod" },
    kind: "worker",
    surface: "service",
    provider: "cloudflare",
    category: "social",
    suggestedName: "my-app",
    name: { ja: "アプリ", en: "App" },
    description: { ja: "", en: "An app" },
    badge: { ja: "", en: "App" },
    ...over,
  };
}

let db: StoreDb;
let pub: ReturnType<typeof createPublishRoutes>;
let read: ReturnType<typeof createReadRoutes>;

beforeEach(async () => {
  db = await createTestDb();
  pub = createPublishRoutes(() => db);
  read = createReadRoutes(() => db);
});

describe("publish routes", () => {
  test("401 without a session", async () => {
    expect(
      (await jreq(pub, "/publish/listings", { body: body() })).status,
    ).toBe(401);
  });

  test("400 when the publisher has no handle yet", async () => {
    const { cookie } = await login(db); // no handle
    const res = await jreq(pub, "/publish/listings", { cookie, body: body() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("failed_precondition");
  });

  test("publish → 201, appears in read API, attributed to publisher", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const res = await jreq(pub, "/publish/listings", { cookie, body: body() });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.listing.publisher.handle).toBe("alice");
    expect(created.listing.source).toEqual({
      git: "https://github.com/o/r.git",
      path: "mod",
    });

    const got = await jreq(read, `/tcs/v1/listings/${created.listing.id}`);
    expect(got.status).toBe(200);
    expect((await got.json()).suggestedName).toBe("my-app");
  });

  test("relative repository icon is passed to the managed re-hoster", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const requests: unknown[] = [];
    pub = createPublishRoutes(
      () => db,
      async (request) => {
        requests.push(request);
        return "https://store.test/icons/" + "a".repeat(64);
      },
    );
    const res = await jreq(pub, "/publish/listings", {
      cookie,
      body: body({ iconUrl: "assets/icon.png" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).listing.iconUrl).toBe(
      "https://store.test/icons/" + "a".repeat(64),
    );
    expect(requests).toEqual([
      {
        bucket: undefined,
        origin: "https://store.test",
        source: { git: "https://github.com/o/r.git", path: "mod" },
        reference: "assets/icon.png",
        discoverWhenMissing: false,
      },
    ]);
  });

  test("invalid or failed icon processing never blocks publication", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    pub = createPublishRoutes(
      () => db,
      async () => undefined,
    );
    const res = await jreq(pub, "/publish/listings", {
      cookie,
      body: body({ iconUrl: "file:///etc/passwd" }),
    });
    expect(res.status).toBe(201);
    const response = await res.json();
    expect(response.listing.iconUrl).toBeUndefined();
    expect(response.warnings).toEqual([
      "iconUrl was unsafe and will be omitted",
    ]);
  });

  test("duplicate (git,path) → 409", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    expect(
      (await jreq(pub, "/publish/listings", { cookie, body: body() })).status,
    ).toBe(201);
    const dup = await jreq(pub, "/publish/listings", { cookie, body: body() });
    expect(dup.status).toBe(409);
  });

  test("only the owner can PATCH/DELETE; delete hides from reads", async () => {
    const alice = await login(db, { handle: "alice" });
    const created = await (
      await jreq(pub, "/publish/listings", {
        cookie: alice.cookie,
        body: body(),
      })
    ).json();
    const id = created.listing.id;

    const bob = await login(db, { handle: "bob" });
    const patchByBob = await jreq(pub, `/publish/listings/${id}`, {
      method: "PATCH",
      cookie: bob.cookie,
      body: body({ category: "tools" }),
    });
    expect(patchByBob.status).toBe(403);

    const patch = await jreq(pub, `/publish/listings/${id}`, {
      method: "PATCH",
      cookie: alice.cookie,
      body: body({ category: "tools" }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).listing.category).toBe("tools");

    const del = await jreq(pub, `/publish/listings/${id}`, {
      method: "DELETE",
      cookie: alice.cookie,
    });
    expect(del.status).toBe(200);
    expect((await jreq(read, `/tcs/v1/listings/${id}`)).status).toBe(404);
  });

  test("id is scope/slug and resolves via /tcs/v1/listings/:scope/:slug", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const created = await (
      await jreq(pub, "/publish/listings", { cookie, body: body() })
    ).json();
    expect(created.listing.scope).toBe("alice");
    expect(created.listing.slug).toBe("my-app");
    expect(created.listing.id).toBe("alice/my-app");
    expect((await jreq(read, "/tcs/v1/listings/alice/my-app")).status).toBe(
      200,
    );
  });

  test("tags are normalized, stored, and derive the category", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const res = await jreq(pub, "/publish/listings", {
      cookie,
      body: body({
        category: undefined,
        tags: ["Social", "Dev Tools", "social"],
      }),
    });
    expect(res.status).toBe(201);
    const { listing } = await res.json();
    expect(listing.tags).toEqual(["social", "dev-tools"]);
    expect(listing.category).toBe("social");
  });

  test("?tag= filters the read API", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    await jreq(pub, "/publish/listings", {
      cookie,
      body: body({ tags: ["social"] }),
    });
    await jreq(pub, "/publish/listings", {
      cookie,
      body: body({
        tags: ["tools"],
        source: { git: "https://github.com/o/r2.git", path: "" },
      }),
    });
    const page = await (
      await jreq(read, "/tcs/v1/listings?tag=social&limit=100")
    ).json();
    expect(page.items.length).toBe(1);
    expect(page.items[0].tags).toContain("social");
  });

  test("slug auto-dedupes within a scope", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    await jreq(pub, "/publish/listings", { cookie, body: body() });
    const second = await (
      await jreq(pub, "/publish/listings", {
        cookie,
        body: body({
          source: { git: "https://github.com/o/r2.git", path: "" },
        }),
      })
    ).json();
    expect(second.listing.slug).toBe("my-app-2");
    expect(second.listing.id).toBe("alice/my-app-2");
  });

  test("explicit slug; collision within a scope → 409", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const first = await (
      await jreq(pub, "/publish/listings", {
        cookie,
        body: body({ slug: "custom" }),
      })
    ).json();
    expect(first.listing.id).toBe("alice/custom");
    const dup = await jreq(pub, "/publish/listings", {
      cookie,
      body: body({
        slug: "custom",
        source: { git: "https://github.com/o/r2.git", path: "" },
      }),
    });
    expect(dup.status).toBe(409);
  });

  test("per-scope quota → 429 resource_exhausted", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const env = { TCS_MAX_LISTINGS_PER_SCOPE: "1" };
    expect(
      (await jreq(pub, "/publish/listings", { cookie, body: body(), env }))
        .status,
    ).toBe(201);
    const over = await jreq(pub, "/publish/listings", {
      cookie,
      body: body({
        source: { git: "https://github.com/o/r2.git", path: "" },
      }),
      env,
    });
    expect(over.status).toBe(429);
    expect((await over.json()).error.code).toBe("resource_exhausted");
  });

  test("status toggle unpublishes (hidden) and republishes (visible)", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const created = await (
      await jreq(pub, "/publish/listings", { cookie, body: body() })
    ).json();
    const id: string = created.listing.id;
    expect((await jreq(read, `/tcs/v1/listings/${id}`)).status).toBe(200);

    const hide = await jreq(pub, `/publish/listings/${id}/status`, {
      cookie,
      body: { status: "hidden" },
    });
    expect(hide.status).toBe(200);
    // Hidden listings drop out of the public read API.
    expect((await jreq(read, `/tcs/v1/listings/${id}`)).status).toBe(404);

    const show = await jreq(pub, `/publish/listings/${id}/status`, {
      cookie,
      body: { status: "visible" },
    });
    expect(show.status).toBe(200);
    expect((await jreq(read, `/tcs/v1/listings/${id}`)).status).toBe(200);
  });

  test("status rejects bad values and non-owners", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const created = await (
      await jreq(pub, "/publish/listings", { cookie, body: body() })
    ).json();
    const id: string = created.listing.id;

    expect(
      (
        await jreq(pub, `/publish/listings/${id}/status`, {
          cookie,
          body: { status: "banana" },
        })
      ).status,
    ).toBe(400);

    const other = await login(db, { handle: "mallory" });
    expect(
      (
        await jreq(pub, `/publish/listings/${id}/status`, {
          cookie: other.cookie,
          body: { status: "hidden" },
        })
      ).status,
    ).toBe(403);
  });

  test("readme route 404s for unknown listings and unsupported hosts", async () => {
    expect(
      (await jreq(read, "/tcs/v1/listings/nobody/nothing/readme")).status,
    ).toBe(404);

    const { cookie } = await login(db, { handle: "alice" });
    // A non-forge host has no known raw-content base → no README (no network).
    const created = await (
      await jreq(pub, "/publish/listings", {
        cookie,
        body: body({
          source: { git: "https://example.com/o/r.git", path: "" },
        }),
      })
    ).json();
    const res = await jreq(
      read,
      `/tcs/v1/listings/${created.listing.id}/readme`,
    );
    expect(res.status).toBe(404);
  });
});
