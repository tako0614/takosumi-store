/**
 * OIDC ID Token verification — ported verbatim from
 * yurucommu/src/backend/lib/oidc-id-token.ts. Verifies the ES256 signature
 * against the issuer JWKS and validates iss/aud/exp/sub (and optional nonce)
 * fail-closed. Takosumi Accounts signs id_tokens ES256 and carries name/email
 * claims here (its userinfo is minimal).
 */
export type OidcIdTokenClaims = {
  sub: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
};

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

function b64urlToBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlToJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment))) as T;
}

async function fetchJwks(jwksUrl: string): Promise<Jwk[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(jwksUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new Error("JWKS missing keys array");
    return body.keys;
  } finally {
    clearTimeout(timer);
  }
}

function selectEcKey(keys: Jwk[], kid: string | undefined): Jwk | undefined {
  const ecKeys = keys.filter(
    (k) => k.kty === "EC" && k.crv === "P-256" && (k.use ?? "sig") === "sig",
  );
  if (kid) {
    const match = ecKeys.find((k) => k.kid === kid);
    if (match) return match;
  }
  return ecKeys.length === 1 ? ecKeys[0] : undefined;
}

export async function verifyOidcIdToken(
  idToken: string,
  opts: {
    issuer: string;
    clientId: string;
    jwksUrl: string;
    expectedNonce?: string;
  },
): Promise<OidcIdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");

  const header = b64urlToJson<{ alg?: string; kid?: string }>(parts[0]);
  if (header.alg !== "ES256") {
    throw new Error(`unexpected id_token alg: ${header.alg ?? "none"}`);
  }

  const claims = b64urlToJson<OidcIdTokenClaims>(parts[1]);

  const jwks = await fetchJwks(opts.jwksUrl);
  const jwk = selectEcKey(jwks, header.kid);
  if (!jwk) throw new Error("no matching JWKS signing key for id_token");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlToBytes(parts[2]).buffer as ArrayBuffer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`).buffer as ArrayBuffer,
  );
  if (!ok) throw new Error("id_token signature invalid");

  const norm = (s: string) => s.replace(/\/+$/, "");
  if (!claims.iss || norm(claims.iss) !== norm(opts.issuer)) {
    throw new Error("id_token iss mismatch");
  }
  const auds = Array.isArray(claims.aud)
    ? claims.aud
    : claims.aud
      ? [claims.aud]
      : [];
  if (!auds.includes(opts.clientId)) {
    throw new Error("id_token aud mismatch");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number") {
    throw new Error("id_token missing exp");
  }
  if (claims.exp < nowSec - 60) {
    throw new Error("id_token expired");
  }
  if (!claims.sub) throw new Error("id_token missing sub");

  if (opts.expectedNonce !== undefined && claims.nonce !== opts.expectedNonce) {
    throw new Error("id_token nonce mismatch");
  }

  return claims;
}
