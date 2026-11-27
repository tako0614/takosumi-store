import {
  createEffect,
  createUniqueId,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  acquireInert,
  handleConfirmDialogKeyDown,
  releaseInert,
  restoreDialogFocus,
} from "../lib/confirm-dialog-a11y.ts";

/**
 * Accessible in-app confirmation modal replacing native `window.confirm()`.
 * Traps Tab/Shift+Tab, ignores IME composition on Escape, defaults focus to
 * Cancel for destructive actions, ref-counts `.app.inert`, and restores focus
 * to the trigger (or `#main` if disconnected) on close.
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
  const titleId = createUniqueId();
  const descId = createUniqueId();
  let dialogRef: HTMLDivElement | undefined;
  let cancelBtnRef: HTMLButtonElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    let active = true;
    const opener = document.activeElement as HTMLElement | null;
    const appRoot = document.querySelector(".app") as HTMLElement | null;
    acquireInert(appRoot);

    queueMicrotask(() => {
      if (active) cancelBtnRef?.focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      handleConfirmDialogKeyDown(e, dialogRef, {
        busy: props.busy,
        onCancel: props.onCancel,
      });
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      active = false;
      window.removeEventListener("keydown", onKeyDown);
      releaseInert(appRoot);
      restoreDialogFocus(opener);
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
            aria-labelledby={titleId}
            aria-describedby={descId}
            tabIndex={-1}
          >
            <h2 id={titleId} class="confirm-dialog-title">
              {props.title}
            </h2>
            <p id={descId} class="confirm-dialog-desc muted">
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
