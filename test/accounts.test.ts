import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "./helpers/test-db.ts";
import { jreq } from "./helpers/http.ts";
import { login, TEST_SALT } from "./helpers/login.ts";
import type { StoreDb } from "../src/backend/db/client.ts";
import { createAccountRoutes } from "../src/backend/routes/account.ts";
import {
  getPublisherById,
  setPublisherHandle,
  upsertPublisherBySub,
} from "../src/backend/db/publishers-store.ts";
import {
  createSession,
  deleteSession,
  hashToken,
  lookupSessionPublisherId,
  parseSessionCookie,
} from "../src/backend/lib/session.ts";

let db: StoreDb;
let app: ReturnType<typeof createAccountRoutes>;

beforeEach(async () => {
  db = await createTestDb();
  app = createAccountRoutes(() => db);
});

describe("publishers + sessions", () => {
  test("upsert by sub is idempotent", async () => {
    const now = new Date();
    const a = await upsertPublisherBySub(db, { id: "p1", sub: "s1", now });
    const b = await upsertPublisherBySub(db, { id: "p2", sub: "s1", now });
    expect(a.id).toBe(b.id);
  });

  test("setPublisherHandle: invalid, taken, ok", async () => {
    const now = new Date();
    const a = await upsertPublisherBySub(db, { id: "p1", sub: "s1", now });
    const b = await upsertPublisherBySub(db, { id: "p2", sub: "s2", now });
    expect(
      (await setPublisherHandle(db, { id: a.id, handle: "A!", now })).ok,
    ).toBe(false);
    expect(
      (await setPublisherHandle(db, { id: a.id, handle: "alice", now })).ok,
    ).toBe(true);
    const taken = await setPublisherHandle(db, {
      id: b.id,
      handle: "alice",
      now,
    });
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.reason).toBe("taken");
  });

  test("session create / lookup / delete; cookie hashing is stable", async () => {
    const now = new Date();
    const p = await upsertPublisherBySub(db, { id: "p1", sub: "s1", now });
    await createSession(db, {
      publisherId: p.id,
      token: "tok",
      salt: TEST_SALT,
      now,
    });
    expect(
      await lookupSessionPublisherId(db, {
        token: "tok",
        salt: TEST_SALT,
        now,
      }),
    ).toBe(p.id);
    expect(await hashToken("tok", TEST_SALT)).toBe(
      await hashToken("tok", TEST_SALT),
    );
    await deleteSession(db, { token: "tok", salt: TEST_SALT });
    expect(
      await lookupSessionPublisherId(db, {
        token: "tok",
        salt: TEST_SALT,
        now,
      }),
    ).toBeNull();
    expect(parseSessionCookie("tcs_session=abc; x=1")).toBe("abc");
  });
});

describe("account routes", () => {
  test("config reports oidc disabled when unset", async () => {
    const res = await jreq(app, "/account/config");
    expect((await res.json()).oidc).toBe(false);
  });

  test("/account/me is 401 without a session", async () => {
    expect((await jreq(app, "/account/me")).status).toBe(401);
  });

  test("/account/me returns the publisher with a session cookie", async () => {
    const { cookie, publisherId } = await login(db, { handle: "alice" });
    const res = await jreq(app, "/account/me", { cookie });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publisher.id).toBe(publisherId);
    expect(body.publisher.handle).toBe("alice");
  });

  test("/account/handle requires auth and sets the handle", async () => {
    expect(
      (await jreq(app, "/account/handle", { body: { handle: "x" } })).status,
    ).toBe(401);
    const { cookie, publisherId } = await login(db);
    const res = await jreq(app, "/account/handle", {
      cookie,
      body: { handle: "bob" },
    });
    expect(res.status).toBe(200);
    expect((await getPublisherById(db, publisherId))?.handle).toBe("bob");
  });

  test("/account/logout clears the cookie", async () => {
    const { cookie } = await login(db, { handle: "alice" });
    const res = await jreq(app, "/account/logout", { cookie, method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });
});
