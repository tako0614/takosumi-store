import { describe, expect, test } from "bun:test";
import {
  repoNameFromGitUrl,
  validateGitUrl,
  validateHandle,
  validateLogoUrl,
  validateSlug,
} from "../web/src/lib/publish-validation.ts";

describe("publish-validation", () => {
  test("validateGitUrl requires a canonical public HTTPS repository URL without credentials, query, or fragment", () => {
    expect(validateGitUrl("")).toBe("required");
    expect(validateGitUrl("   ")).toBe("required");
    expect(validateGitUrl("not-a-url")).toBe("invalid");
    expect(validateGitUrl("javascript:alert(1)")).toBe("invalid");
    expect(validateGitUrl("http://github.com/example/app.git")).toBe("invalid");
    expect(validateGitUrl("http://localhost:3000/org/app")).toBe("invalid");
    expect(validateGitUrl("https://localhost/org/app")).toBe("invalid");
    expect(validateGitUrl("https://github.com/")).toBe("invalid");
    expect(validateGitUrl("https://user:pass@github.com/org/repo.git")).toBe(
      "invalid",
    );
    expect(
      validateGitUrl("https://github.com/example/app.git?tab=readme"),
    ).toBe("invalid");
    expect(validateGitUrl("https://github.com/example/app#section")).toBe(
      "invalid",
    );
    expect(validateGitUrl("https://github.com/example/takos-storage.git")).toBe(
      null,
    );
  });

  test("validateLogoUrl permits empty or HTTPS URLs without credentials", () => {
    expect(validateLogoUrl("")).toBe(null);
    expect(validateLogoUrl("   ")).toBe(null);
    expect(validateLogoUrl("http://example.com/icon.png")).toBe("invalid");
    expect(validateLogoUrl("javascript:alert(1)")).toBe("invalid");
    expect(validateLogoUrl("https://user:pass@example.com/icon.png")).toBe(
      "invalid",
    );
    expect(validateLogoUrl("https://cdn.example.com/icon.png")).toBe(null);
  });

  test("validateSlug allows blank or valid lowercase slug", () => {
    expect(validateSlug("")).toBe(null);
    expect(validateSlug("my-app-1")).toBe(null);
    expect(validateSlug("a")).toBe(null);
    expect(validateSlug("Bad_Slug")).toBe("invalid");
    expect(validateSlug("-leading")).toBe("invalid");
    expect(validateSlug("trailing-")).toBe("invalid");
    expect(validateSlug("a".repeat(49))).toBe("invalid");
  });

  test("validateHandle mirrors the backend publisher handle grammar (2–32 chars, letters/digits/-/_)", () => {
    expect(validateHandle("")).toBe("required");
    expect(validateHandle("a")).toBe("invalid");
    expect(validateHandle("-bad")).toBe("invalid");
    expect(validateHandle("takos-team")).toBe(null);
    expect(validateHandle("tako_dev")).toBe(null);
    expect(validateHandle("ab")).toBe(null);
    expect(validateHandle("bad handle!")).toBe("invalid");
    expect(validateHandle("a".repeat(33))).toBe("invalid");
  });

  test("repoNameFromGitUrl extracts repository segment cleanly", () => {
    expect(repoNameFromGitUrl("https://github.com/org/my-app.git")).toBe(
      "my-app",
    );
    expect(repoNameFromGitUrl("https://github.com/org/my-app/")).toBe("my-app");
    expect(repoNameFromGitUrl("not-a-url")).toBe("");
  });
});
