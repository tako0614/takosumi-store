import type { Hono } from "hono";
import type { Env } from "../../src/backend/types.ts";

type AnyApp = Hono<{ Bindings: Env; Variables: { requestId: string } }>;

export function jreq(
  app: AnyApp,
  path: string,
  opts: {
    method?: string;
    cookie?: string;
    body?: unknown;
    env?: Partial<Env>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  return Promise.resolve(
    app.fetch(
      new Request(`https://store.test${path}`, { method, headers, body }),
      (opts.env ?? {}) as Env,
    ),
  );
}
