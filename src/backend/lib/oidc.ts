/**
 * "Sign in with Takosumi Accounts" — OIDC authorization-code + PKCE (public
 * client). issuer + client_id are injected by the outputs.tf `identity.oidc`
 * consume (or set manually); the client may be public (PKCE-only, no secret).
 */
import type { Env } from "../types.ts";
import { verifyOidcIdToken } from "./oidc-id-token.ts";

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
}

function trimEnv(v: string | undefined): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}

export function getOidcConfig(env: Env): OidcConfig | null {
  const issuer = trimEnv(env.TAKOSUMI_ACCOUNTS_ISSUER_URL);
  const clientId = trimEnv(env.TAKOSUMI_ACCOUNTS_CLIENT_ID);
  if (!issuer || !clientId) return null;
  const clientSecret = trimEnv(env.TAKOSUMI_ACCOUNTS_CLIENT_SECRET);
  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
  };
}

function endpoint(issuer: string, path: string): string {
  return `${issuer.replace(/\/+$/, "")}${path}`;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return b64url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(
  cfg: OidcConfig,
  params: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    nonce: string;
  },
): string {
  const url = new URL(endpoint(cfg.issuer, "/oauth/authorize"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", params.nonce);
  return url.toString();
}

export interface ExchangedIdentity {
  readonly sub: string;
  readonly name?: string;
  readonly email?: string;
}

/** Exchange the auth code, then verify the id_token and return its identity. */
export async function exchangeAndVerify(
  cfg: OidcConfig,
  params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    expectedNonce: string;
  },
): Promise<ExchangedIdentity> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: cfg.clientId,
    code_verifier: params.codeVerifier,
  });
  if (cfg.clientSecret) form.set("client_secret", cfg.clientSecret);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let token: { id_token?: string };
  try {
    const res = await fetch(endpoint(cfg.issuer, "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
    token = (await res.json()) as { id_token?: string };
  } finally {
    clearTimeout(timer);
  }
  if (!token.id_token) throw new Error("token response missing id_token");

  const claims = await verifyOidcIdToken(token.id_token, {
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    jwksUrl: endpoint(cfg.issuer, "/oauth/jwks"),
    expectedNonce: params.expectedNonce,
  });
  return {
    sub: claims.sub,
    ...(claims.name ? { name: claims.name } : {}),
    ...(claims.email ? { email: claims.email } : {}),
  };
}
