import { Hono } from "hono";
import type { Env, Variables } from "./types.ts";
import { isBackendPath } from "./lib/backend-paths.ts";
import {
  jsonError,
  newRequestId,
  tcsError,
  tcsErrorResponse,
  type TcsContext,
} from "./lib/http.ts";
import { readCors } from "./lib/cors.ts";
import { createReadRoutes } from "./routes/spec-read.ts";
import { createAccountRoutes } from "./routes/account.ts";
import { createPublishRoutes } from "./routes/publish.ts";
import { createModerationRoutes } from "./routes/moderation.ts";
import { STORE_SOFTWARE_NAME, STORE_VERSION } from "./version.ts";

type StoreApp = Hono<{ Bindings: Env; Variables: Variables }>;

export function buildApp(): StoreApp {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  // Stamp a request id on every request for error envelopes.
  app.use("*", async (c, next) => {
    c.set("requestId", newRequestId());
    await next();
  });

  // Uncaught errors → internal_error envelope (never leak stack/HTML).
  app.onError((err, c) => {
    const requestId = (c as TcsContext).get("requestId") ?? newRequestId();
    const message = err instanceof Error ? err.message : "internal error";
    return tcsErrorResponse("internal_error", message, requestId);
  });

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      software: STORE_SOFTWARE_NAME,
      version: STORE_VERSION,
    }),
  );

  // /readyz: DB binding is the only hard precondition for the read surface.
  // OIDC (publish/login) is optional and reported but does not fail readiness.
  app.get("/readyz", (c) => {
    const missing: string[] = [];
    if (!c.env.DB) missing.push("DB");
    const oidcConfigured = Boolean(
      c.env.TAKOSUMI_ACCOUNTS_ISSUER_URL && c.env.TAKOSUMI_ACCOUNTS_CLIENT_ID,
    );
    if (missing.length > 0) {
      return c.json({ status: "unready", missing }, 503);
    }
    return c.json({
      status: "ready",
      capabilities: { publish: oidcConfigured },
    });
  });

  app.get("/robots.txt", (c) =>
    c.text("User-agent: *\nAllow: /\n", 200, {
      "content-type": "text/plain; charset=utf-8",
    }),
  );

  // Public read surface allows any origin (lets embedded dashboards fetch it).
  app.use("/tcs/*", readCors);
  app.use("/.well-known/tcs", readCors);

  // Defence-in-depth CSRF guard on cookie-authed mutations (SameSite=Lax cookies
  // already block cross-site POST; this rejects a present cross-origin Origin).
  const sameOrigin = async (c: TcsContext, next: () => Promise<void>) => {
    const m = c.req.method;
    if (m === "POST" || m === "PATCH" || m === "DELETE") {
      const origin = c.req.header("origin");
      if (origin) {
        let bad = false;
        try {
          bad = new URL(origin).host !== new URL(c.req.url).host;
        } catch {
          bad = true;
        }
        if (bad) {
          return jsonError(
            c,
            403,
            "permission_denied",
            "cross-origin request refused",
          );
        }
      }
    }
    await next();
  };
  app.use("/publish/*", sameOrigin);
  app.use("/moderation/*", sameOrigin);
  app.use("/account/*", sameOrigin);

  app.route("/", createReadRoutes());
  app.route("/", createAccountRoutes());
  app.route("/", createPublishRoutes());
  app.route("/", createModerationRoutes());

  app.notFound((c) => {
    const pathname = new URL(c.req.url).pathname;
    if (isBackendPath(pathname)) {
      return tcsError(c as TcsContext, "not_found", `no route for ${pathname}`);
    }
    const assets = c.env.ASSETS;
    if (assets) {
      // ASSETS.fetch uses the Cloudflare Request/Response types; bridge to the
      // DOM types Hono's notFound handler is declared with.
      return assets.fetch(c.req.raw as never) as unknown as Response;
    }
    return c.text("Not found", 404);
  });

  return app;
}

const app = buildApp();

export default app;
