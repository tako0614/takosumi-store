import { describe, expect, test } from "bun:test";
import { buildInstallUrl } from "../web/src/lib/install-link.ts";
import type { Listing } from "../spec/listing.ts";

/**
 * Faithful replica of takosumi/dashboard/src/lib/install-link.ts
 * parseInstallPrefill acceptance rules (the store cannot import takosumi, so we
 * pin field-for-field compatibility here). If the real parser changes, this
 * replica should be updated in lockstep.
 */
function isSafeHttpsGitUrl(raw: string): boolean {
  const v = raw.trim();
  if (!v || /[\r\n\0]/.test(v)) return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password;
}
function parseName(value: string | null): string | undefined {
  const n = value?.trim();
  if (!n || /[\r\n\0]/.test(n)) return undefined;
  return n.slice(0, 96);
}
function parseInstallPrefill(urlStr: string) {
  const p = new URL(urlStr).searchParams;
  const git = p.get("git") ?? "";
  if (!isSafeHttpsGitUrl(git)) return undefined;
  const vars: Record<string, string> = {};
  for (const [k, v] of p) {
    if (!k.startsWith("var.")) continue;
    const n = k.slice(4);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue;
    if (/(secret|token|password|credential|private_?key|api_?key)/i.test(n))
      continue;
    if (v.length > 512 || /[\r\n\0]/.test(v)) continue;
    vars[n] = v;
  }
  return {
    git,
    ref: (p.get("ref") ?? "").trim(),
    path: (p.get("path") ?? "").trim(),
    name: parseName(p.get("name")),
    vars,
  };
}

const listing: Listing = {
  id: "x",
  scope: "test",
  slug: "x",
  source: {
    git: "https://github.com/o/r.git",
    path: "mod",
  },
  kind: "worker",
  surface: "service",
  provider: "cloudflare",
  category: "x",
  tags: [],
  suggestedName: "my-app",
  name: { ja: "", en: "App" },
  description: { ja: "", en: "" },
  badge: { ja: "", en: "" },
  createdAt: "",
  updatedAt: "",
};

describe("install-link", () => {
  test("builds an /install URL the real parser accepts and round-trips", () => {
    const url = buildInstallUrl("https://takos.example.com/", listing);
    expect(new URL(url).pathname).toBe("/install");
    const prefill = parseInstallPrefill(url);
    expect(prefill).toBeDefined();
    expect(prefill!.git).toBe("https://github.com/o/r.git");
    expect(prefill!.ref).toBe("");
    expect(prefill!.path).toBe("mod");
    expect(prefill!.name).toBe("my-app");
  });

  test("does not put setup defaults into the store handoff URL", () => {
    const url = buildInstallUrl("https://takos.example.com", listing);
    expect(
      [...new URL(url).searchParams.keys()].some((k) => k.startsWith("var.")),
    ).toBe(false);
    expect(parseInstallPrefill(url)!.vars).toEqual({});
  });

  test("name is capped at 96 chars", () => {
    const long = { ...listing, suggestedName: "a".repeat(200) };
    const prefill = parseInstallPrefill(
      buildInstallUrl("https://takos.example.com", long),
    )!;
    expect(prefill.name!.length).toBe(96);
  });
});
