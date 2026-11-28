import { afterEach, describe, expect, test } from "bun:test";
import {
  createNavTracker,
  createRouteAnnouncer,
  focusMainAfterNavigation,
} from "../web/src/lib/nav-history.ts";
import { listMine } from "../web/src/lib/publish-client.ts";
import { t, type StringKey } from "../web/src/lib/i18n.ts";

describe("nav tracker (Back link history awareness)", () => {
  test("back-to-entry stops at depth 0 so BackLink never leaves the store", () => {
    // Deep link to /takos -> push /takos/yurucommu -> pop back to /takos.
    const nav = createNavTracker("/takos");
    expect(nav.canGoBack()).toBe(false);
    expect(nav.backDelta()).toBe(0);
    expect(nav.previousPathname()).toBeNull();

    nav.onBeforeLeave({ to: "/takos/yurucommu", options: { replace: false } });
    expect(nav.canGoBack()).toBe(true);
    expect(nav.backDelta()).toBe(-1);
    expect(nav.previousPathname()).toBe("/takos");

    // Browser Back / BackLink history.back() reports delta -1.
    nav.onBeforeLeave({ to: -1 });
    expect(nav.canGoBack()).toBe(false);
    expect(nav.backDelta()).toBe(0);
    expect(nav.previousPathname()).toBeNull();

    // Extra negative deltas clamp at 0.
    nav.onBeforeLeave({ to: -2 });
    expect(nav.canGoBack()).toBe(false);
    expect(nav.backDelta()).toBe(0);
  });

  test("same-pathname hash push + pop keeps the next forward push intact", () => {
    // /?q=yuru -> #main -> browser Back -> /takos/yurucommu -> BackLink keeps ?q=yuru.
    const nav = createNavTracker("/?q=yuru");
    nav.onBeforeLeave({ to: "/?q=yuru#main", options: { replace: false } });
    // Still on the entry pathname, so BackLink does not pop to the same page.
    expect(nav.canGoBack()).toBe(false);
    expect(nav.backDelta()).toBe(0);

    // Browser Back pops the #main entry cleanly.
    nav.onBeforeLeave({ to: -1 });
    expect(nav.canGoBack()).toBe(false);

    // Navigating forward to detail pushes above /?q=yuru (no stale pop flag).
    nav.onBeforeLeave({ to: "/takos/yurucommu", options: { replace: false } });
    expect(nav.canGoBack()).toBe(true);
    expect(nav.backDelta()).toBe(-1);
    expect(nav.previousPathname()).toBe("/");
  });

  test("skip-link / in-page hash jump skips over same-page entries on backDelta", () => {
    const nav = createNavTracker("/");
    nav.onBeforeLeave({ to: "/takos/yurucommu", options: { replace: false } });
    nav.onBeforeLeave({
      to: "/takos/yurucommu#main",
      options: { replace: false },
    });
    expect(nav.canGoBack()).toBe(true);
    expect(nav.backDelta()).toBe(-2);
    expect(nav.previousPathname()).toBe("/");

    nav.onBeforeLeave({ to: -2 });
    expect(nav.canGoBack()).toBe(false);
  });

  test("replace navigation from depth 0 never inflates depth (direct / OIDC publish)", () => {
    const nav = createNavTracker("/publish");
    expect(nav.canGoBack()).toBe(false);

    // PublishPage redirects with { replace: true } after creating a listing.
    nav.onBeforeLeave({ to: "/takos/new-app", options: { replace: true } });
    expect(nav.canGoBack()).toBe(false);
    expect(nav.backDelta()).toBe(0);

    // Catalog query filter updates also use replace and must not inflate depth.
    nav.reset("/");
    nav.onBeforeLeave({ to: "/?q=hello", options: { replace: true } });
    expect(nav.canGoBack()).toBe(false);
  });

  test("edit from /manage recognizes previousPathname === /manage and avoids duplicate entries", () => {
    const nav = createNavTracker("/");
    nav.onBeforeLeave({ to: "/manage", options: { replace: false } });
    nav.onBeforeLeave({
      to: "/publish?edit=takos/yurucommu",
      options: { replace: false },
    });
    expect(nav.previousPathname()).toBe("/manage");
    expect(nav.backDelta()).toBe(-1);

    // Saving pops back to /manage instead of pushing/replacing a duplicate.
    nav.onBeforeLeave({ to: -1 });
    expect(nav.canGoBack()).toBe(true);
    expect(nav.previousPathname()).toBe("/");
    expect(nav.backDelta()).toBe(-1);

    // Clicking BackLink once on /manage returns directly to /.
    nav.onBeforeLeave({ to: -1 });
    expect(nav.canGoBack()).toBe(false);
  });

  test("ignores prevented leaves and supports forward pops back into recorded history", () => {
    const nav = createNavTracker("/");
    nav.onBeforeLeave({
      to: "/takos",
      options: { replace: false },
      defaultPrevented: true,
    });
    expect(nav.canGoBack()).toBe(false);

    nav.onBeforeLeave({ to: "/takos", options: { replace: false } });
    nav.onBeforeLeave({ to: -1 });
    expect(nav.canGoBack()).toBe(false);

    nav.onBeforeLeave({ to: 1 });
    expect(nav.canGoBack()).toBe(true);
    expect(nav.previousPathname()).toBe("/");
  });
});

describe("route title announcer", () => {
  test("does not announce on initial load or while a route title is still pending", () => {
    const announcer = createRouteAnnouncer();
    const seen: string[] = [];
    announcer.subscribe((msg) => seen.push(msg));

    // Initial load reports title without beginNavigation() -> silent.
    announcer.reportTitle("Takosumi Store");
    expect(seen).toEqual([]);

    // Navigate to an uncached detail page -> clears, waits through pending state,
    // then announces the resolved title once ready.
    announcer.beginNavigation();
    announcer.reportTitle("Takosumi Store", true);
    expect(seen).toEqual([""]);

    announcer.reportTitle("Yurucommu — Takosumi Store", false);
    expect(seen).toEqual(["", "Yurucommu — Takosumi Store"]);

    // Subsequent language toggle on the same route does not re-announce.
    announcer.reportTitle("Yurucommu — Takosumi ストア", false);
    expect(seen).toEqual(["", "Yurucommu — Takosumi Store"]);
  });

  test("announces lazy routes whenever they finish mounting", () => {
    const announcer = createRouteAnnouncer();
    const seen: string[] = [];
    const unsubscribe = announcer.subscribe((msg) => seen.push(msg));

    announcer.beginNavigation();
    expect(seen).toEqual([""]);
    // Lazy chunk resolves later and reports its title.
    announcer.reportTitle("My listings — Takosumi Store");
    expect(seen).toEqual(["", "My listings — Takosumi Store"]);

    unsubscribe();
    announcer.beginNavigation();
    announcer.reportTitle("Takosumi Store");
    expect(seen).toEqual(["", "My listings — Takosumi Store"]);
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
