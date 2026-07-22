import { describe, expect, test } from "bun:test";
import { decodeCursor, encodeCursor } from "../src/backend/lib/cursor.ts";

describe("cursor", () => {
  test("roundtrips ascii payloads", () => {
    const c = encodeCursor({ k: "2026-06-24T00:00:00.000Z", id: "abc" });
    expect(decodeCursor(c)).toEqual({
      k: "2026-06-24T00:00:00.000Z",
      id: "abc",
    });
  });

  test("roundtrips non-latin1 (Japanese) keys", () => {
    const c = encodeCursor({ k: "ゆるこみゅ", id: "x-1" });
    expect(decodeCursor(c)).toEqual({ k: "ゆるこみゅ", id: "x-1" });
  });

  test("is url-safe (no +/=)", () => {
    const c = encodeCursor({ k: "a/b+c=d", id: "id?&" });
    expect(c).not.toMatch(/[+/=]/);
  });

  test("returns null for malformed input", () => {
    expect(decodeCursor("!!!not base64!!!")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    // valid base64 but wrong shape
    expect(decodeCursor(btoa(JSON.stringify({ k: 1 })))).toBeNull();
  });
});
