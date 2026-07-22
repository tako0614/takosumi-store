import { afterEach, describe, expect, test } from "bun:test";

import {
  CANONICAL_CANARY_SOURCE_GIT,
  runLiveChecks,
  sha256Bytes,
  type StoreArtifactManifest,
  type TargetPolicy,
} from "../scripts/store-release-common.ts";
import { scanSanitizedSnapshot } from "../scripts/store-release-replica-adapter.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const production: TargetPolicy = {
  configPath: "store/wrangler.production.toml",
  accountId: "a".repeat(32),
  workerName: "takosumi-store",
  origin: "https://store.takosumi.com",
  databaseName: "takosumi-store-db",
  databaseId: "00000000-0000-4000-8000-000000000001",
  kvNamespaceId: "b".repeat(32),
  iconsBucketName: "takosumi-store-icons",
  publishCapability: true,
  compatibilityDate: "2026-06-25",
  compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
  requiredVarNames: [
    "APP_URL",
    "TAKOSUMI_ACCOUNTS_CLIENT_ID",
    "TAKOSUMI_ACCOUNTS_ISSUER_URL",
  ],
  requiredSecretNames: ["SESSION_HASH_SALT"],
  customDomainHostname: "store.takosumi.com",
  readbackListingPath: "/tcs/v1/listings/tako/takos",
};

function webpBytes(): Buffer {
  const bytes = Buffer.alloc(12);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(4, 4);
  bytes.write("WEBP", 8, "ascii");
  return bytes;
}

const validIcons = [
  {
    mediaType: "image/png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mediaType: "image/jpeg",
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]),
  },
  { mediaType: "image/webp", bytes: webpBytes() },
  {
    mediaType: "image/svg+xml",
    bytes: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1v1z"/></svg>',
    ),
  },
] as const;

function snapshotBundle(bytes: Buffer, mediaType: string): Buffer {
  const digest = sha256Bytes(bytes);
  const key = `icons/${digest.slice("sha256:".length)}`;
  const listing = {
    id: "tako/takos",
    scope: "tako",
    slug: "takos",
    git: "https://github.com/tako0614/takos.git",
    ref: "HEAD",
    path: "deploy/opentofu",
    kind: "capsule",
    surface: "workspace",
    provider: null,
    category: "productivity",
    tags: "[]",
    suggested_name: "takos",
    name_ja: "Takos",
    name_en: "Takos",
    description_ja: "AI workspace",
    description_en: "AI workspace",
    badge_ja: null,
    badge_en: null,
    icon_url: `{{TAKOSUMI_STORE_REPLICA_ORIGIN}}/${key}`,
    inputs: "{}",
    output_allowlist: "[]",
    publisher_handle: "tako0614",
    publisher_display_name: "Takos",
    status: "visible",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const columns = Object.keys(listing);
  const sqlValue = (value: unknown) =>
    value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
  const sql = Buffer.from(
    [
      "BEGIN;",
      `INSERT INTO listings (${columns.join(", ")})`,
      `VALUES (${columns.map((column) => sqlValue(listing[column as keyof typeof listing])).join(", ")});`,
      "COMMIT;",
    ].join("\n"),
  );
  return Buffer.from(
    JSON.stringify({
      kind: "takosumi.store-sanitized-replica-bundle@v1",
      source: {
        rowDigest: `sha256:${"1".repeat(64)}`,
        iconSourceKind: "public-https-reference",
        iconSourceReferenceDigest: `sha256:${"2".repeat(64)}`,
        iconDigest: digest,
      },
      listing,
      sqlBase64: sql.toString("base64"),
      sqlSha256: sha256Bytes(sql),
      icons: [
        {
          key,
          mediaType,
          bytesBase64: bytes.toString("base64"),
          sha256: digest,
        },
      ],
    }),
  );
}

describe("sanitized replica icon bytes", () => {
  for (const icon of validIcons) {
    test(`accepts ${icon.mediaType} only when its bytes match`, () => {
      const scan = scanSanitizedSnapshot(
        snapshotBundle(icon.bytes, icon.mediaType),
        production,
      );
      expect(scan.icons[0]?.mediaType).toBe(icon.mediaType);
      expect(scan.icons[0]?.sha256).toBe(sha256Bytes(icon.bytes));
    });
  }

  test("rejects a valid image declared as another media type", () => {
    expect(() =>
      scanSanitizedSnapshot(
        snapshotBundle(validIcons[0].bytes, "image/jpeg"),
        production,
      ),
    ).toThrow("replica_snapshot_icon_0_media_type_mismatch");
  });

  test("rejects active SVG content", () => {
    const unsafeSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(() =>
      scanSanitizedSnapshot(
        snapshotBundle(unsafeSvg, "image/svg+xml"),
        production,
      ),
    ).toThrow("replica_snapshot_icon_0_unsafe_svg");
  });

  test("rejects external SVG paint resources", () => {
    const unsafeSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://example.com/p.svg#g)" d="M0 0h1v1z"/></svg>',
    );
    expect(() =>
      scanSanitizedSnapshot(
        snapshotBundle(unsafeSvg, "image/svg+xml"),
        production,
      ),
    ).toThrow("replica_snapshot_icon_0_unsafe_svg");
  });

  test("rejects dangerous SVG elements hidden behind a namespace prefix", () => {
    const unsafeSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',
    );
    expect(() =>
      scanSanitizedSnapshot(
        snapshotBundle(unsafeSvg, "image/svg+xml"),
        production,
      ),
    ).toThrow("replica_snapshot_icon_0_unsafe_svg");
  });

  test("rejects a credential literal in otherwise inert SVG text", () => {
    const unsafeSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>sk_live_not_allowed_in_icon</text></svg>',
    );
    expect(() =>
      scanSanitizedSnapshot(
        snapshotBundle(unsafeSvg, "image/svg+xml"),
        production,
      ),
    ).toThrow("replica_snapshot_icon_0_credential_literal_detected");
  });

  test("rejects PII in otherwise inert SVG text", () => {
    const unsafeSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>owner@example.com</text></svg>',
    );
    expect(() =>
      scanSanitizedSnapshot(
        snapshotBundle(unsafeSvg, "image/svg+xml"),
        production,
      ),
    ).toThrow("replica_snapshot_icon_0_pii_literal_detected");
  });

  test("rejects PII carried in decoded raster metadata bytes", () => {
    const unsafePng = Buffer.concat([
      validIcons[0].bytes,
      Buffer.from("metadata-owner@example.com"),
    ]);
    expect(() =>
      scanSanitizedSnapshot(snapshotBundle(unsafePng, "image/png"), production),
    ).toThrow("replica_snapshot_icon_0_pii_literal_detected");
  });
});

