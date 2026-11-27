import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireInert,
  FOCUSABLE_SELECTOR,
  focusableElements,
  handleConfirmDialogKeyDown,
  releaseInert,
  restoreDialogFocus,
} from "../web/src/lib/confirm-dialog-a11y.ts";
import {
  createListing,
  deleteListing,
  setVisibility,
  updateListing,
} from "../web/src/lib/publish-client.ts";

class FakeEl {
  readonly attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  isConnected = true;
  visible = true;
  visibility = "visible";
  inert = false;
  hidden = false;
  disabled = false;
  tag: string;

  constructor(
    tag: string,
    private readonly doc: FakeDoc,
    attrs: Record<string, string> = {},
  ) {
    this.tag = tag.toLowerCase();
    for (const [k, v] of Object.entries(attrs)) {
      this.attrs.set(k, v);
      if (k === "disabled") this.disabled = true;
      if (k === "hidden") this.hidden = true;
      if (k === "inert") this.inert = true;
    }
  }

  append(...nodes: FakeEl[]): void {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  focus(): void {
    this.doc.activeElement = this;
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }

  getClientRects(): readonly object[] {
    return this.visible ? [{}] : [];
  }

  closest(selector: string): FakeEl | null {
    let cur: FakeEl | null = this;
    while (cur) {
      if (selector.includes("[inert]") && cur.inert) return cur;
      if (selector.includes("[hidden]") && cur.hidden) return cur;
      if (
        selector.includes("details:not([open]) > :not(summary)") &&
        cur.tag !== "summary" &&
        cur.parent?.tag === "details" &&
        !cur.parent.hasAttribute("open")
      ) {
        return cur;
      }
      cur = cur.parent;
    }
    return null;
  }

  private matchesFocusable(): boolean {
    const tabIndex = this.attrs.get("tabindex");
    if (tabIndex === "-1") return false;
    if (this.disabled || this.hidden) return false;
    if (this.tag === "a") return this.attrs.has("href");
    if (["button", "input", "select", "textarea"].includes(this.tag)) {
      return this.attrs.get("type") !== "hidden";
    }
    if (this.tag === "summary") {
      return (
        this.parent?.tag === "details" &&
        this.parent.children.find((c) => c.tag === "summary") === this
      );
    }
    return tabIndex !== undefined;
  }

  private allDescendants(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.allDescendants()]);
  }

  querySelectorAll(_selector: string): FakeEl[] {
    return this.allDescendants().filter((el) => el.matchesFocusable());
  }
}

class FakeDoc {
  activeElement: FakeEl | null = null;
  private readonly byId = new Map<string, FakeEl>();

  register(id: string, el: FakeEl): void {
    this.byId.set(id, el);
  }

  getElementById(id: string): FakeEl | null {
    return this.byId.get(id) ?? null;
  }
}

const origGetComputedStyle = globalThis.getComputedStyle;
const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.getComputedStyle = origGetComputedStyle;
  globalThis.fetch = origFetch;
});

function makeKey(
  key: string,
  extra: Partial<{
    shiftKey: boolean;
    isComposing: boolean;
    keyCode: number;
  }> = {},
): { event: KeyboardEvent; prevented: () => boolean } {
  let didPrevent = false;
  const event = {
    key,
    shiftKey: extra.shiftKey ?? false,
    isComposing: extra.isComposing ?? false,
    keyCode: extra.keyCode ?? 0,
    preventDefault() {
      didPrevent = true;
    },
  } as unknown as KeyboardEvent;
  return { event, prevented: () => didPrevent };
}

