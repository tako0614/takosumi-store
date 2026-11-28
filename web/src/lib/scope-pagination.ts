/**
 * Pure cursor-pagination state helpers for publisher scope pages (`ScopePage`).
 * Keeps loaded listings and the pending cursor intact across transient page-2+
 * errors so visitors can retry without losing previously loaded items.
 */
import type { ListingsPageV2 } from "../../../spec/v2/api.ts";
import type { ListingV2 } from "../../../spec/v2/listing.ts";

export interface ScopePageState {
  readonly items: readonly ListingV2[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: boolean;
  readonly loadMoreError: boolean;
}

export function initialScopeState(): ScopePageState {
  return {
    items: [],
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: false,
    loadMoreError: false,
  };
}

export function applyInitialScopePage(page: ListingsPageV2): ScopePageState {
  return {
    items: [...page.items],
    nextCursor: page.nextCursor ?? null,
    loading: false,
    loadingMore: false,
    error: false,
    loadMoreError: false,
  };
}

export function applyInitialScopeError(): ScopePageState {
  return {
    items: [],
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: true,
    loadMoreError: false,
  };
}

export function startScopeLoadMore(state: ScopePageState): ScopePageState {
  return {
    ...state,
    loadingMore: true,
    loadMoreError: false,
  };
}

export function appendScopePage(
  state: ScopePageState,
  page: ListingsPageV2,
): ScopePageState {
  const seen = new Set(state.items.map((item) => item.id));
  const merged = [...state.items];
  for (const item of page.items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return {
    items: merged,
    nextCursor: page.nextCursor ?? null,
    loading: false,
    loadingMore: false,
    error: false,
    loadMoreError: false,
  };
}

export function applyScopeLoadMoreError(state: ScopePageState): ScopePageState {
  return {
    ...state,
    loadingMore: false,
    loadMoreError: true,
  };
}
