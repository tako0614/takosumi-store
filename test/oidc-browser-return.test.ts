import { expect, test } from "bun:test";
import type { Env } from "../src/backend/types.ts";
import { publishers, sessions } from "../src/backend/db/schema.ts";
import { upsertPublisherBySub } from "../src/backend/db/publishers-store.ts";
import { createAccountRoutes } from "../src/backend/routes/account.ts";
import { createTestDb } from "./helpers/test-db.ts";
import { login as existingLogin, TEST_SALT } from "./helpers/login.ts";

const b64 = (value: Uint8Array | string) =>
  Buffer.from(value).toString("base64url");
async function digest(value: string) {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
type TokenMode = "valid" | "nonce" | "signature" | "expired" | "provider-error";

async function fixture() {
  const db = await createTestDb();
  const app = createAccountRoutes(() => db);
  const kv = new Map<string, string>();
  const kvOptions = new Map<string, unknown>();
  const deletions: string[] = [];
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const codes = new Map<
    string,
    { nonce: string; challenge: string; redirect: string }
  >();
  let exchanges = 0;
  let mode: TokenMode = "valid";
  let issuer = "";
  const idp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/jwks")
        return Response.json({
          keys: [{ ...jwk, kid: "local-key", use: "sig", alg: "ES256" }],
        });
      if (url.pathname !== "/oauth/token")
        return new Response(null, { status: 404 });
      exchanges += 1;
      const form = new URLSearchParams(await request.text());
      const code = form.get("code") ?? "";
      const authorization = codes.get(code);
      codes.delete(code);
      if (
        mode === "provider-error" ||
        !authorization ||
        form.get("client_id") !== "local-store" ||
        form.get("redirect_uri") !== authorization.redirect ||
        (await digest(form.get("code_verifier") ?? "")) !==
          authorization.challenge
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const header = b64(
        JSON.stringify({ alg: "ES256", kid: "local-key", typ: "JWT" }),
      );
      const payload = b64(
        JSON.stringify({
          sub: "local-subject",
          iss: issuer,
          aud: "local-store",
          exp:
            Math.floor(Date.now() / 1000) + (mode === "expired" ? -120 : 300),
          nonce: mode === "nonce" ? "other-nonce" : authorization.nonce,
          name: "Local person",
        }),
      );
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(`${header}.${payload}`),
        ),
      );
      if (mode === "signature") signature[0] ^= 1;
      return Response.json({
        id_token: `${header}.${payload}.${b64(signature)}`,
      });
    },
  });
  issuer = idp.url.origin;
  const env = {
    TAKOSUMI_ACCOUNTS_ISSUER_URL: issuer,
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "local-store",
    SESSION_HASH_SALT: TEST_SALT,
    KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string, options: unknown) {
        kv.set(key, value);
        kvOptions.set(key, options);
      },
      async delete(key: string) {
        deletions.push(key);
        kv.delete(key);
      },
    },
  } as unknown as Env;
  return {
    db,
    app,
    kv,
    kvOptions,
    deletions,
    env,
    get exchanges() {
      return exchanges;
    },
    setMode(value: TokenMode) {
      mode = value;
    },
    async rows() {
      return {
        publishers: (await db.select().from(publishers)).length,
        sessions: (await db.select().from(sessions)).length,
      };
    },
    async start(returnTo = "/", origin = "https://store.test") {
      const response = await app.fetch(
        new Request(
          `${origin}/account/login?return=${encodeURIComponent(returnTo)}`,
        ),
        env,
      );
      const url = new URL(response.headers.get("location")!);
      const state = url.searchParams.get("state")!;
      const code = crypto.randomUUID();
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      codes.set(code, {
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        redirect: url.searchParams.get("redirect_uri")!,
      });
      const cookies = response.headers.getSetCookie();
      const cookie =
        cookies
          .find((c) => /^(?:__Host-)?tcs_oidc_/u.test(c))
          ?.split(";", 1)[0] ?? "";
      return {
        response,
        state,
        code,
        cookie,
        cookies,
        origin,
        key: `oidc_state:${state}`,
      };
    },
    async callback(
      attempt: { state: string; code: string; cookie: string; origin: string },
      cookie = attempt.cookie,
      includeCode = true,
    ) {
      const query = new URLSearchParams({
        state: attempt.state,
        ...(includeCode ? { code: attempt.code } : {}),
      });
      return app.fetch(
        new Request(`${attempt.origin}/account/callback?${query}`, {
          headers: cookie ? { cookie } : {},
        }),
        env,
      );
    },
    close() {
      idp.stop(true);
    },
  };
}