describe("ConfirmDialog accessibility & inert ref-counting", () => {
  test("Shift+Tab from dialogRef wraps to last button and Tab wraps cleanly", () => {
    const doc = new FakeDoc();
    const asDoc = doc as unknown as Document;
    globalThis.getComputedStyle = ((el: FakeEl) => ({
      visibility: el.visibility,
    })) as unknown as typeof getComputedStyle;

    const dialog = new FakeEl("div", doc, { tabindex: "-1" });
    const cancel = new FakeEl("button", doc);
    const confirm = new FakeEl("button", doc);
    dialog.append(cancel, confirm);

    let cancels = 0;
    const onCancel = () => {
      cancels += 1;
    };

    // Shift+Tab when dialogRef itself has focus wraps to last button (confirm).
    dialog.focus();
    const shiftFromDialog = makeKey("Tab", { shiftKey: true });
    handleConfirmDialogKeyDown(
      shiftFromDialog.event,
      dialog as unknown as HTMLElement,
      { onCancel },
      asDoc,
    );
    expect(shiftFromDialog.prevented()).toBe(true);
    expect(doc.activeElement).toBe(confirm);

    // Tab from last wraps to first (cancel).
    const tabFromLast = makeKey("Tab");
    handleConfirmDialogKeyDown(
      tabFromLast.event,
      dialog as unknown as HTMLElement,
      { onCancel },
      asDoc,
    );
    expect(tabFromLast.prevented()).toBe(true);
    expect(doc.activeElement).toBe(cancel);

    // Escape ignored while busy or composing, fires when idle.
    handleConfirmDialogKeyDown(
      makeKey("Escape").event,
      dialog as unknown as HTMLElement,
      { busy: true, onCancel },
      asDoc,
    );
    handleConfirmDialogKeyDown(
      makeKey("Escape", { isComposing: true }).event,
      dialog as unknown as HTMLElement,
      { onCancel },
      asDoc,
    );
    handleConfirmDialogKeyDown(
      makeKey("Escape", { keyCode: 229 }).event,
      dialog as unknown as HTMLElement,
      { onCancel },
      asDoc,
    );
    expect(cancels).toBe(0);

    const realEsc = makeKey("Escape");
    handleConfirmDialogKeyDown(
      realEsc.event,
      dialog as unknown as HTMLElement,
      { onCancel },
      asDoc,
    );
    expect(realEsc.prevented()).toBe(true);
    expect(cancels).toBe(1);
  });

  test("focusableElements filters hidden/inert/closed-details, ref-counts inert, and falls back to #main", () => {
    const doc = new FakeDoc();
    const asDoc = doc as unknown as Document;
    globalThis.getComputedStyle = ((el: FakeEl) => ({
      visibility: el.visibility,
    })) as unknown as typeof getComputedStyle;

    const dialog = new FakeEl("div", doc, { tabindex: "-1" });
    const details = new FakeEl("details", doc);
    const summary = new FakeEl("summary", doc);
    const hiddenInside = new FakeEl("button", doc);
    details.append(summary, hiddenInside);
    const invis = new FakeEl("button", doc);
    invis.visibility = "hidden";
    const zeroRect = new FakeEl("button", doc);
    zeroRect.visible = false;
    const disabledCustom = new FakeEl("button", doc, {
      tabindex: "0",
      disabled: "",
    });
    const okBtn = new FakeEl("button", doc);
    dialog.append(details, invis, zeroRect, disabledCustom, okBtn);

    expect(FOCUSABLE_SELECTOR).toContain(":not(:disabled)");
    expect(focusableElements(dialog as unknown as HTMLElement)).toEqual([
      summary as unknown as HTMLElement,
      okBtn as unknown as HTMLElement,
    ]);

    // Ref-counted inert preserves pre-existing inert and handles stacked modals.
    const appRoot = new FakeEl("div", doc);
    acquireInert(appRoot as unknown as HTMLElement);
    acquireInert(appRoot as unknown as HTMLElement);
    expect(appRoot.inert).toBe(true);
    releaseInert(appRoot as unknown as HTMLElement);
    expect(appRoot.inert).toBe(true);
    releaseInert(appRoot as unknown as HTMLElement);
    expect(appRoot.inert).toBe(false);

    const preInert = new FakeEl("div", doc, { inert: "" });
    acquireInert(preInert as unknown as HTMLElement);
    releaseInert(preInert as unknown as HTMLElement);
    expect(preInert.inert).toBe(true);

    // Focus restoration falls back to #main when opener is disconnected.
    const main = new FakeEl("main", doc, { tabindex: "-1" });
    doc.register("main", main);
    const detached = new FakeEl("button", doc);
    detached.isConnected = false;
    restoreDialogFocus(detached as unknown as HTMLElement, asDoc);
    expect(doc.activeElement).toBe(main);

    const liveOpener = new FakeEl("button", doc);
    restoreDialogFocus(liveOpener as unknown as HTMLElement, asDoc);
    expect(doc.activeElement).toBe(liveOpener);
  });
});

describe("publish-client network error handling", () => {
  test("mutations return structured failures instead of rejecting on network errors", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Network down");
    }) as unknown as typeof fetch;

    const sampleBody = {
      source: { git: "https://github.com/example/app.git" },
      suggestedName: "app",
      name: { ja: "App", en: "App" },
      description: { ja: "desc", en: "desc" },
      badge: { ja: "", en: "" },
    };

    expect(await deleteListing("alice/app", true)).toBe(false);
    expect(await setVisibility("alice/app", "hidden")).toBe(false);
    expect(await updateListing("alice/app", sampleBody)).toEqual({
      ok: false,
      status: 0,
      message: "Network error",
    });
    expect(await createListing(sampleBody)).toEqual({
      ok: false,
      status: 0,
      message: "Network error",
    });
  });
});
