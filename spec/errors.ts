/**
 * TCS error envelope. Same shape as Takosumi's deploy-control error envelope
 * (structurally re-declared here — the store is a separate repo and does not
 * import takosumi-contract).
 *
 * The public READ surface only needs this subset of codes; auth codes
 * (unauthenticated / permission_denied) are a private-implementation concern
 * and never appear on the open read endpoints.
 */
export type TcsErrorCode =
  | "invalid_argument"
  | "not_found"
  | "not_implemented"
  | "resource_exhausted"
  | "internal_error";

export interface TcsErrorEnvelope {
  readonly error: {
    readonly code: TcsErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}

/** Canonical code → HTTP status mapping. */
export const TCS_ERROR_HTTP_STATUS: Record<TcsErrorCode, number> = {
  invalid_argument: 400,
  not_found: 404,
  not_implemented: 501,
  resource_exhausted: 429,
  internal_error: 500,
};
