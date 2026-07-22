import { afterEach, describe, expect, test } from "bun:test";
import {
  initState,
  loadMore,
  sortItems,
  type AggregatedListing,
} from "../web/src/lib/aggregate.ts";
import type { KnownServer } from "../web/src/lib/servers.ts";
import type { Listing } from "../spec/listing.ts";

const text = (s: string) => ({ ja: s, en: s });
function L(
  id: string,
  source?: Partial<Listing["source"]>,
  updatedAt = "2026-01-01T00:00:00.000Z",
): Listing {
  return {
    id,
    scope: "test",
    slug: id,
    source: {
      git: `https://github.com/o/${id}.git`,
      path: "",
      ...source,
    },
    kind: "worker",
    surface: "service",
    provider: "cloudflare",
    category: "x",
    tags: [],
    suggestedName: id,
    name: text(id),
    description: text(id),
    badge: text("b"),
    createdAt: updatedAt,
    updatedAt,
  };
}

const SERVERS: KnownServer[] = [
  { base: "https://a.test", home: true },
  { base: "https://b.test", home: false },
];

type Handler = (url: URL) => Response | Promise<Response>;
const origFetch = globalThis.fetch;
function stubFetch(handler: Handler): void {
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(handler(new URL(String(input))))) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = origFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SHARED = { git: "https://github.com/o/shared.git" };

describe("aggregate", () => {
  test("merges across servers and de-dups shared Capsules with seenOn", async () => {
    stubFetch((url) => {
      if (url.host === "a.test") {
        return json({ items: [L("x"), L("shared", SHARED)] });
      }
      return json({ items: [L("y"), L("shared", SHARED)] });
    });
    const s = await loadMore(
      initState(SERVERS, { sort: "updated", locale: "en" }),
    );
    expect(s.items.map((i) => i.id).sort()).toEqual(["shared", "x", "y"]);
    const shared = s.items.find((i) => i.id === "shared")!;
    expect(shared.seenOn.sort()).toEqual(["https://a.test", "https://b.test"]);
    expect(s.done).toBe(true);
    expect(s.status.every((st) => st.ok)).toBe(true);
  });

  test("a failing server is isolated; others still render", async () => {
    stubFetch((url) => {
      if (url.host === "a.test") return json({ items: [L("x")] });
      throw new Error("network down");
    });
    const s = await loadMore(
      initState(SERVERS, { sort: "updated", locale: "en" }),
    );
    expect(s.items.map((i) => i.id)).toEqual(["x"]);
    const b = s.status.find((st) => st.base === "https://b.test")!;
    expect(b.ok).toBe(false);
    expect(b.error).toBeDefined();
  });

  test("search-unsupported (501) server is marked and skipped, not fatal", async () => {
    stubFetch((url) => {
      if (url.host === "a.test") return json({ items: [L("x")] });
      return json({ error: { code: "not_implemented" } }, 501);
    });
    const s = await loadMore(
      initState(SERVERS, { sort: "updated", locale: "en", q: "foo" }),
    );
    expect(s.items.map((i) => i.id)).toEqual(["x"]);
    const b = s.status.find((st) => st.base === "https://b.test")!;
    expect(b.supported).toBe(false);
  });

  test("paginates per-server until all cursors exhaust", async () => {
    stubFetch((url) => {
      const cursor = url.searchParams.get("cursor");
      if (url.host === "a.test") {
        return cursor
          ? json({ items: [L("a2")] })
          : json({ items: [L("a1")], nextCursor: "A2" });
      }
      return json({ items: [L("b1")] });
    });
    let s = await loadMore(
      initState(SERVERS, { sort: "updated", locale: "en" }),
    );
    expect(s.done).toBe(false); // a.test still has a cursor
    expect(s.items.map((i) => i.id).sort()).toEqual(["a1", "b1"]);
    s = await loadMore(s);
    expect(s.done).toBe(true);
    expect(s.items.map((i) => i.id).sort()).toEqual(["a1", "a2", "b1"]);
  });

  test("sortItems orders updated desc and name asc", () => {
    const items: AggregatedListing[] = [
      {
        ...L("old", undefined, "2026-01-01T00:00:00.000Z"),
        seenOn: [],
        primaryServer: "",
        primaryHome: false,
      },
      {
        ...L("new", undefined, "2026-02-01T00:00:00.000Z"),
        seenOn: [],
        primaryServer: "",
        primaryHome: false,
      },
    ];
    expect(sortItems(items, "updated", "en").map((i) => i.id)).toEqual([
      "new",
      "old",
    ]);
    expect(sortItems(items, "name", "en").map((i) => i.id)).toEqual([
      "new",
      "old",
    ]);
  });
});
