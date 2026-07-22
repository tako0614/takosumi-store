import { For, Show, type Component, type JSX } from "solid-js";

/** Shimmer placeholder cards shown while the first page loads. */
export const SkeletonGrid: Component<{ count?: number }> = (props) => {
  return (
    <div class="app-grid" aria-busy="true" aria-hidden="true">
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
  );
};

export const EmptyState: Component<{
  glyph?: JSX.Element;
  title: string;
  message?: string;
  action?: JSX.Element;
}> = (props) => {
  return (
    <div class="state">
      <div class="state-glyph" aria-hidden="true">
        {props.glyph ?? "🔍"}
      </div>
      <p class="state-title">{props.title}</p>
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
}> = (props) => {
  return (
    <div class="state">
      <div class="state-glyph" aria-hidden="true">
        ⚠️
      </div>
      <p class="state-title">{props.title}</p>
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
