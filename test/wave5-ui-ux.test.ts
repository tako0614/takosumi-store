import { describe, expect, test } from "bun:test";
import {
  clearSavedTheme,
  readSavedTheme,
  saveTheme,
  THEME_STORAGE_KEY,
  themePreferenceFromOverride,
} from "../web/src/lib/theme.ts";
import {
  draftFromLocalized,
  emptyLocalizedDraft,
  primaryText,
  resolveLocalized,
  secondaryText,
  setPrimaryText,
  setSecondaryText,
} from "../web/src/lib/publish-localized.ts";
import {
  deriveAutoSlug,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  slugify,
  validateDescriptionLength,
  validateNameLength,
} from "../web/src/lib/publish-validation.ts";
import { renderMarkdown } from "../web/src/lib/markdown.ts";
import { t, type StringKey } from "../web/src/lib/i18n.ts";

describe("theme System / Auto reset support", () => {
  test("clearSavedTheme removes saved override and tolerates storage errors", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };

    saveTheme("light", storage);
    expect(readSavedTheme(storage)).toBe("light");
    expect(map.has(THEME_STORAGE_KEY)).toBe(true);

    clearSavedTheme(storage);
    expect(readSavedTheme(storage)).toBeNull();
    expect(map.has(THEME_STORAGE_KEY)).toBe(false);

    const throwing = {
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => clearSavedTheme(throwing)).not.toThrow();
  });

  test("themePreferenceFromOverride maps null to system and preserves light/dark", () => {
    expect(themePreferenceFromOverride(null)).toBe("system");
    expect(themePreferenceFromOverride("light")).toBe("light");
    expect(themePreferenceFromOverride("dark")).toBe("dark");
  });
});

describe("PublishPage bilingual localized draft helpers", () => {
  test("single-language quick publish stays synced across UI locale switches", () => {
    let draft = emptyLocalizedDraft();
    draft = setPrimaryText(draft, "ja", "マイアプリ");
    expect(draft.split).toBe(false);
    expect(primaryText(draft, "ja")).toBe("マイアプリ");
    expect(primaryText(draft, "en")).toBe("マイアプリ");
    expect(secondaryText(draft, "ja")).toBe("");
    expect(secondaryText(draft, "en")).toBe("");
    expect(resolveLocalized(draft, "fallback")).toEqual({
      ja: "マイアプリ",
      en: "マイアプリ",
    });
  });

  test("bilingual entry keeps ja and en independent across edits and locale flips", () => {
    let draft = setPrimaryText(emptyLocalizedDraft(), "ja", "ゆるこみゅ");
    draft = setSecondaryText(draft, "ja", "Yurucommu");
    expect(draft.split).toBe(true);
    expect(primaryText(draft, "ja")).toBe("ゆるこみゅ");
    expect(secondaryText(draft, "ja")).toBe("Yurucommu");
    // Flipping UI locale swaps primary/secondary views without losing text.
    expect(primaryText(draft, "en")).toBe("Yurucommu");
    expect(secondaryText(draft, "en")).toBe("ゆるこみゅ");
    expect(resolveLocalized(draft, "repo")).toEqual({
      ja: "ゆるこみゅ",
      en: "Yurucommu",
    });

    // Editing English only leaves Japanese intact.
    draft = setPrimaryText(draft, "en", "Yurucommu Social");
    expect(resolveLocalized(draft, "repo")).toEqual({
      ja: "ゆるこみゅ",
      en: "Yurucommu Social",
    });

    // Clearing the secondary field collapses back to synced single-language mode.
    draft = setSecondaryText(draft, "en", "");
    expect(draft.split).toBe(false);
    expect(resolveLocalized(draft, "repo")).toEqual({
      ja: "Yurucommu Social",
      en: "Yurucommu Social",
    });
  });

  test("editing an existing bilingual listing preserves both locales losslessly", () => {
    const existing = draftFromLocalized({
      ja: "自分専用の AI ワークスペース。",
      en: "Your own AI workspace.",
    });
    expect(existing.split).toBe(true);
    expect(resolveLocalized(existing)).toEqual({
      ja: "自分専用の AI ワークスペース。",
      en: "Your own AI workspace.",
    });

    // Single-language existing listing stays synced so primary edits update both.
    const single = draftFromLocalized({ ja: "MyApp", en: "MyApp" });
    expect(single.split).toBe(false);
    const renamed = setPrimaryText(single, "en", "MyApp v2");
    expect(resolveLocalized(renamed)).toEqual({
      ja: "MyApp v2",
      en: "MyApp v2",
    });
  });

  test("falls back cleanly to repo name when both localized names are blank", () => {
    expect(resolveLocalized(emptyLocalizedDraft(), "takos-git")).toEqual({
      ja: "takos-git",
      en: "takos-git",
    });
  });
});

