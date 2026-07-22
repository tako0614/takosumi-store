import type { Context } from "hono";
import type { TcsErrorCode, TcsErrorEnvelope } from "../../../spec/errors.ts";
import { TCS_ERROR_HTTP_STATUS } from "../../../spec/errors.ts";
import type { Env, Variables } from "../types.ts";

export type TcsContext = Context<{ Bindings: Env; Variables: Variables }>;

export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Build a TcsErrorEnvelope JSON Response (used outside Hono ctx, e.g. notFound). */
export function tcsErrorResponse(
  code: TcsErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): Response {
  const body: TcsErrorEnvelope = {
    error: {
      code,
      message,
      requestId,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status: TCS_ERROR_HTTP_STATUS[code],
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Emit a TcsErrorEnvelope from a Hono handler, stamping the request id. */
export function tcsError(
  c: TcsContext,
  code: TcsErrorCode,
  message: string,
  details?: unknown,
): Response {
  const requestId = c.get("requestId") ?? newRequestId();
  return tcsErrorResponse(code, message, requestId, details);
}

/**
 * General error envelope for PRIVATE routes (publish/account/moderation), which
 * need auth codes (unauthenticated/permission_denied/conflict) outside the
 * limited read-surface vocabulary. Same envelope shape, explicit status.
 */
export function jsonError(
  c: TcsContext,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const requestId = c.get("requestId") ?? newRequestId();
  const body = {
    error: {
      code,
      message,
      requestId,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
