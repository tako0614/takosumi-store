/**
 * Operator loader for the official first-party Takos-ecosystem listings.
 *
 * Store rows are repository discovery pointers plus browse presentation. They
 * must not become install authority: setup inputs, installExperience, and
 * output allowlist hints live in the app repository's optional
 * `.well-known/tcs.json` and are read by installers from Git.
 *
 * It emits idempotent `INSERT ... ON CONFLICT(id) DO UPDATE` SQL to stdout.
 * Retired official aliases are deleted first so the source-identity unique
 * index cannot keep stale presentation IDs alive:
 *
 *   bun run scripts/load-official-listings.ts > /tmp/official.sql
 *   bunx wrangler d1 execute takosumi-store-db --remote --config wrangler.toml --file /tmp/official.sql
 */
import { getTableColumns } from "drizzle-orm";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { R2Bucket } from "@cloudflare/workers-types";
import { listingToInsert } from "../src/backend/db/listings-store.ts";
import { listings } from "../src/backend/db/schema.ts";
import { rehostListingIcon } from "../src/backend/lib/icon-rehost.ts";
import { validatePublishInput } from "../src/backend/lib/listing-validate.ts";
import type { Listing, LocalizedText } from "../spec/listing.ts";

const t = (ja: string, en: string): LocalizedText => ({ ja, en });
const NOW = "2026-07-07T00:00:00.000Z";
const publisher = { handle: "tako", displayName: "Takos" } as const;
const RETIRED_OFFICIAL_IDS = ["tako/office", "tako/computer"] as const;

type ListingDisplay = Pick<
  Listing,
  | "kind"
  | "surface"
  | "provider"
  | "category"
  | "tags"
  | "suggestedName"
  | "name"
  | "description"
  | "badge"
> & {
  readonly iconUrl?: string;
};

interface OfficialSource {
  readonly scope: "tako";
  readonly slug: string;
  readonly git: string;
  readonly path: string;
  readonly display: ListingDisplay;
}

const OFFICIAL_SOURCES: readonly OfficialSource[] = [
  {
    scope: "tako",
    slug: "yurucommu",
    git: "https://github.com/tako0614/yurucommu.git",
    path: ".",
    display: {
      kind: "worker",
      surface: "service",
      provider: "cloudflare",
      category: "social",
      tags: ["social", "activitypub", "community"],
      suggestedName: "yurucommu",
      name: t("yurucommu", "yurucommu"),
      description: t(
        "自分用のコミュニティ / ActivityPub アプリをホストします。",
        "Host a personal community / ActivityPub app.",
      ),
      badge: t("追加候補", "Installable"),
    },
  },
  {
    scope: "tako",
    slug: "takos-storage",
    git: "https://github.com/tako0614/takos-storage.git",
    path: ".",
    display: {
      kind: "storage",
      surface: "service",
      provider: "cloudflare",
      category: "storage",
      tags: ["storage", "object-storage", "service"],
      suggestedName: "storage",
      name: t("Takos Storage", "Takos Storage"),
      description: t(
        "HTTP API で使えるオブジェクトストレージサービスをホストします。",
        "Host an object storage service with an HTTP API.",
      ),
      badge: t("追加候補", "Installable"),
    },
  },
  {
    scope: "tako",
    slug: "takos-git",
    git: "https://github.com/tako0614/takos-git.git",
    path: ".",
    display: {
      kind: "storage",
      surface: "service",
      provider: "cloudflare",
      category: "developer",
      tags: ["developer", "git", "source"],
      suggestedName: "git",
      name: t("Takos Git", "Takos Git"),
      description: t(
        "Git Smart HTTP で使えるリポジトリサービスをホストします。",
        "Host a repository service over Git Smart HTTP.",
      ),
      badge: t("追加候補", "Installable"),
    },
  },
  {
    scope: "tako",
    slug: "takos",
    git: "https://github.com/tako0614/takos.git",
    path: "deploy/opentofu",
    display: {
      kind: "worker",
      surface: "service",
      provider: "cloudflare",
      category: "workspace",
      tags: ["workspace", "ai"],
      suggestedName: "takos",
      name: t("Takos", "Takos"),
      description: t(
        "AI ワークスペースを自分の環境にホストします。",
        "Host the Takos AI workspace in your own environment.",
      ),
      badge: t("追加候補", "Installable"),
    },
  },
  {
    scope: "tako",
    slug: "takos-office",
    git: "https://github.com/tako0614/takos-office.git",
    path: ".",
    display: {
      kind: "worker",
      surface: "service",
      provider: "cloudflare",
      category: "productivity",
      tags: ["productivity", "office", "docs"],
      suggestedName: "takos-office",
      name: t("Takos Office", "Takos Office"),
      description: t(
        "ドキュメント・スライド・シートを 1 つの worker に統合した office suite。",
        "Documents, slides, and spreadsheets in one self-hostable worker.",
      ),
      badge: t("追加候補", "Installable"),
    },
  },
  {
    scope: "tako",
    slug: "takos-computer",
    git: "https://github.com/tako0614/takos-computer.git",
    path: ".",
    display: {
      kind: "worker",
      surface: "service",
      provider: "cloudflare",
      category: "tools",
      tags: ["tools", "agent", "sandbox"],
      suggestedName: "takos-computer",
      name: t("Takos Computer", "Takos Computer"),
      description: t(
        "AI エージェント向けのコンテナ化サンドボックス実行環境。",
        "A containerized sandbox execution environment for AI agents.",
      ),
      badge: t("追加候補", "Installable"),
    },
  },
];

