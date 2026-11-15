import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { StoreDb } from "../src/backend/db/client.ts";
import { getListingRow } from "../src/backend/db/listings-store.ts";
import { setPublisherHandle } from "../src/backend/db/publishers-store.ts";
import { listings } from "../src/backend/db/schema.ts";
import { createPublishRoutes } from "../src/backend/routes/publish.ts";
import { createReadRoutes } from "../src/backend/routes/spec-read.ts";
import { createTestDb } from "./helpers/test-db.ts";
import { jreq } from "./helpers/http.ts";
import { login } from "./helpers/login.ts";
import type { Env } from "../src/backend/types.ts";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function input(version: 1 | 2, name: string) {
  return {
    slug: "original",
    source: { git: `https://github.com/example/${name}`, path: "." },
    ...(version === 1
      ? { kind: "worker", surface: "service", provider: "cloudflare" }
      : {}),
    category: "social",
    tags: ["social"],
    suggestedName: name,
    name: { ja: name, en: name },
    description: { ja: "", en: name },
    badge: { ja: "", en: "App" },
  };
}

// Delay only execution of the real mutation builder, after the route read and
// authorization. All SQL construction and execution still use the real DB.
function holdMutation(
  db: StoreDb,
  kind: "update" | "delete",
  entered: ReturnType<typeof latch>,
  gate: ReturnType<typeof latch>,
): StoreDb {
  function hold(query: object): object {
    const proxy = new Proxy(query, {
      get(target, key) {
        if (key === "then") {
          return (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) => {
            entered.release();
            return gate.promise
              .then(() => target as PromiseLike<unknown>)
              .then(resolve, reject);
          };
        }
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args);
          return next === target
            ? proxy
            : next &&
                typeof next === "object" &&
                typeof Reflect.get(next, "then") === "function"
              ? hold(next)
              : next;
        };
      },
    });
    return proxy;
  }
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === kind)
        return (...args: unknown[]) => {
          const query = Reflect.apply(value, target, args);
          return args[0] === listings ? hold(query as object) : query;
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

for (const version of [1, 2] as const) {
  const collection =
    version === 1 ? "/publish/listings" : "/publish/v2/listings";
  const item = `${collection}/alice/original`;

  for (const operation of ["patch", "status", "hide", "delete"] as const) {
    test(`v${version} stale ${operation} cannot mutate a replacement publisher`, async () => {
      const db = await createTestDb();
      const app = createPublishRoutes(
        () => db,
        async () => undefined,
      );
      const alice = await login(db, { handle: "alice" });
      expect(
        (
          await jreq(app, collection, {
            cookie: alice.cookie,
            body: input(version, "original"),
          })
        ).status,
      ).toBe(201);

      const entered = latch();
      const gate = latch();
      const isDelete = operation === "delete";
      const path =
        operation === "status"
          ? `${item}/status`
          : isDelete
            ? `${item}?hard=true`
            : item;
      const method =
        operation === "patch"
          ? "PATCH"
          : operation === "status"
            ? "POST"
            : "DELETE";
      const request = new Request(`https://store.test${path}`, {
        method,
        headers: { cookie: alice.cookie, "content-type": "application/json" },
        ...(operation === "patch" || operation === "status"
          ? {
              body: JSON.stringify(
                operation === "patch"
                  ? input(version, "stale-edit")
                  : { status: "hidden" },
              ),
            }
          : {}),
      });
      // Unlike ReadableStream.pull, this hook is reached only when the route
      // actually consumes JSON after its authorized listing snapshot.
      if (operation === "patch" || operation === "status") {
        const text = request.text.bind(request);
        request.text = async () => {
          entered.release();
          await gate.promise;
          return text();
        };
      }
      // DELETE has no body await: defer execution of its real UPDATE/DELETE.
      const routeDb =
        isDelete || operation === "hide"
          ? holdMutation(db, isDelete ? "delete" : "update", entered, gate)
          : db;
      const routed = createPublishRoutes(
        () => routeDb,
        async () => undefined,
      );
      const pending = Promise.resolve(routed.fetch(request, {} as never));
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("request completed before its race boundary");
          }),
        ]);
        expect(
          (
            await jreq(app, `${item}?hard=true`, {
              method: "DELETE",
              cookie: alice.cookie,
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await setPublisherHandle(db, {
              id: alice.publisherId,
              handle: "alice-renamed",
              now: new Date(),
            })
          ).ok,
        ).toBe(true);
        const bob = await login(db, { handle: "alice" });
        expect(
          (
            await jreq(app, collection, {
              cookie: bob.cookie,
              body: input(version, "replacement"),
            })
          ).status,
        ).toBe(201);
        const before = await getListingRow(db, "alice/original");
        expect(before?.publisherId).toBe(bob.publisherId);
        gate.release();
        const response = await pending;
        const after = await getListingRow(db, "alice/original");
        expect({ status: response.status, row: after }).toEqual({
          status: 409,
          row: before,
        });
        expect(await response.json()).toMatchObject({
          error: { code: "conflict" },
        });
        const read = createReadRoutes(() => db);
        const publicListing = await jreq(
          read,
          `/tcs/v${version}/listings/alice/original`,
        );
        expect(publicListing.status).toBe(200);
        expect((await publicListing.json()).source.git).toBe(
          "https://github.com/example/replacement",
        );
      } finally {
        gate.release();
        await pending;
      }
    });
  }

  test(`v${version} current owner keeps normal update, status and deletion`, async () => {
    const db = await createTestDb();
    const app = createPublishRoutes(
      () => db,
      async () => undefined,
    );
    const owner = await login(db, { handle: "alice" });
    expect(
      (
        await jreq(app, collection, {
          cookie: owner.cookie,
          body: input(version, "original"),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await jreq(app, item, {
          method: "PATCH",
          cookie: owner.cookie,
          body: input(version, "edited"),
        })
      ).status,
    ).toBe(200);
    expect((await getListingRow(db, "alice/original"))?.suggestedName).toBe(
      "edited",
    );
    expect(
      (
        await jreq(app, `${item}/status`, {
          cookie: owner.cookie,
          body: { status: "hidden" },
        })
      ).status,
    ).toBe(200);
    expect((await getListingRow(db, "alice/original"))?.status).toBe("hidden");
    expect(
      (
        await jreq(app, `${item}/status`, {
          cookie: owner.cookie,
          body: { status: "visible" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await jreq(app, item, { method: "DELETE", cookie: owner.cookie }))
        .status,
    ).toBe(200);
    expect((await getListingRow(db, "alice/original"))?.status).toBe("hidden");
    expect(
      (
        await jreq(app, `${item}?hard=true`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(200);
    expect(await getListingRow(db, "alice/original")).toBeNull();
    expect(
      (
        await db
          .select()
          .from(listings)
          .where(eq(listings.publisherId, owner.publisherId))
      ).length,
    ).toBe(0);
  });

  test(`v${version} rejected PATCH cleans only an unreferenced candidate icon`, async () => {
    for (const sharedCandidate of [false, true]) {
      const db = await createTestDb();
      const originalIcon = `https://store.test/icons/${"a".repeat(64)}`;
      const replacementIcon = `https://store.test/icons/${"b".repeat(64)}`;
      const candidateIcon = sharedCandidate
        ? replacementIcon
        : `https://store.test/icons/${"c".repeat(64)}`;
      let icon = originalIcon;
      const app = createPublishRoutes(
        () => db,
        async () => icon,
      );
      const deleted: string[] = [];
      const env = {
        ICONS: {
          delete: async (key: string) => {
            deleted.push(key);
          },
        },
      } as unknown as Env;
      const alice = await login(db, { handle: "alice" });
      expect(
        (
          await jreq(app, collection, {
            cookie: alice.cookie,
            body: input(version, "original"),
            env,
          })
        ).status,
      ).toBe(201);
      const entered = latch();
      const gate = latch();
      const staleApp = createPublishRoutes(
        () => db,
        async () => {
          entered.release();
          await gate.promise;
          return candidateIcon;
        },
      );
      const pending = jreq(staleApp, item, {
        method: "PATCH",
        cookie: alice.cookie,
        body: input(version, "stale-edit"),
        env,
      });
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("PATCH completed before icon processing");
          }),
        ]);
        expect(
          (
            await jreq(app, `${item}?hard=true`, {
              method: "DELETE",
              cookie: alice.cookie,
              env,
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await setPublisherHandle(db, {
              id: alice.publisherId,
              handle: "alice-renamed",
              now: new Date(),
            })
          ).ok,
        ).toBe(true);
        const bob = await login(db, { handle: "alice" });
        icon = replacementIcon;
        expect(
          (
            await jreq(app, collection, {
              cookie: bob.cookie,
              body: input(version, "replacement"),
              env,
            })
          ).status,
        ).toBe(201);
        const before = await getListingRow(db, "alice/original");
        deleted.length = 0;
        gate.release();
        expect((await pending).status).toBe(409);
        expect(await getListingRow(db, "alice/original")).toEqual(before);
        expect(deleted).toEqual(
          sharedCandidate ? [] : [`icons/${"c".repeat(64)}`],
        );
      } finally {
        gate.release();
        await pending;
      }
    }
  });
}
