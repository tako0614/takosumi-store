import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "./helpers/test-db.ts";
import { jreq } from "./helpers/http.ts";
import { login } from "./helpers/login.ts";
import type { StoreDb } from "../src/backend/db/client.ts";
import { createPublishRoutes } from "../src/backend/routes/publish.ts";
import { createModerationRoutes } from "../src/backend/routes/moderation.ts";
import { createReadRoutes } from "../src/backend/routes/spec-read.ts";

const listingBody = {
  source: { git: "https://github.com/o/r.git", path: "" },
  kind: "worker",
  surface: "service",
  provider: "cloudflare",
  category: "social",
  suggestedName: "app",
  name: { ja: "アプリ", en: "App" },
  description: { ja: "", en: "An app" },
  badge: { ja: "", en: "App" },
};

let db: StoreDb;
let pub: ReturnType<typeof createPublishRoutes>;
let mod: ReturnType<typeof createModerationRoutes>;
let read: ReturnType<typeof createReadRoutes>;

async function publishOne(cookie: string): Promise<string> {
  const res = await jreq(pub, "/publish/listings", {
    cookie,
    body: listingBody,
  });
  return (await res.json()).listing.id as string;
}

const moderationEnv = {
  SESSION_HASH_SALT: "test-moderation-salt",
};

beforeEach(async () => {
  db = await createTestDb();
  pub = createPublishRoutes(() => db);
  mod = createModerationRoutes(() => db);
  read = createReadRoutes(() => db);
});

describe("moderation routes", () => {
  test("anyone can report an existing listing", async () => {
    const alice = await login(db, { handle: "alice" });
    const id = await publishOne(alice.cookie);
    const res = await jreq(mod, "/moderation/reports", {
      body: { listingId: id, reason: "spam" },
      env: moderationEnv,
    });
    expect(res.status).toBe(200);
    expect(
      (
        await jreq(mod, "/moderation/reports", {
          body: { listingId: "nope", reason: "x" },
          env: moderationEnv,
        })
      ).status,
    ).toBe(404);
  });

  test("non-moderator cannot hide; moderator can hide/show/badge", async () => {
    const alice = await login(db, { handle: "alice" });
    const id = await publishOne(alice.cookie);

    const hideByAlice = await jreq(mod, `/moderation/listings/${id}/hide`, {
      method: "POST",
      cookie: alice.cookie,
    });
    expect(hideByAlice.status).toBe(403);

    const m = await login(db, { handle: "mod", role: "moderator" });
    expect(
      (
        await jreq(mod, `/moderation/listings/${id}/hide`, {
          method: "POST",
          cookie: m.cookie,
        })
      ).status,
    ).toBe(200);
    expect((await jreq(read, `/tcs/v1/listings/${id}`)).status).toBe(404); // hidden

    expect(
      (
        await jreq(mod, `/moderation/listings/${id}/show`, {
          method: "POST",
          cookie: m.cookie,
        })
      ).status,
    ).toBe(200);
    expect((await jreq(read, `/tcs/v1/listings/${id}`)).status).toBe(200); // visible again

    await jreq(mod, `/moderation/listings/${id}/badges`, {
      method: "POST",
      cookie: m.cookie,
      body: { badges: ["verified", "bogus"] },
    });
    const listing = await (await jreq(read, `/tcs/v1/listings/${id}`)).json();
    expect(listing.badges).toEqual(["verified"]); // bogus filtered out
  });

  test("moderator can list open reports", async () => {
    const alice = await login(db, { handle: "alice" });
    const id = await publishOne(alice.cookie);
    await jreq(mod, "/moderation/reports", {
      body: { listingId: id, reason: "spam" },
      env: moderationEnv,
    });
    const m = await login(db, { handle: "mod", role: "moderator" });
    const res = await jreq(mod, "/moderation/reports", {
      method: "GET",
      cookie: m.cookie,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reports.length).toBe(1);
  });

  test("deduplicates reports and rate-limits an anonymous reporter", async () => {
    const alice = await login(db, { handle: "alice" });
    const ids: string[] = [];
    ids.push(await publishOne(alice.cookie));
    for (let i = 1; i < 7; i += 1) {
      const response = await jreq(pub, "/publish/listings", {
        cookie: alice.cookie,
        body: {
          ...listingBody,
          source: { git: `https://github.com/o/r${i}.git`, path: "" },
          suggestedName: `app-${i}`,
        },
      });
      ids.push((await response.json()).listing.id as string);
    }

    const first = await jreq(mod, "/moderation/reports", {
      body: { listingId: ids[0], reason: "same spam" },
      env: moderationEnv,
    });
    expect(first.status).toBe(200);
    const duplicate = await jreq(mod, "/moderation/reports", {
      body: { listingId: ids[0], reason: "same spam" },
      env: moderationEnv,
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, deduplicated: true });

    for (let i = 1; i < 5; i += 1) {
      expect(
        (
          await jreq(mod, "/moderation/reports", {
            body: { listingId: ids[i], reason: `reason-${i}` },
            env: moderationEnv,
          })
        ).status,
      ).toBe(200);
    }
    const limited = await jreq(mod, "/moderation/reports", {
      body: { listingId: ids[5], reason: "one too many" },
      env: moderationEnv,
    });
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("resource_exhausted");
  });

  test("rejects oversized reports and fails closed without a hashing salt", async () => {
    const alice = await login(db, { handle: "alice" });
    const id = await publishOne(alice.cookie);
    expect(
      (
        await jreq(mod, "/moderation/reports", {
          body: { listingId: id, reason: "x".repeat(1001) },
          env: moderationEnv,
        })
      ).status,
    ).toBe(400);
    const unavailable = await jreq(mod, "/moderation/reports", {
      body: { listingId: id, reason: "spam" },
    });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("failed_precondition");
  });
});
