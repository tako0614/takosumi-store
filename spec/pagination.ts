/**
 * Keyset cursor pagination, mirroring Takosumi's `{ items, nextCursor }`
 * convention. The cursor is an OPAQUE base64url-encoded {@link CursorPayload};
 * clients must treat it as a token and never construct it. `nextCursor` is
 * present only when more rows exist.
 */

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/**
 * Decoded cursor shape. `k` is the value of the active sort key at the boundary
 * row (updatedAt / createdAt / lowercased name); `id` is the row id tiebreaker.
 * Keeping a single generic `k` lets one cursor format serve every `sort` mode.
 */
export interface CursorPayload {
  readonly k: string;
  readonly id: string;
}
