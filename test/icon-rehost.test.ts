import { describe, expect, test } from "bun:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import {
  repositoryRelativeIconPath,
  rehostListingIcon,
  safeListingIconReference,
  validateListingIconBytes,
} from "../src/backend/lib/icon-rehost.ts";

const encoder = new TextEncoder();
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const commit = "a".repeat(40);

function result(
  status: number,
  contentType: string,
  body: string | Uint8Array,
) {
  return {
    status,
    contentType,
    bytes: typeof body === "string" ? encoder.encode(body) : body,
  };
}

function recordingBucket() {
  const puts: Array<{
    key: string;
    value: Uint8Array;
    options: Record<string, unknown>;
  }> = [];
  const bucket = {
    async put(
      key: string,
      value: Uint8Array,
      options: Record<string, unknown>,
    ) {
      puts.push({ key, value, options });
      return {};
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

describe("listing icon re-hosting", () => {
  test("discovers a relative repo icon at one pinned commit and re-hosts it", async () => {
    const { bucket, puts } = recordingBucket();
    const calls: string[] = [];
    const url = await rehostListingIcon({
      bucket,
      origin: "https://store.example.test/some/path",
      source: { git: "https://github.com/acme/widget.git" },
      discoverWhenMissing: true,
      fetcher: async (requestUrl) => {
        calls.push(requestUrl);
        if (requestUrl.endsWith("/commits/HEAD")) {
          return result(
            200,
            "application/json",
            JSON.stringify({ sha: commit }),
          );
        }
        if (requestUrl.endsWith(`/${commit}/.well-known/tcs.json`)) {
          return result(
            200,
            "text/plain; charset=utf-8",
            JSON.stringify({
              schemaVersion: "tcs.repo/v1",
              iconUrl: "assets/icon.png",
            }),
          );
        }
        if (requestUrl.endsWith(`/${commit}/assets/icon.png`)) {
          return result(200, "image/png", png);
        }
        throw new Error(`unexpected request ${requestUrl}`);
      },
    });

    expect(calls).toEqual([
      "https://api.github.com/repos/acme/widget/commits/HEAD",
      `https://raw.githubusercontent.com/acme/widget/${commit}/.well-known/tcs.json`,
      `https://raw.githubusercontent.com/acme/widget/${commit}/assets/icon.png`,
    ]);
    expect(url).toMatch(
      /^https:\/\/store\.example\.test\/icons\/[a-f0-9]{64}$/u,
    );
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^icons\/[a-f0-9]{64}$/u);
    expect(puts[0]!.value).toEqual(png);
    expect(puts[0]!.options).toEqual({
      httpMetadata: {
        contentType: "image/png",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        sha256: puts[0]!.key.slice("icons/".length),
        sourceCommit: commit,
      },
    });
  });

  test("re-hosts an explicit absolute URL without resolving a repository", async () => {
    const { bucket, puts } = recordingBucket();
    const calls: string[] = [];
    const url = await rehostListingIcon({
      bucket,
      origin: "https://store.example.test",
      source: { git: "https://example.com/acme/widget.git" },
      reference: "https://cdn.example.com/icon.png",
      fetcher: async (requestUrl) => {
        calls.push(requestUrl);
        return result(200, "image/png", png);
      },
    });
    expect(url).toMatch(/^https:\/\/store\.example\.test\/icons\//u);
    expect(calls).toEqual(["https://cdn.example.com/icon.png"]);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.options).toEqual({
      httpMetadata: {
        contentType: "image/png",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { sha256: puts[0]!.key.slice("icons/".length) },
    });
  });

  test("unsafe references and unavailable managed storage degrade to no icon", async () => {
    const { bucket, puts } = recordingBucket();
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount += 1;
      return result(200, "image/png", png);
    };
    for (const reference of [
      "../secret.png",
      "%2e%2e/secret.png",
      "/root.png",
      "javascript:alert(1)",
      "https://cdn.example.com/icon.png?access_token=secret",
      "https://user:password@cdn.example.com/icon.png",
    ]) {
      expect(
        await rehostListingIcon({
          bucket,
          origin: "https://store.example.test",
          source: { git: "https://example.com/acme/widget.git" },
          reference,
          fetcher,
        }),
      ).toBeUndefined();
    }
    expect(
      await rehostListingIcon({
        bucket: undefined,
        origin: "https://store.example.test",
        source: { git: "https://github.com/acme/widget.git" },
        reference: "assets/icon.png",
        fetcher,
      }),
    ).toBeUndefined();
    expect(fetchCount).toBe(0);
    expect(puts).toHaveLength(0);
  });

  test("rejects oversized, mislabeled, and active SVG bodies", async () => {
    const { bucket, puts } = recordingBucket();
    for (const response of [
      result(200, "image/png", encoder.encode("not a png")),
      result(200, "text/html", png),
      result(200, "image/png", new Uint8Array(512 * 1024 + 1)),
      result(
        200,
        "image/svg+xml",
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    ]) {
      expect(
        await rehostListingIcon({
          bucket,
          origin: "https://store.example.test",
          source: { git: "https://example.com/acme/widget.git" },
          reference: "https://cdn.example.com/icon",
          fetcher: async () => response,
        }),
      ).toBeUndefined();
    }
    expect(puts).toHaveLength(0);
  });
});

describe("listing icon validation", () => {
  test("accepts safe repository paths and credential-free HTTPS URLs", () => {
    expect(repositoryRelativeIconPath("assets/icon.png")).toBe(
      "assets/icon.png",
    );
    expect(safeListingIconReference("assets/icon.svg")).toBe("assets/icon.svg");
    expect(
      safeListingIconReference("https://cdn.example.com/icon.webp?v=1"),
    ).toBe("https://cdn.example.com/icon.webp?v=1");
  });

  test("validates declared media type against bytes", () => {
    expect(validateListingIconBytes("image/png", png)).toBe("image/png");
    expect(
      validateListingIconBytes(
        "image/svg+xml; charset=utf-8",
        encoder.encode(
          '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
        ),
      ),
    ).toBe("image/svg+xml");
    expect(validateListingIconBytes("image/jpeg", png)).toBeUndefined();
  });
});
