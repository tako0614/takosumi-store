export const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not(:disabled):not([hidden]):not([tabindex="-1"])',
  'input:not(:disabled):not([hidden]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not(:disabled):not([hidden]):not([tabindex="-1"])',
  'textarea:not(:disabled):not([hidden]):not([tabindex="-1"])',
  'details > summary:first-of-type:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"]):not(:disabled)',
].join(", ");

const inertCounts = new WeakMap<HTMLElement, number>();

export function acquireInert(el: HTMLElement | null): void {
  if (!el) return;
  const count = inertCounts.get(el) ?? 0;
  if (count === 0 && el.inert) return;
  inertCounts.set(el, count + 1);
  el.inert = true;
}

export function releaseInert(el: HTMLElement | null): void {
  if (!el) return;
  const count = inertCounts.get(el);
  if (count === undefined) return;
  if (count <= 1) {
    inertCounts.delete(el);
    el.inert = false;
  } else {
    inertCounts.set(el, count - 1);
  }
}

export function isFocusableVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (
    typeof el.closest === "function" &&
    el.closest("[inert], [hidden], details:not([open]) > :not(summary)")
  ) {
    return false;
  }
  if (
    typeof getComputedStyle === "function" &&
    getComputedStyle(el).visibility === "hidden"
  ) {
    return false;
  }
  return (
    typeof el.getClientRects !== "function" || el.getClientRects().length > 0
  );
}

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isFocusableVisible);
}

export function restoreDialogFocus(
  opener: HTMLElement | null,
  doc: Document = document,
): void {
  if (opener && opener.isConnected && typeof opener.focus === "function") {
    opener.focus();
    return;
  }
  const main = doc.getElementById("main");
  if (main && typeof main.focus === "function") {
    main.focus();
  }
}

export function handleConfirmDialogKeyDown(
  e: KeyboardEvent,
  dialogRef: HTMLElement | undefined,
  options: { readonly busy?: boolean; readonly onCancel: () => void },
  doc: Document = document,
): void {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") {
    if (!options.busy) {
      e.preventDefault();
      options.onCancel();
    }
    return;
  }
  if (e.key === "Tab" && dialogRef) {
    const focusable = focusableElements(dialogRef);
    if (focusable.length === 0) {
      e.preventDefault();
      dialogRef.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = doc.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (
        !active ||
        !dialogRef.contains(active) ||
        active === dialogRef ||
        active === first
      ) {
        e.preventDefault();
        last.focus();
      }
    } else if (!active || !dialogRef.contains(active) || active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
