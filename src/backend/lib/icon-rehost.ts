import type { R2Bucket } from "@cloudflare/workers-types";
import { guardedFetch, type GuardedResult } from "./fetch-guard.ts";
import { isSafeRemoteUrl } from "./ssrf.ts";

export const MAX_LISTING_ICON_BYTES = 512 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SENSITIVE_QUERY_KEY =
  /(?:^|[_-])(auth|authorization|credential|key|password|secret|signature|token)(?:$|[_-])/iu;

type GuardedFetcher = (
  url: string,
  options?: Parameters<typeof guardedFetch>[1],
) => Promise<GuardedResult>;

export interface ListingIconSource {
  readonly git: string;
}

export interface RehostListingIconInput {
  readonly bucket: R2Bucket | undefined;
  readonly origin: string;
  readonly source: ListingIconSource;
  /** Explicit listing value. Omit to discover it from `.well-known/tcs.json`. */
  readonly reference?: string;
  readonly discoverWhenMissing?: boolean;
  readonly fetcher?: GuardedFetcher;
}

interface PinnedRepositoryContext {
  readonly commit: string;
  readonly rawRootUrl: string;
}

function credentialFreeHttpsUrl(raw: string): string | undefined {
  if (!isSafeRemoteUrl(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hash) return undefined;
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY.test(key)) return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Validate a repository-root-relative presentation path without normalizing it. */
export function repositoryRelativeIconPath(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.length > 1_024) return undefined;
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (decoded.includes("\\") || decoded.startsWith("/")) return undefined;
  const segments = decoded.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments.map(encodeURIComponent).join("/");
}

/**
 * Validate a publisher/repository icon reference. Absolute values must be
 * credential-free HTTPS URLs; relative values are repository-root paths.
 */
export function safeListingIconReference(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  try {
    return credentialFreeHttpsUrl(new URL(value).toString());
  } catch {
    return repositoryRelativeIconPath(value) ? value : undefined;
  }
}

function githubRepository(git: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(git);
    const parts = url.pathname
      .replace(/\/+$/u, "")
      .replace(/\.git$/iu, "")
      .split("/")
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      parts.length !== 2
    ) {
      return null;
    }
    return { owner: parts[0]!, repo: parts[1]! };
  } catch {
    return null;
  }
}

async function pinnedRepositoryContext(
  git: string,
  fetcher: GuardedFetcher,
): Promise<PinnedRepositoryContext | null> {
  const repo = githubRepository(git);
  if (!repo) return null;
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  const result = await fetcher(
    `https://api.github.com/repos/${owner}/${name}/commits/HEAD`,
    {
      timeoutMs: 5_000,
      maxBytes: MAX_METADATA_BYTES,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "takosumi-store-icon-indexer",
      },
    },
  );
  if (result.status !== 200) return null;
  let commit: unknown;
  try {
    commit = (
      JSON.parse(new TextDecoder().decode(result.bytes)) as { sha?: unknown }
    ).sha;
  } catch {
    return null;
  }
  if (typeof commit !== "string" || !COMMIT_SHA.test(commit)) return null;
  return {
    commit,
    rawRootUrl: `https://raw.githubusercontent.com/${owner}/${name}/${commit}/`,
  };
}

function rawFileUrl(
  context: PinnedRepositoryContext,
  relativePath: string,
): string | undefined {
  const path = repositoryRelativeIconPath(relativePath);
  if (!path) return undefined;
  const url = new URL(path, context.rawRootUrl);
  if (!url.toString().startsWith(context.rawRootUrl)) return undefined;
  return credentialFreeHttpsUrl(url.toString());
}

