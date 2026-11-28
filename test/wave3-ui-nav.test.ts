import { afterEach, describe, expect, test } from "bun:test";
import {
  createNavTracker,
  focusMainAfterNavigation,
} from "../web/src/lib/nav-history.ts";
import { listMine } from "../web/src/lib/publish-client.ts";
import { t, type StringKey } from "../web/src/lib/i18n.ts";

describe("nav tracker (Back link history awareness)", () => {
  test("only reports an in-app previous entry after a push navigation", () => {
    const nav = createNavTracker();
    expect(nav.canGoBack()).toBe(false); // deep link / first load
    nav.onRouteChange(false); // home -> detail (push)
    expect(nav.canGoBack()).toBe(true);
    nav.onRouteChange(false); // detail -> scope (push)
    nav.onRouteChange(true); // browser back
    expect(nav.canGoBack()).toBe(true);
    nav.onRouteChange(true); // back to the entry page
    expect(nav.canGoBack()).toBe(false);
    nav.onRouteChange(true); // forward-pop never goes negative
    expect(nav.canGoBack()).toBe(false);
  });
});

type Frame = () => void;

class FakeNode {
  focused = 0;
  constructor(
    private readonly doc: FakeDoc,
    readonly children: FakeNode[] = [],
  ) {}
  focus(opts?: { preventScroll?: boolean }): void {
    this.focused += 1;
    this.lastPreventScroll = opts?.preventScroll;
    this.doc.activeElement = this;
  }
  lastPreventScroll: boolean | undefined;
  contains(other: unknown): boolean {
    return other === this || this.children.some((c) => c.contains(other));
  }
}

class FakeDoc {
  body: FakeNode;
  main: FakeNode | null = null;
  activeElement: FakeNode | null;
  constructor() {
    this.body = new FakeNode(this);
    this.activeElement = this.body;
  }
  getElementById(id: string): FakeNode | null {
    return id === "main" ? this.main : null;
  }
}

const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
let frames: Frame[] = [];
function installRaf(): void {
  frames = [];
  globalThis.requestAnimationFrame = ((cb: Frame) => {
    frames.push(cb);
    return frames.length;
  }) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    frames = [];
  }) as unknown as typeof cancelAnimationFrame;
}
function runFrames(n: number): void {
  for (let i = 0; i < n && frames.length; i++) frames.shift()!();
}

afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
});

describe("focusMainAfterNavigation", () => {
  test("waits for a lazily mounted <main>, focuses it without scrolling", () => {
    installRaf();
    const doc = new FakeDoc();
    focusMainAfterNavigation(doc as unknown as Document, 10);
    runFrames(3); // route chunk still loading
    expect(doc.activeElement).toBe(doc.body);
    doc.main = new FakeNode(doc);
    runFrames(1);
    expect(doc.activeElement).toBe(doc.main);
    expect(doc.main.lastPreventScroll).toBe(true);
  });

  test("re-focuses when a replaced <main> drops focus to <body>, but never steals a field focus", () => {
    installRaf();
    const doc = new FakeDoc();
    const field = new FakeNode(doc);
    doc.main = new FakeNode(doc);
    focusMainAfterNavigation(doc as unknown as Document, 10);
    runFrames(1);
    expect(doc.activeElement).toBe(doc.main);
    // The old main is swapped out (lazy route resolved) → focus lost.
    doc.main = new FakeNode(doc, [field]);
    doc.activeElement = doc.body;
    runFrames(1);
    expect(doc.activeElement).toBe(doc.main);
    // The page focuses its own field; the helper must leave it alone.
    field.focus();
    runFrames(5);
    expect(doc.activeElement).toBe(field);
  });

  test("cancel stops further focusing", () => {
    installRaf();
    const doc = new FakeDoc();
    const cancel = focusMainAfterNavigation(doc as unknown as Document, 10);
    cancel();
    doc.main = new FakeNode(doc);
    runFrames(5);
    expect(doc.activeElement).toBe(doc.body);
  });
});

describe("listMine error surfacing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const respond = (status: number, body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  };

  test("signed-out (401) is an empty list", async () => {
    respond(401, {});
    expect(await listMine()).toEqual([]);
  });

  test("server failures throw instead of pretending nothing is shared", async () => {
    respond(500, { error: { message: "boom" } });
    await expect(listMine()).rejects.toThrow("500");
  });

  test("returns the owner's listings on success", async () => {
    respond(200, { listings: [{ id: "a/b", status: "visible" }] });
    expect(await listMine()).toEqual([
      { id: "a/b", status: "visible" },
    ] as never);
  });
});

describe("wave 3 copy", () => {
  test("new user-facing strings exist in both locales", () => {
    const keys: StringKey[] = [
      "switchLanguage",
      "switchLanguageLabel",
      "notFoundTitle",
      "notFoundHint",
      "listingNotFoundTitle",
      "listingNotFoundHint",
      "browseCatalog",
      "emptyCatalogTitle",
      "emptyCatalogHint",
      "signInToPublish",
      "signInToManage",
      "readOnlyPublish",
      "readOnly",
    ];
    for (const key of keys) {
      expect(t(key, "ja").trim()).not.toBe("");
      expect(t(key, "en").trim()).not.toBe("");
    }
    // The switcher names the *target* language, and its accessible name
    // contains that visible text (WCAG 2.5.3 label-in-name).
    expect(t("switchLanguage", "ja")).toBe("English");
    expect(t("switchLanguage", "en")).toBe("日本語");
    expect(t("switchLanguageLabel", "ja")).toContain("English");
    expect(t("switchLanguageLabel", "en")).toContain("日本語");
  });
});
