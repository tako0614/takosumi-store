import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { readCors } from "../src/backend/lib/cors.ts";

function appWithCors() {
  const app = new Hono();
  app.use("/tcs/*", readCors as never);
  app.get("/tcs/v1/listings", (c) => c.json({ items: [] }));
  return app;
}

describe("read CORS", () => {
  test("GET responses allow any origin", async () => {
    const res = await appWithCors().fetch(
      new Request("https://store.test/tcs/v1/listings"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("OPTIONS preflight short-circuits with CORS headers", async () => {
    const res = await appWithCors().fetch(
      new Request("https://store.test/tcs/v1/listings", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
