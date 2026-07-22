import { Hono } from "hono";
import type { Env, Variables } from "../types.ts";
import { jsonError, type TcsContext } from "../lib/http.ts";
import {
  defaultResolveDb,
  isSecureRequest,
  originOf,
  type DbResolver,
} from "../lib/db-context.ts";
import {
  buildAuthorizeUrl,
  exchangeAndVerify,
  getOidcConfig,
  pkceChallenge,
  randomToken,
} from "../lib/oidc.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  createSession,
  deleteSession,
  parseSessionCookie,
} from "../lib/session.ts";
import {
  currentPublisher,
  requirePublisher,
  sessionSalt,
} from "../lib/auth.ts";
import {
  getPublisherById,
  setPublisherHandle,
  upsertPublisherBySub,
  type Publisher,
} from "../db/publishers-store.ts";

function publicPublisher(p: Publisher) {
  return {
    id: p.id,
    handle: p.handle,
    displayName: p.displayName,
    email: p.email,
    role: p.role,
  };
}

function sanitizeReturn(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\r\n]/.test(value)) return "/";
  return value;
}

function moderatorSubs(env: Env): string[] {
  return (env.TCS_MODERATOR_SUBS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createAccountRoutes(
  resolveDb: DbResolver = defaultResolveDb,
): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.get("/account/config", (c: TcsContext) =>
    c.json({
      oidc: Boolean(getOidcConfig(c.env)),
      providerName: "Takosumi Accounts",
    }),
  );

  app.get("/account/login", async (c: TcsContext) => {
    const cfg = getOidcConfig(c.env);
    if (!cfg) return jsonError(c, 404, "not_found", "login is not configured");
    const state = randomToken();
    const verifier = randomToken(48);
    const nonce = randomToken();
    const challenge = await pkceChallenge(verifier);
    const redirectUri = `${originOf(c)}/account/callback`;
    const returnTo = sanitizeReturn(c.req.query("return"));
    await c.env.KV.put(
      `oidc_state:${state}`,
      JSON.stringify({ verifier, nonce, returnTo }),
      { expirationTtl: 600 },
    );
    const url = buildAuthorizeUrl(cfg, {
      redirectUri,
      state,
      codeChallenge: challenge,
      nonce,
    });
    return c.redirect(url, 302);
  });

  app.get("/account/callback", async (c: TcsContext) => {
    const cfg = getOidcConfig(c.env);
    if (!cfg) return jsonError(c, 404, "not_found", "login is not configured");
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return jsonError(c, 400, "invalid_argument", "missing code/state");
    }
    const raw = await c.env.KV.get(`oidc_state:${state}`);
    if (!raw) {
      return jsonError(c, 400, "invalid_argument", "invalid or expired state");
    }
    await c.env.KV.delete(`oidc_state:${state}`);
    const { verifier, nonce, returnTo } = JSON.parse(raw) as {
      verifier: string;
      nonce: string;
      returnTo: string;
    };
    const redirectUri = `${originOf(c)}/account/callback`;
    let identity;
    try {
      identity = await exchangeAndVerify(cfg, {
        code,
        redirectUri,
        codeVerifier: verifier,
        expectedNonce: nonce,
      });
    } catch {
      return jsonError(c, 401, "unauthenticated", "login failed");
    }

    const db = resolveDb(c);
    const now = new Date();
    const publisher = await upsertPublisherBySub(db, {
      id: `pub-${crypto.randomUUID()}`,
      sub: identity.sub,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.email ? { email: identity.email } : {}),
      now,
      firstIsModerator: moderatorSubs(c.env).includes(identity.sub),
    });
    const token = randomToken();
    await createSession(db, {
      publisherId: publisher.id,
      token,
      salt: sessionSalt(c),
      now,
    });
    c.header(
      "Set-Cookie",
      buildSessionCookie(token, { secure: isSecureRequest(c) }),
    );
    return c.redirect(sanitizeReturn(returnTo), 302);
  });

  app.get("/account/me", async (c: TcsContext) => {
    const publisher = await currentPublisher(c, resolveDb(c));
    if (!publisher)
      return jsonError(c, 401, "unauthenticated", "not signed in");
    return c.json({ publisher: publicPublisher(publisher) });
  });

  app.post("/account/handle", async (c: TcsContext) => {
    const db = resolveDb(c);
    const auth = await requirePublisher(c, db);
    if (!auth.ok) return auth.response;
    const body = (await c.req.json().catch(() => null)) as {
      handle?: unknown;
    } | null;
    const handle = typeof body?.handle === "string" ? body.handle : "";
    const r = await setPublisherHandle(db, {
      id: auth.publisher.id,
      handle,
      now: new Date(),
    });
    if (!r.ok) {
      return r.reason === "taken"
        ? jsonError(c, 409, "conflict", "handle already taken")
        : jsonError(c, 400, "invalid_argument", "invalid handle");
    }
    const updated = await getPublisherById(db, auth.publisher.id);
    return c.json({ publisher: updated ? publicPublisher(updated) : null });
  });

  app.post("/account/logout", async (c: TcsContext) => {
    const token = parseSessionCookie(c.req.header("cookie") ?? null);
    if (token) {
      await deleteSession(resolveDb(c), { token, salt: sessionSalt(c) });
    }
    c.header("Set-Cookie", clearSessionCookie({ secure: isSecureRequest(c) }));
    return c.json({ ok: true });
  });

  return app;
}
