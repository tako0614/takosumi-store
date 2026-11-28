import { For, Show, type Component, type JSX } from "solid-js";

/** Placeholder cards shown while the first page loads. */
export const SkeletonGrid: Component<{ count?: number; label?: string }> = (
  props,
) => {
  return (
    <div aria-busy="true">
      <span class="sr-only" role="status">
        {props.label ?? "Loading…"}
      </span>
      <div class="app-grid" aria-hidden="true">
        <For each={Array.from({ length: props.count ?? 8 })}>
          {() => (
            <div class="app-card skeleton-card">
              <span class="skel skel-icon" />
              <div class="app-card-text">
                <span class="skel skel-line" style={{ width: "70%" }} />
                <span class="skel skel-line" style={{ width: "45%" }} />
                <span class="skel skel-line" style={{ width: "90%" }} />
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

export const EmptyState: Component<{
  glyph?: JSX.Element;
  title: string;
  message?: string;
  action?: JSX.Element;
  /** Render the title as the page's `<h1>` (for whole-page states). */
  heading?: boolean;
}> = (props) => {
  return (
    <div class="state">
      <div class="state-glyph" aria-hidden="true">
        {props.glyph ?? "🔍"}
      </div>
      <Show
        when={props.heading}
        fallback={<p class="state-title">{props.title}</p>}
      >
        <h1 class="state-title">{props.title}</h1>
      </Show>
      <Show when={props.message}>
        <p class="state-message">{props.message}</p>
      </Show>
      <Show when={props.action}>{props.action}</Show>
    </div>
  );
};

export const ErrorState: Component<{
  title: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Render the title as the page's `<h1>` (for whole-page states). */
  heading?: boolean;
}> = (props) => {
  return (
    <div class="state" role="alert">
      <div class="state-glyph" aria-hidden="true">
        ⚠️
      </div>
      <Show
        when={props.heading}
        fallback={<p class="state-title">{props.title}</p>}
      >
        <h1 class="state-title">{props.title}</h1>
      </Show>
      <Show when={props.message}>
        <p class="state-message">{props.message}</p>
      </Show>
      <Show when={props.onRetry}>
        <button type="button" class="btn btn-secondary" onClick={props.onRetry}>
          {props.retryLabel ?? "Retry"}
        </button>
      </Show>
    </div>
  );
};
