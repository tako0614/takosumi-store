import { describe, expect, test } from "bun:test";

import { buildApp } from "../src/backend/index.ts";

describe("release health routes", () => {
  test("healthz reports the exact immutable software version", async () => {
    const response = await buildApp().request("https://store.test/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      software: "takosumi-store",
      version: "0.1.14",
    });
  });

  test("readyz requires every read binding and a usable listings schema", async () => {
    const missing = await buildApp().request(
      "https://store.test/readyz",
      undefined,
      {} as never,
    );
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({
      status: "unready",
      missing: ["DB", "ICONS", "KV"],
    });

    const db = {
      prepare: () => ({
        first: async () => ({ ok: 1 }),
      }),
    };
    const icons = { head: async () => null };
    const kv = { get: async () => null };
    const ready = await buildApp().request(
      "https://store.test/readyz",
      undefined,
      {
        DB: db as never,
        ICONS: icons as never,
        KV: kv as never,
        SESSION_HASH_SALT: "test-salt",
        TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.test",
        TAKOSUMI_ACCOUNTS_CLIENT_ID: "store-client",
      } as never,
    );
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ready",
      capabilities: { publish: true },
    });

    const broken = await buildApp().request(
      "https://store.test/readyz",
      undefined,
      {
        DB: {
          prepare: () => ({
            first: async () => {
              throw new Error("no such table: listings");
            },
          }),
        },
        ICONS: icons as never,
        KV: kv as never,
      } as never,
    );
    expect(broken.status).toBe(503);
    expect(await broken.json()).toEqual({
      status: "unready",
      failed: ["DB_SCHEMA"],
    });
  });

  test("internal errors use a stable opaque envelope", async () => {
    const response = await buildApp().request(
      "https://store.test/tcs/v1/listings",
      undefined,
      {
        DB: {
          prepare: () => {
            throw new Error("sensitive database detail");
          },
        },
      } as never,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "internal_error", message: "internal error" },
    });
  });
});