test("start binds a strong per-attempt host-only cookie to a hashed expiring state", async () => {
  const h = await fixture();
  try {
    const a = await h.start();
    expect(a.response.status).toBe(302);
    expect(a.cookies).toHaveLength(1);
    expect(a.cookies[0]).toMatch(/^__Host-tcs_oidc_[A-Za-z0-9_-]+=/u);
    for (const attribute of [
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=600",
    ])
      expect(a.cookies[0]).toContain(attribute);
    expect(a.cookies[0]).not.toContain("Domain=");
    const token = a.cookie.split("=", 2)[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const stored = JSON.parse(h.kv.get(a.key)!);
    expect(stored.browserBindingHash).toBe(await digest(token));
    expect(Object.values(stored)).not.toContain(token);
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
    expect(h.kvOptions.get(a.key)).toEqual({ expirationTtl: 600 });
    expect(await h.rows()).toEqual({ publishers: 0, sessions: 0 });
  } finally {
    h.close();
  }
});

test("missing browser proof refuses before state consumption, exchange or identity writes", async () => {
  const h = await fixture();
  try {
    const a = await h.start();
    const response = await h.callback(a, "");
    expect({
      status: response.status,
      exchanges: h.exchanges,
      rows: await h.rows(),
      statePresent: h.kv.has(a.key),
      deletes: h.deletions.length,
    }).toEqual({
      status: 400,
      exchanges: 0,
      rows: { publishers: 0, sessions: 0 },
      statePresent: true,
      deletes: 0,
    });
  } finally {
    h.close();
  }
});

test("wrong, other-attempt, duplicate or existing-session cookies do not authorize a callback", async () => {
  for (const kind of ["wrong", "other", "duplicate", "session"] as const) {
    const h = await fixture();
    try {
      const a = await h.start();
      const other = await h.start();
      const name = a.cookie.split("=", 1)[0] || `__Host-tcs_oidc_${a.state}`;
      const wrong = `${name}=${"x".repeat(43)}`;
      const cookie =
        kind === "other"
          ? other.cookie
          : kind === "duplicate"
            ? `${a.cookie}; ${wrong}`
            : kind === "session"
              ? (await existingLogin(h.db)).cookie
              : wrong;
      if (kind === "session") {
        const me = await h.app.fetch(
          new Request("https://store.test/account/me", { headers: { cookie } }),
          h.env,
        );
        expect(me.status).toBe(200);
      }
      const before = await h.rows();
      const response = await h.callback(a, cookie);
      expect({
        status: response.status,
        exchanges: h.exchanges,
        rows: await h.rows(),
        statePresent: h.kv.has(a.key),
        deletes: h.deletions.length,
      }).toEqual({
        status: 400,
        exchanges: 0,
        rows: before,
        statePresent: true,
        deletes: 0,
      });
      expect(h.kv.has(other.key)).toBe(true);
      // A rejected submission must not burn the initiating browser's attempt.
      expect((await h.callback(a)).status).toBe(302);
    } finally {
      h.close();
    }
  }
});

test("same browser completes verified PKCE/nonce login once and clears only its attempt cookie", async () => {
  const h = await fixture();
  try {
    const a = await h.start("/listings?query=1#section");
    const response = await h.callback(a);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/listings?query=1#section");
    expect(
      response.headers
        .getSetCookie()
        .some(
          (v) =>
            v.startsWith(`${a.cookie.split("=", 1)[0]}=;`) &&
            v.includes("Max-Age=0"),
        ),
    ).toBe(true);
    const session = response.headers
      .getSetCookie()
      .find((v) => v.startsWith("tcs_session="))!
      .split(";", 1)[0]!;
    const me = await h.app.fetch(
      new Request("https://store.test/account/me", {
        headers: { cookie: session },
      }),
      h.env,
    );
    expect(me.status).toBe(200);
    const persisted = await h.db.select().from(publishers);
    expect(persisted[0]?.oidcSub).toBe("local-subject");
    expect((await me.json()).publisher.id).toBe(persisted[0]?.id);
    expect(await h.rows()).toEqual({ publishers: 1, sessions: 1 });
    expect(h.kv.has(a.key)).toBe(false);
    expect((await h.callback(a)).status).toBe(400);
    expect(h.exchanges).toBe(1);
    expect(await h.rows()).toEqual({ publishers: 1, sessions: 1 });
  } finally {
    h.close();
  }
});

test("distinct parallel attempts in one browser keep independent cookies and both complete", async () => {
  const h = await fixture();
  try {
    await upsertPublisherBySub(h.db, {
      id: "existing-local-publisher",
      sub: "local-subject",
      now: new Date(),
    });
    const a = await h.start("/first");
    const b = await h.start("/second");
    expect(a.cookie.split("=", 1)[0]).not.toBe(b.cookie.split("=", 1)[0]);
    expect(a.cookie.split("=", 2)[1]).not.toBe(b.cookie.split("=", 2)[1]);
    const cookies = `${a.cookie}; ${b.cookie}`;
    const responses = await Promise.all([
      h.callback(a, cookies),
      h.callback(b, cookies),
    ]);
    expect(responses.map((r) => r.status)).toEqual([302, 302]);
    expect(responses.map((r) => r.headers.get("location"))).toEqual([
      "/first",
      "/second",
    ]);
    for (let i = 0; i < 2; i++) {
      const thisName = [a, b][i]!.cookie.split("=", 1)[0]!;
      const otherName = [b, a][i]!.cookie.split("=", 1)[0]!;
      expect(
        responses[i]!.headers.getSetCookie().some(
          (v) => v.startsWith(`${thisName}=`) && v.includes("Max-Age=0"),
        ),
      ).toBe(true);
      expect(
        responses[i]!.headers.getSetCookie().some((v) =>
          v.startsWith(`${otherName}=`),
        ),
      ).toBe(false);
    }
    expect(h.exchanges).toBe(2);
    expect((await h.rows()).sessions).toBe(2);
  } finally {
    h.close();
  }
});

test("expired, legacy-unbound or malformed state fails closed with no identity effects", async () => {
  for (const kind of ["expired", "legacy", "malformed"] as const) {
    const h = await fixture();
    try {
      const a = await h.start();
      const stored = JSON.parse(h.kv.get(a.key)!);
      if (kind === "expired") stored.expiresAt = Date.now();
      if (kind === "legacy") {
        delete stored.browserBindingHash;
        delete stored.expiresAt;
        delete stored.version;
      }
      h.kv.set(a.key, kind === "malformed" ? "{" : JSON.stringify(stored));
      expect((await h.callback(a)).status).toBe(400);
      expect(h.exchanges).toBe(0);
      expect(await h.rows()).toEqual({ publishers: 0, sessions: 0 });
      expect(h.deletions).toHaveLength(0);
      expect(h.kv.has(a.key)).toBe(true);
    } finally {
      h.close();
    }
  }
});

test("provider, signature, nonce, token-expiry and PKCE failures stay consumed and clear the cookie", async () => {
  for (const mode of [
    "provider-error",
    "signature",
    "nonce",
    "expired",
    "pkce",
  ] as const) {
    const h = await fixture();
    try {
      const a = await h.start();
      if (mode === "pkce") {
        const state = JSON.parse(h.kv.get(a.key)!);
        state.verifier = "v".repeat(64);
        h.kv.set(a.key, JSON.stringify(state));
      } else h.setMode(mode);
      const response = await h.callback(a);
      expect(response.status).toBe(401);
      expect(
        response.headers
          .getSetCookie()
          .some(
            (v) =>
              v.startsWith(`${a.cookie.split("=", 1)[0]}=`) &&
              v.includes("Max-Age=0"),
          ),
      ).toBe(true);
      expect(await h.rows()).toEqual({ publishers: 0, sessions: 0 });
      expect(h.exchanges).toBe(1);
      expect(h.kv.has(a.key)).toBe(false);
      expect((await h.callback(a)).status).toBe(400);
      expect(h.exchanges).toBe(1);
    } finally {
      h.close();
    }
  }
});

test("return targets resolve to a genuine relative same-origin path", async () => {
  const h = await fixture();
  try {
    for (const [value, expected] of [
      ["/\\outside.invalid", "/"],
      ["/\t\\outside.invalid", "/"],
      ["/\u0000path", "/"],
      ["//outside.invalid", "/"],
      ["https://outside.invalid/path", "/"],
      ["/a/..//outside.invalid", "/"],
      ["/listings?x=1#part", "/listings?x=1#part"],
      ["/encoded%20path?q=%2f#local", "/encoded%20path?q=%2f#local"],
    ]) {
      const a = await h.start(value);
      const response = await h.callback(a);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(expected);
      expect(new URL(response.headers.get("location")!, a.origin).origin).toBe(
        a.origin,
      );
    }
  } finally {
    h.close();
  }
});

test("HTTP development cookie and incomplete callback preserve scoped cleanup semantics", async () => {
  const h = await fixture();
  try {
    const a = await h.start("/", "http://store.test");
    expect(a.cookies[0]).toMatch(/^tcs_oidc_/u);
    expect(a.cookies[0]).not.toContain("Secure");
    const response = await h.callback(a, a.cookie, false);
    expect(response.status).toBe(400);
    expect(
      response.headers
        .getSetCookie()
        .some(
          (v) =>
            v.startsWith(`${a.cookie.split("=", 1)[0]}=`) &&
            v.includes("Max-Age=0"),
        ),
    ).toBe(true);
    expect(h.kv.has(a.key)).toBe(true);
    expect(h.exchanges).toBe(0);
    expect(await h.rows()).toEqual({ publishers: 0, sessions: 0 });
  } finally {
    h.close();
  }
});
