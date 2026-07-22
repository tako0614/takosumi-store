import { describe, expect, test } from "bun:test";
import { validatePublishInput } from "../src/backend/lib/listing-validate.ts";

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
        "inputs belongs in the repository .well-known/tcs.json",
      );
      expect(r.errors.join("\n")).toContain(
        "installExperience belongs in the repository .well-known/tcs.json",
      );
      expect(r.errors.join("\n")).toContain(
        "outputAllowlist belongs in the repository .well-known/tcs.json",
      );
    }
  });
});
