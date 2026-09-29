import { describe, expect, test } from "bun:test";
import {
  validatePublishInput,
  validatePublishInputV2,
} from "../src/backend/lib/listing-validate.ts";

function validBody(over: Record<string, unknown> = {}) {
  return {
    source: { git: "https://github.com/o/r.git", path: "mod" },
    kind: "worker",
    surface: "service",
    provider: "cloudflare",
    category: "social",
    suggestedName: "my-app",
    name: { ja: "アプリ", en: "App" },
    description: { ja: "", en: "An app" },
    badge: { ja: "", en: "App" },
    ...over,
  };
}

describe("validatePublishInput", () => {
  test("accepts a valid repository-discovery listing with no warnings", () => {
    const r = validatePublishInput(validBody());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toEqual([]);
      expect(r.value.source.path).toBe("mod");
    }
  });

  test("canonicalizes every root spelling to dot and preserves path case", () => {
    for (const path of ["", ".", "./"]) {
      const result = validatePublishInput(
        validBody({
          source: { git: "https://github.com/o/r.git", path },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.source.path).toBe(".");
    }

    const nested = validatePublishInput(
      validBody({
        source: {
          git: "https://github.com/o/r.git",
          path: "./Modules/OpenTofu/",
        },
      }),
    );
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.value.source.path).toBe("Modules/OpenTofu");
    }
  });

  test("rejects source version fields", () => {
    const r = validatePublishInput(
      validBody({
        source: {
          git: "https://github.com/o/r.git",
          ref: "main",
          resolvedCommit: "a".repeat(40),
          commit: "a".repeat(40),
          path: "",
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain("source.ref belongs");
      expect(r.errors.join("\n")).toContain("source.resolvedCommit belongs");
      expect(r.errors.join("\n")).toContain("source.commit belongs");
    }
  });

  test("rejects non-https / private / credentialed git urls", () => {
    for (const git of [
      "http://github.com/o/r.git",
      "https://localhost/o/r.git",
      "https://user:pw@github.com/o/r.git",
      "https://127.0.0.1/o/r.git",
    ]) {
      const r = validatePublishInput(validBody({ source: { git, path: "" } }));
      expect(r.ok).toBe(false);
    }
  });

  test("rejects Git URL query, fragment, and control characters", () => {
    for (const git of [
      "https://github.com/o/r.git?token=secret",
      "https://github.com/o/r.git#main",
      "https://github.com/o/\nr.git",
    ]) {
      const result = validatePublishInput(
        validBody({ source: { git, path: "." } }),
      );
      expect(result.ok).toBe(false);
    }
  });

  test("rejects unknown kind", () => {
    expect(validatePublishInput(validBody({ kind: "banana" })).ok).toBe(false);
  });

  test("normalizes tags and derives category from the first tag", () => {
    const r = validatePublishInput(
      validBody({
        category: undefined,
        tags: ["Social", "Dev Tools", "social"],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tags).toEqual(["social", "dev-tools"]);
      expect(r.value.category).toBe("social");
    }
  });

  test("category falls back to general when neither tags nor category given", () => {
    const r = validatePublishInput(
      validBody({ category: undefined, tags: [] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tags).toEqual([]);
      expect(r.value.category).toBe("general");
    }
  });

  test("rejects missing name", () => {
    expect(
      validatePublishInput(validBody({ name: { ja: "", en: "" } })).ok,
    ).toBe(false);
  });

  test("accepts safe relative icons and degrades unsafe icons to a warning", () => {
    const relative = validatePublishInput(
      validBody({ iconUrl: "public/icons/app.svg" }),
    );
    expect(relative.ok).toBe(true);
    if (relative.ok) {
      expect(relative.value.iconUrl).toBe("public/icons/app.svg");
      expect(relative.warnings).toEqual([]);
    }

    const unsafe = validatePublishInput(
      validBody({ iconUrl: "../private/icon.svg" }),
    );
    expect(unsafe.ok).toBe(true);
    if (unsafe.ok) {
      expect(unsafe.value.iconUrl).toBeUndefined();
      expect(unsafe.warnings).toEqual([
        "iconUrl was unsafe and will be omitted",
      ]);
    }
  });

  test("rejects install metadata in the store listing", () => {
    const r = validatePublishInput(
      validBody({
        inputs: [{ name: "appName", label: { ja: "名前", en: "Name" } }],
        installExperience: {
          projections: [{ kind: "service_name", variable: "project_name" }],
        },
        outputAllowlist: [{ key: "url", from: "url", type: "url" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain(
        "inputs may only be proposed to Takosumi through the installer-owned .well-known/takosumi.json",
      );
      expect(r.errors.join("\n")).toContain(
        "installExperience may only be proposed to Takosumi through the installer-owned .well-known/takosumi.json",
      );
      expect(r.errors.join("\n")).toContain(
        "outputAllowlist is installer policy and cannot be supplied by Store listings or repository metadata",
      );
    }
  });

  test("rejects traversal and encoded traversal in module paths", () => {
    for (const path of [
      "../secret",
      "a/../secret",
      "a/%2e%2e/secret",
      "a\\b",
    ]) {
      const result = validatePublishInput(
        validBody({
          source: { git: "https://github.com/o/r.git", path },
        }),
      );
      expect(result.ok).toBe(false);
    }
  });
});

describe("validatePublishInputV2", () => {
  function v2Body(over: Record<string, unknown> = {}) {
    return {
      source: { git: "https://github.com/o/r.git" },
      category: "social",
      suggestedName: "my-app",
      name: { ja: "アプリ", en: "App" },
      description: { ja: "", en: "An app" },
      badge: { ja: "", en: "App" },
      ...over,
    };
  }

  test("keeps the module the listing reviewed", () => {
    const r = validatePublishInputV2(
      v2Body({
        source: {
          git: "https://github.com/o/r.git",
          path: "deploy/takoform/",
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toEqual({
        git: "https://github.com/o/r",
        path: "deploy/takoform",
      });
    }
  });

  test("leaves a root-reviewed listing URL-only", () => {
    for (const path of [undefined, "", ".", "./"]) {
      const r = validatePublishInputV2(
        v2Body({
          source: {
            git: "https://github.com/o/r.git",
            ...(path === undefined ? {} : { path }),
          },
        }),
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value.source).toEqual({ git: "https://github.com/o/r" });
    }
  });

  test("rejects refs, commits, and non-string module paths", () => {
    for (const source of [
      { git: "https://github.com/o/r.git", ref: "main" },
      { git: "https://github.com/o/r.git", commit: "deadbeef" },
      { git: "https://github.com/o/r.git", resolvedCommit: "deadbeef" },
      { git: "https://github.com/o/r.git", path: 7 },
    ]) {
      const r = validatePublishInputV2(v2Body({ source }));
      expect(r.ok).toBe(false);
    }
  });

  test("rejects a module path that escapes the repository", () => {
    const r = validatePublishInputV2(
      v2Body({ source: { git: "https://github.com/o/r.git", path: "../s" } }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects execution-looking v1 facets", () => {
    for (const field of ["kind", "surface", "provider"]) {
      const r = validatePublishInputV2(v2Body({ [field]: "worker" }));
      expect(r.ok).toBe(false);
    }
  });
});