function rawGithubUrl(source: OfficialSource, filePath: string): string {
  const url = new URL(source.git);
  const parts = url.pathname
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  if (url.hostname !== "github.com" || parts.length < 2) {
    throw new Error(`unsupported official git URL: ${source.git}`);
  }
  return `https://raw.githubusercontent.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/HEAD/${filePath
    .replace(/^\.?\//u, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function githubRepoName(source: OfficialSource): string {
  const url = new URL(source.git);
  const parts = url.pathname
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  if (url.hostname !== "github.com" || parts.length < 2) {
    throw new Error(`unsupported official git URL: ${source.git}`);
  }
  return parts[1]!;
}

function localOfficialRepoPath(source: OfficialSource): string | undefined {
  const root = process.env.TAKOSUMI_STORE_OFFICIAL_LOCAL_REPO_ROOT?.trim();
  if (!root) return undefined;
  const repoName = githubRepoName(source);
  for (const candidate of [
    join(root, repoName),
    join(root, "takos", repoName),
    join(root, "takos-apps", repoName),
  ]) {
    if (!existsSync(join(candidate, ".git"))) continue;
    return candidate;
  }
  return undefined;
}

function localRepoMetadata(
  source: OfficialSource,
): Record<string, unknown> | undefined {
  const repoPath = localOfficialRepoPath(source);
  if (!repoPath) return undefined;
  const path = join(repoPath, ".well-known", "tcs.json");
  if (!existsSync(path)) return {};
  const body = record(JSON.parse(readFileSync(path, "utf8")));
  return text(body.schemaVersion) === "tcs.repo/v1" ? body : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function repoMetadata(
  source: OfficialSource,
): Promise<Record<string, unknown>> {
  const local = localRepoMetadata(source);
  if (local) return local;
  const res = await fetch(rawGithubUrl(source, ".well-known/tcs.json"), {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return {};
  if (!res.ok) {
    console.error(
      `warning: ${source.slug} repo metadata ${res.status}; using listing defaults`,
    );
    return {};
  }
  const json = await res.json();
  const body = record(json);
  return text(body.schemaVersion) === "tcs.repo/v1" ? body : {};
}

function remoteIconBucket(): R2Bucket | undefined {
  if (process.env.TAKOSUMI_STORE_ICON_REHOST !== "remote") return undefined;
  const bucketName =
    process.env.TAKOSUMI_STORE_ICON_BUCKET?.trim() || "takosumi-store-icons";
  const config =
    process.env.TAKOSUMI_STORE_WRANGLER_CONFIG?.trim() || "wrangler.toml";
  return {
    async put(key, value, options) {
      if (!(value instanceof Uint8Array)) {
        throw new Error("official icon uploader requires materialized bytes");
      }
      const dir = mkdtempSync(join(tmpdir(), "takosumi-store-icon-"));
      chmodSync(dir, 0o700);
      const file = join(dir, "icon");
      try {
        writeFileSync(file, value, { mode: 0o600 });
        const contentType = options?.httpMetadata?.contentType;
        const cacheControl = options?.httpMetadata?.cacheControl;
        const args = [
          "x",
          "wrangler",
          "r2",
          "object",
          "put",
          `${bucketName}/${key}`,
          "--remote",
          "--force",
          "--config",
          config,
          "--file",
          file,
          ...(contentType ? ["--content-type", contentType] : []),
          ...(cacheControl ? ["--cache-control", cacheControl] : []),
        ];
        const uploaded = spawnSync(process.execPath, args, {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "ignore", "pipe"],
        });
        if (uploaded.status !== 0) {
          throw new Error(uploaded.stderr || "wrangler R2 upload failed");
        }
        return {} as Awaited<ReturnType<R2Bucket["put"]>>;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  } as unknown as R2Bucket;
}

async function officialIconUrl(
  source: OfficialSource,
): Promise<string | undefined> {
  return await rehostListingIcon({
    bucket: remoteIconBucket(),
    origin:
      process.env.TAKOSUMI_STORE_PUBLIC_ORIGIN?.trim() ||
      "https://store.takosumi.com",
    source: { git: source.git },
    discoverWhenMissing: true,
  });
}

async function officialListing(source: OfficialSource): Promise<Listing> {
  const meta = await repoMetadata(source);
  const modulePath = text(meta.modulePath) ?? source.path;
  const rehostedIconUrl = await officialIconUrl(source);
  const validated = validatePublishInput({
    ...source.display,
    ...(text(meta.kind) ? { kind: text(meta.kind) } : {}),
    ...(text(meta.surface) ? { surface: text(meta.surface) } : {}),
    ...(text(meta.provider) ? { provider: text(meta.provider) } : {}),
    ...(text(meta.category) ? { category: text(meta.category) } : {}),
    ...(Array.isArray(meta.tags) ? { tags: meta.tags } : {}),
    ...(text(meta.suggestedName)
      ? { suggestedName: text(meta.suggestedName) }
      : {}),
    ...(Object.keys(record(meta.name)).length > 0 ? { name: meta.name } : {}),
    ...(Object.keys(record(meta.description)).length > 0
      ? { description: meta.description }
      : {}),
    ...(Object.keys(record(meta.badge)).length > 0
      ? { badge: meta.badge }
      : {}),
    source: {
      git: source.git,
      path: modulePath,
    },
    ...(rehostedIconUrl ? { iconUrl: rehostedIconUrl } : {}),
  });
  if (!validated.ok) {
    throw new Error(
      `${source.slug} listing invalid: ${validated.errors.join(", ")}`,
    );
  }
  const display = validated.value;
  return {
    id: `${source.scope}/${source.slug}`,
    scope: source.scope,
    slug: source.slug,
    source: {
      git: source.git,
      path: display.source.path,
    },
    kind: display.kind,
    surface: display.surface,
    provider: display.provider,
    category: display.category,
    tags: display.tags,
    suggestedName: display.suggestedName,
    name: display.name,
    description: display.description,
    badge: display.badge,
    ...(display.iconUrl ? { iconUrl: display.iconUrl } : {}),
    publisher,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

const columnMeta = getTableColumns(listings);
const sqlColOf = (field: string): string => {
  const col = (columnMeta as Record<string, { name: string }>)[field];
  if (!col) throw new Error(`unknown column field: ${field}`);
  return col.name;
};

const official = await Promise.all(OFFICIAL_SOURCES.map(officialListing));
const out: string[] = [];
if (RETIRED_OFFICIAL_IDS.length > 0) {
  out.push(
    `DELETE FROM listings WHERE id IN (${RETIRED_OFFICIAL_IDS.map(sqlValue).join(", ")});`,
  );
}

for (const listing of official) {
  const row = listingToInsert(listing) as Record<string, unknown>;
  const fields = Object.keys(row);
  const cols = fields.map(sqlColOf);
  const vals = fields.map((f) => sqlValue(row[f]));
  const preserve = new Set([
    "id",
    "createdAt",
    "publisherId",
    "publisherHandle",
    "publisherDisplayName",
  ]);
  const updates = fields
    .filter((f) => !preserve.has(f))
    .map((f) => `${sqlColOf(f)}=excluded.${sqlColOf(f)}`);
  out.push(
    `INSERT INTO listings (${cols.join(", ")}) VALUES (${vals.join(", ")})\n` +
      `ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")};`,
  );
}

console.log(out.join("\n\n"));