async function discoverIconReference(
  context: PinnedRepositoryContext,
  fetcher: GuardedFetcher,
): Promise<string | undefined> {
  const metadataUrl = rawFileUrl(context, ".well-known/tcs.json");
  if (!metadataUrl) return undefined;
  const result = await fetcher(metadataUrl, {
    timeoutMs: 5_000,
    maxBytes: MAX_METADATA_BYTES,
    headers: { accept: "application/json, text/plain" },
  });
  if (result.status !== 200) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(result.bytes));
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const metadata = body as Record<string, unknown>;
  if (metadata.schemaVersion !== "tcs.repo/v1") return undefined;
  return typeof metadata.iconUrl === "string"
    ? safeListingIconReference(metadata.iconUrl)
    : undefined;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return (
    bytes.length >= prefix.length &&
    prefix.every((value, index) => bytes[index] === value)
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function safeSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const normalized = text.replace(/^\uFEFF/u, "").trimStart();
  if (!/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(normalized)) return false;
  return !/(?:<!doctype|<!entity|<script|<foreignObject|<iframe|<object|<embed|<audio|<video|<image|<style|<use|<feImage|\son[a-z]+\s*=|\s(?:href|xlink:href)\s*=|\sstyle\s*=)/iu.test(
    normalized,
  );
}

/** Return a canonical media type only when the declared type matches the bytes. */
export function validateListingIconBytes(
  declaredContentType: string | null,
  bytes: Uint8Array,
): string | undefined {
  if (bytes.length === 0 || bytes.length > MAX_LISTING_ICON_BYTES) {
    return undefined;
  }
  const type = declaredContentType?.split(";", 1)[0]?.trim().toLowerCase();
  switch (type) {
    case "image/png":
      return startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])
        ? type
        : undefined;
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]) ? type : undefined;
    case "image/gif":
      return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a"
        ? type
        : undefined;
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP"
        ? type
        : undefined;
    case "image/avif": {
      const brand = ascii(bytes, 8, 12);
      return ascii(bytes, 4, 8) === "ftyp" &&
        (brand === "avif" || brand === "avis")
        ? type
        : undefined;
    }
    case "image/svg+xml":
      return safeSvg(bytes) ? type : undefined;
    default:
      return undefined;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolve, validate, and re-host one listing icon. Every failure returns
 * `undefined`; callers publish the listing without an icon.
 */
export async function rehostListingIcon(
  input: RehostListingIconInput,
): Promise<string | undefined> {
  if (!input.bucket) return undefined;
  const origin = canonicalOrigin(input.origin);
  if (!origin) return undefined;
  const fetcher = input.fetcher ?? guardedFetch;
  try {
    let reference = input.reference
      ? safeListingIconReference(input.reference)
      : undefined;
    let context: PinnedRepositoryContext | null = null;
    if (!reference && input.discoverWhenMissing) {
      context = await pinnedRepositoryContext(input.source.git, fetcher);
      if (!context) return undefined;
      reference = await discoverIconReference(context, fetcher);
    }
    if (!reference) return undefined;

    let fetchUrl = credentialFreeHttpsUrl(reference);
    if (!fetchUrl) {
      context ??= await pinnedRepositoryContext(input.source.git, fetcher);
      if (!context) return undefined;
      fetchUrl = rawFileUrl(context, reference);
    }
    if (!fetchUrl) return undefined;

    const result = await fetcher(fetchUrl, {
      timeoutMs: 8_000,
      maxBytes: MAX_LISTING_ICON_BYTES,
      headers: {
        accept:
          "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml",
      },
    });
    if (result.status !== 200) return undefined;
    const contentType = validateListingIconBytes(
      result.contentType,
      result.bytes,
    );
    if (!contentType) return undefined;

    const digest = await sha256Hex(result.bytes);
    if (!SHA256.test(digest)) return undefined;
    await input.bucket.put(`icons/${digest}`, result.bytes, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        sha256: digest,
        ...(context ? { sourceCommit: context.commit } : {}),
      },
    });
    return `${origin}/icons/${digest}`;
  } catch {
    return undefined;
  }
}

export function isRehostedIconKey(value: string): boolean {
  return SHA256.test(value);
}
