import { guardedFetchText } from "./fetch-guard.ts";
import type { ListingSource } from "../../../spec/listing.ts";

/**
 * Best-effort README fetch for a listing's source repo, so the store detail
 * page can show real project docs (registry-grade listing pages). Only public
 * git-forge raw hosts are supported; the URL is derived entirely from the
 * listing's own source repository (never caller input) and fetched through the
 * SSRF-guarded fetcher. Returns null on any miss so the UI simply hides it.
 */

interface RepoRef {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

function parseRepo(git: string): RepoRef | null {
  try {
    const u = new URL(git);
    const parts = u.pathname
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "")
      .split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { host: u.host.toLowerCase(), owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

/** Raw-content base URL for a supported forge, or null when unsupported. */
function rawBase(repo: RepoRef, ref: string): string | null {
  const r = encodeURIComponent(ref);
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  if (repo.host === "github.com") {
    return `https://raw.githubusercontent.com/${owner}/${name}/${r}`;
  }
  if (repo.host === "gitlab.com") {
    return `https://gitlab.com/${owner}/${name}/-/raw/${r}`;
  }
  if (repo.host === "codeberg.org") {
    return `https://codeberg.org/${owner}/${name}/raw/commit/${r}`;
  }
  return null;
}

const README_NAMES = ["README.md", "readme.md", "Readme.md", "README"] as const;

export interface ListingReadme {
  readonly markdown: string;
  readonly sourceUrl: string;
}

export async function fetchListingReadme(
  source: ListingSource,
): Promise<ListingReadme | null> {
  const repo = parseRepo(source.git);
  if (!repo) return null;
  const base = rawBase(repo, "HEAD");
  if (!base) return null;

  // Prefer the module subdirectory's README, then the repo root.
  const modPath = (source.path ?? "")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  const dirs = modPath && modPath !== "." ? [modPath, ""] : [""];

  for (const dir of dirs) {
    for (const filename of README_NAMES) {
      const rel = dir
        ? `${dir.split("/").map(encodeURIComponent).join("/")}/${filename}`
        : filename;
      const url = `${base}/${rel}`;
      try {
        const { status, text } = await guardedFetchText(url, {
          timeoutMs: 8_000,
          maxBytes: 256 * 1024,
          headers: { accept: "text/plain, text/markdown, */*" },
        });
        if (status === 200 && text.trim()) {
          return { markdown: text.slice(0, 256 * 1024), sourceUrl: url };
        }
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}
