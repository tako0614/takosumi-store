import { afterEach, describe, expect, test } from "bun:test";
import {
  applyThemeToDocument,
  readSavedTheme,
  resolveTheme,
  saveTheme,
  systemPrefersLight,
  THEME_COLOR,
  THEME_STORAGE_KEY,
} from "../web/src/lib/theme.ts";
import { renderMarkdown } from "../web/src/lib/markdown.ts";
import {
  fetchAccountConfig,
  fetchMe,
  logout,
  setHandle,
} from "../web/src/lib/account-client.ts";
import { t, type StringKey } from "../web/src/lib/i18n.ts";

describe("theme preference resolution and DOM synchronization", () => {
  test("reads/saves only valid theme values and tolerates storage failures", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    expect(readSavedTheme(storage)).toBeNull();
    map.set(THEME_STORAGE_KEY, "sepia");
    expect(readSavedTheme(storage)).toBeNull();

    saveTheme("light", storage);
    expect(readSavedTheme(storage)).toBe("light");
    saveTheme("dark", storage);
    expect(readSavedTheme(storage)).toBe("dark");

    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readSavedTheme(throwing)).toBeNull();
    expect(() => saveTheme("light", throwing)).not.toThrow();
  });

  test("falls back to system prefers-color-scheme when no override is saved", () => {
    expect(resolveTheme(null, false)).toBe("dark");
    expect(resolveTheme(null, true)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");

    expect(
      systemPrefersLight({
        matchMedia: ((q: string) => ({
          matches: q.includes("light"),
        })) as unknown as Window["matchMedia"],
      }),
    ).toBe(true);
    expect(systemPrefersLight(null)).toBe(false);
  });

  test("applies data-theme and synchronizes theme-color meta tags", () => {
    const attrs = new Map<string, string>();
    const makeMeta = (media: string, content: string) => {
      const m = new Map<string, string>([
        ["media", media],
        ["content", content],
      ]);
      return {
        getAttribute: (name: string) => m.get(name) ?? null,
        setAttribute: (name: string, value: string) => {
          m.set(name, value);
        },
        value: () => m.get("content"),
      };
    };
    const darkMeta = makeMeta("(prefers-color-scheme: dark)", THEME_COLOR.dark);
    const lightMeta = makeMeta(
      "(prefers-color-scheme: light)",
      THEME_COLOR.light,
    );
    const fakeDoc = {
      documentElement: {
        dataset: new Proxy(
          {},
          {
            set: (_t, prop, val) => {
              attrs.set(String(prop), String(val));
              return true;
            },
            deleteProperty: (_t, prop) => {
              attrs.delete(String(prop));
              return true;
            },
          },
        ),
      },
      querySelectorAll: () => [darkMeta, lightMeta],
    } as unknown as Document;

    applyThemeToDocument("light", "light", fakeDoc);
    expect(attrs.get("theme")).toBe("light");
    expect(darkMeta.value()).toBe(THEME_COLOR.light);
    expect(lightMeta.value()).toBe(THEME_COLOR.light);

    applyThemeToDocument("dark", "dark", fakeDoc);
    expect(attrs.get("theme")).toBe("dark");
    expect(darkMeta.value()).toBe(THEME_COLOR.dark);
    expect(lightMeta.value()).toBe(THEME_COLOR.dark);

    // Clearing override restores media-specific theme colors.
    applyThemeToDocument(null, "dark", fakeDoc);
    expect(attrs.has("theme")).toBe(false);
    expect(darkMeta.value()).toBe(THEME_COLOR.dark);
    expect(lightMeta.value()).toBe(THEME_COLOR.light);
  });
});

describe("markdown localized task-list status labels", () => {
  test("localizes sr-only task completion text for Japanese while defaulting to English", () => {
    const md = "- [x] Done\n- [ ] Todo";
    const en = renderMarkdown(md);
    expect(en).toContain('<span class="sr-only">Completed: </span>');
    expect(en).toContain('<span class="sr-only">Not completed: </span>');

    const ja = renderMarkdown(md, undefined, { locale: "ja" });
    expect(ja).toContain('<span class="sr-only">完了: </span>');
    expect(ja).toContain('<span class="sr-only">未完了: </span>');
  });
});

describe("account-client network resilience", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("degrades gracefully instead of rejecting on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;

    expect(await fetchAccountConfig()).toEqual({
      oidc: false,
      providerName: "Takosumi Accounts",
    });
    expect(await fetchMe()).toBeNull();
    expect(await logout()).toBe(false);
    expect(await setHandle("alice")).toEqual({
      ok: false,
      message: "Network error",
    });
  });
});

describe("wave 4 copy", () => {
  test("all new user-facing strings exist in both ja and en", () => {
    const keys: StringKey[] = [
      "switchToLight",
      "switchToDark",
      "allApps",
      "loadMoreMatches",
      "partialResultsHint",
      "loadMoreFailed",
      "unpublishing",
      "republishing",
      "deleting",
      "editNotFoundTitle",
      "editNotFoundHint",
      "backToManage",
      "tagsLimitReached",
    ];
    for (const key of keys) {
      expect(t(key, "ja").trim()).not.toBe("");
      expect(t(key, "en").trim()).not.toBe("");
    }
  });
});
