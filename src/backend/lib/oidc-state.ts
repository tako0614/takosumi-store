import { timingSafeEqual } from "node:crypto";
import { pkceChallenge } from "./oidc.ts";

export const OIDC_STATE_TTL_SECONDS = 600;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export interface OidcState {
  readonly version: 1;
  readonly verifier: string;
  readonly nonce: string;
  readonly returnTo: string;
  readonly browserBindingHash: string;
  readonly expiresAt: number;
}

export function validOidcStateId(state: string): boolean {
  return TOKEN.test(state);
}

/** Return only a relative reference that stays on this origin when redirected. */
export function sanitizeLoginReturn(value: string | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/u.test(value)
  )
    return "/";
  const origin = "https://store.invalid";
  const url = new URL(value, origin);
  if (url.origin !== origin || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

// One cookie per attempt preserves outstanding logins in different tabs. On
// HTTPS the __Host prefix also excludes parent-domain and path-scoped cookies.
function bindingCookieName(state: string, secure: boolean): string {
  return `${secure ? "__Host-" : ""}tcs_oidc_${state}`;
}

export function bindingCookie(
  state: string,
  token: string,
  secure: boolean,
): string {
  return `${bindingCookieName(state, secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? OIDC_STATE_TTL_SECONDS : 0}${secure ? "; Secure" : ""}`;
}

export function readBrowserBinding(
  header: string | undefined,
  state: string,
  secure: boolean,
): string | null {
  const name = bindingCookieName(state, secure);
  let token: string | null = null;
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (token !== null || !TOKEN.test(value)) return null;
    token = value;
  }
  return token;
}

/** Legacy unbound states are not upgraded; their original KV TTL expires them. */
export function readOidcState(
  raw: string | null,
  now: number,
): OidcState | null {
  if (!raw || !Number.isSafeInteger(now)) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const state = value as Record<string, unknown>;
    if (
      state.version !== 1 ||
      typeof state.verifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/u.test(state.verifier) ||
      typeof state.nonce !== "string" ||
      !TOKEN.test(state.nonce) ||
      typeof state.returnTo !== "string" ||
      typeof state.browserBindingHash !== "string" ||
      !TOKEN.test(state.browserBindingHash) ||
      typeof state.expiresAt !== "number" ||
      !Number.isSafeInteger(state.expiresAt) ||
      state.expiresAt <= now
    )
      return null;
    return state as unknown as OidcState;
  } catch {
    return null;
  }
}

export async function matchesBrowserBinding(
  expectedHash: string,
  token: string,
): Promise<boolean> {
  if (!TOKEN.test(expectedHash) || !TOKEN.test(token)) return false;
  const actualHash = await pkceChallenge(token);
  const encoder = new TextEncoder();
  return timingSafeEqual(
    encoder.encode(expectedHash),
    encoder.encode(actualHash),
  );
}
