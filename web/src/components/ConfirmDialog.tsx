import { createEffect, onCleanup, Show, type Component } from "solid-js";
import { Portal } from "solid-js/web";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled]):not([hidden])",
  "input:not([disabled]):not([hidden])",
  "select:not([disabled]):not([hidden])",
  "textarea:not([disabled]):not([hidden])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Accessible in-app confirmation modal replacing native `window.confirm()`.
 * Traps Tab/Shift+Tab, ignores IME composition on Escape, defaults focus to
 * Cancel for destructive actions, and restores focus to the trigger on close.
 */
export const ConfirmDialog: Component<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => {
  let dialogRef: HTMLDivElement | undefined;
  let cancelBtnRef: HTMLButtonElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    const opener = document.activeElement as HTMLElement | null;
    const appRoot = document.querySelector(".app") as HTMLElement | null;
    if (appRoot) appRoot.inert = true;

    queueMicrotask(() => {
      cancelBtnRef?.focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        if (!props.busy) {
          e.preventDefault();
          props.onCancel();
        }
        return;
      }
      if (e.key === "Tab" && dialogRef) {
        const focusable = Array.from(
          dialogRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (focusable.length === 0) {
          e.preventDefault();
          dialogRef.focus();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (!active || !dialogRef.contains(active) || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else if (!active || !dialogRef.contains(active) || active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      if (appRoot) appRoot.inert = false;
      if (opener && opener.isConnected && typeof opener.focus === "function") {
        opener.focus();
      }
    });
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="confirm-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !props.busy) props.onCancel();
          }}
        >
          <div
            ref={dialogRef}
            class="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-desc"
            tabIndex={-1}
          >
            <h2 id="confirm-dialog-title" class="confirm-dialog-title">
              {props.title}
            </h2>
            <p id="confirm-dialog-desc" class="confirm-dialog-desc muted">
              {props.message}
            </p>
            <div class="confirm-dialog-actions">
              <button
                ref={cancelBtnRef}
                type="button"
                class="btn btn-secondary"
                disabled={props.busy}
                onClick={props.onCancel}
              >
                {props.cancelLabel}
              </button>
              <button
                type="button"
                class="btn btn-primary"
                classList={{ "btn-confirm-danger": props.danger }}
                disabled={props.busy}
                onClick={props.onConfirm}
              >
                {props.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};
