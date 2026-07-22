import { describe, expect, test } from "bun:test";

import { buildApp } from "../src/backend/index.ts";

describe("release health routes", () => {
  test("healthz reports the exact immutable software version", async () => {
    const response = await buildApp().request("https://store.test/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      software: "takosumi-store",
      version: "0.1.5",
    });
  });

  test("readyz fails closed without DB and reports optional publishing", async () => {
    const missing = await buildApp().request(
      "https://store.test/readyz",
      undefined,
      {} as never,
    );
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({
      status: "unready",
      missing: ["DB"],
    });

    const ready = await buildApp().request(
      "https://store.test/readyz",
      undefined,
      {
        DB: {} as never,
        TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.test",
        TAKOSUMI_ACCOUNTS_CLIENT_ID: "store-client",
      } as never,
    );
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ready",
      capabilities: { publish: true },
    });
  });
});