const staticBytes = Buffer.from("console.log('sealed');\n");
const indexBytes = Buffer.from("<!doctype html><title>Store</title>\n");

const manifest = {
  assets: [
    {
      path: "assets/assets/index-release.js",
      size: staticBytes.byteLength,
      sha256: sha256Bytes(staticBytes),
    },
    {
      path: "assets/index.html",
      size: indexBytes.byteLength,
      sha256: sha256Bytes(indexBytes),
    },
  ],
} as unknown as StoreArtifactManifest;

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function stubLiveStore(options: {
  readonly iconBytes: Buffer;
  readonly sourceGit?: string;
  readonly iconDigest?: string;
}): void {
  const iconDigest =
    options.iconDigest ??
    sha256Bytes(options.iconBytes).slice("sha256:".length);
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/healthz") {
      return json({
        status: "ok",
        software: "takosumi-store",
        version: "0.1.13",
      });
    }
    if (url.pathname === "/readyz") {
      return json({ status: "ready", capabilities: { publish: true } });
    }
    if (url.pathname === "/.well-known/tcs") {
      return json({
        server: {
          software: { name: "takosumi-store", version: "0.1.13" },
          baseUrl: production.origin,
        },
      });
    }
    if (url.pathname === production.readbackListingPath) {
      if (init?.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS",
          },
        });
      }
      return json(
        {
          id: "tako/takos",
          scope: "tako",
          slug: "takos",
          source: {
            git: options.sourceGit ?? CANONICAL_CANARY_SOURCE_GIT,
            path: "deploy/opentofu",
          },
          iconUrl: `${production.origin}/icons/${iconDigest}`,
        },
        { headers: { "access-control-allow-origin": "*" } },
      );
    }
    if (url.pathname.startsWith("/icons/")) {
      return new Response(Uint8Array.from(options.iconBytes).buffer, {
        headers: { "content-type": "image/png" },
      });
    }
    if (url.pathname === "/tcs/v1/release-safety-not-found") {
      return json({ error: { code: "not_found" } }, { status: 404 });
    }
    if (url.pathname === "/assets/index-release.js") {
      return new Response(staticBytes, {
        headers: { "content-type": "text/javascript" },
      });
    }
    if (url.pathname === "/release-safety/0.1.13/fallback") {
      return new Response(indexBytes, {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

async function liveCheck(): Promise<void> {
  await runLiveChecks({
    target: production,
    manifest,
    artifactRoot: "/not-read-by-live-check",
    candidateChecks: [],
  });
}

describe("canonical release canary", () => {
  test("accepts the exact source and icon content-address", async () => {
    stubLiveStore({ iconBytes: validIcons[0].bytes });
    await expect(liveCheck()).resolves.toBeUndefined();
  });

  test("rejects a source.git that is merely valid HTTPS", async () => {
    stubLiveStore({
      iconBytes: validIcons[0].bytes,
      sourceGit: "https://github.com/example/takos.git",
    });
    await expect(liveCheck()).rejects.toThrow(
      "canonical_listing_semantics_mismatch",
    );
  });

  test("rejects icon bytes that do not match /icons/<digest>", async () => {
    stubLiveStore({
      iconBytes: validIcons[0].bytes,
      iconDigest: "0".repeat(64),
    });
    await expect(liveCheck()).rejects.toThrow(
      "canonical_listing_icon_readback_invalid",
    );
  });
});
