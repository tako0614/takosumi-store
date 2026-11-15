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
  bindingCookie,
  matchesBrowserBinding,
  OIDC_STATE_TTL_SECONDS,
  readBrowserBinding,
  readOidcState,
  sanitizeLoginReturn,
  validOidcStateId,
  type OidcState,
} from "../lib/oidc-state.ts";
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
    const browserBinding = randomToken();
    const challenge = await pkceChallenge(verifier);
    const redirectUri = `${originOf(c)}/account/callback`;
    const returnTo = sanitizeLoginReturn(c.req.query("return"));
    const browserBindingHash = await pkceChallenge(browserBinding);
    const stored: OidcState = {
      version: 1,
      verifier,
      nonce,
      returnTo,
      browserBindingHash,
      expiresAt: Date.now() + OIDC_STATE_TTL_SECONDS * 1000,
    };
    await c.env.KV.put(`oidc_state:${state}`, JSON.stringify(stored), {
      expirationTtl: OIDC_STATE_TTL_SECONDS,
    });
    c.header(
      "Set-Cookie",
      bindingCookie(state, browserBinding, isSecureRequest(c)),
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
    if (!state || !validOidcStateId(state)) {
      return jsonError(c, 400, "invalid_argument", "missing code/state");
    }
    const secure = isSecureRequest(c);
    const clearedBinding = bindingCookie(state, "", secure);
    c.header("Set-Cookie", clearedBinding, { append: true });
    const reject = (status: 400 | 401, message: string) => {
      // jsonError returns a standalone Response, without Hono's prepared
      // headers. Attach cleanup to that actual failure response as well.
      const response = jsonError(
        c,
        status,
        status === 401 ? "unauthenticated" : "invalid_argument",
        message,
      );
      response.headers.append("Set-Cookie", clearedBinding);
      return response;
    };
    if (!code) {
      return reject(400, "missing code/state");
    }
    const browserBinding = readBrowserBinding(
      c.req.header("cookie"),
      state,
      secure,
    );
    if (!browserBinding) {
      return reject(400, "invalid browser state");
    }
    const raw = await c.env.KV.get(`oidc_state:${state}`);
    const stored = readOidcState(raw, Date.now());
    if (
      !stored ||
      !(await matchesBrowserBinding(
        stored.browserBindingHash,
        browserBinding,
      )) ||
      stored.expiresAt <= Date.now()
    ) {
      return reject(400, "invalid or expired state");
    }
    // Keep the existing KV consume-before-exchange ordering. KV get/delete is
    // not a globally atomic compare-and-consume operation.
    await c.env.KV.delete(`oidc_state:${state}`);
    if (stored.expiresAt <= Date.now())
      return reject(400, "invalid or expired state");
    const { verifier, nonce, returnTo } = stored;
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
      return reject(401, "login failed");
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
      { append: true },
    );
    return c.redirect(sanitizeLoginReturn(returnTo), 302);
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