describe("PublishPage slug derivation and text length validation", () => {
  test("deriveAutoSlug handles pure non-ASCII names by falling back to English name or Git repo name", () => {
    expect(
      deriveAutoSlug(
        { ja: "にほんごアプリ", en: "にほんごアプリ" },
        "https://github.com/tako0614/nihongo-app.git",
      ),
    ).toBe("nihongo-app");

    expect(
      deriveAutoSlug(
        { ja: "ゆるこみゅ", en: "Yurucommu" },
        "https://github.com/tako0614/repo-xyz.git",
      ),
    ).toBe("yurucommu");

    expect(
      deriveAutoSlug(
        { ja: "にほんごアプリ", en: "にほんごアプリ" },
        "https://github.com/tako0614/アプリ.git",
      ),
    ).toBe("");

    expect(slugify("  My Cool_App!!  ")).toBe("my-cool-app");
  });

  test("validates name and description maximum lengths matching backend bounds", () => {
    expect(validateNameLength("a".repeat(MAX_NAME_LENGTH))).toBeNull();
    expect(validateNameLength("a".repeat(MAX_NAME_LENGTH + 1))).toBe(
      "too_long",
    );
    expect(
      validateDescriptionLength("b".repeat(MAX_DESCRIPTION_LENGTH)),
    ).toBeNull();
    expect(
      validateDescriptionLength("b".repeat(MAX_DESCRIPTION_LENGTH + 1)),
    ).toBe("too_long");
  });
});

describe("markdown fenced code block language annotation", () => {
  test("preserves safe language identifiers as data-lang and rejects unsafe info strings", () => {
    const bash = renderMarkdown("```bash\necho hi\n```");
    expect(bash).toContain('<pre class="md-code" data-lang="bash"><code>');

    const cpp = renderMarkdown("```C++ title=ignored\nint main() {}\n```");
    expect(cpp).toContain('<pre class="md-code" data-lang="c++"><code>');

    const plain = renderMarkdown("```\nplain\n```");
    expect(plain).toContain('<pre class="md-code"><code>');
    expect(plain).not.toContain("data-lang=");

    const xss = renderMarkdown('```"><script>alert(1)</script>\ncode\n```');
    expect(xss).toContain('<pre class="md-code"><code>');
    expect(xss).not.toContain("data-lang=");
    expect(xss).not.toContain("<script>");
  });
});

describe("wave 5 copy", () => {
  test("all new strings exist in ja and en and copyGitUrl preserves label-in-name", () => {
    const keys: StringKey[] = [
      "copyGitUrl",
      "slugRequiredAscii",
      "nameTooLong",
      "descriptionTooLong",
      "bilingualHeading",
      "bilingualHint",
      "altNameField",
      "altDescriptionField",
      "themeLabel",
      "themeMenuLabel",
      "themeSystem",
      "themeLight",
      "themeDark",
    ];
    for (const key of keys) {
      expect(t(key, "ja").trim()).not.toBe("");
      expect(t(key, "en").trim()).not.toBe("");
    }
    expect(t("copyGitUrl", "en")).toContain(t("copyCode", "en"));
    expect(t("copyGitUrl", "ja")).toContain(t("copyCode", "ja"));
  });
});
