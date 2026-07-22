import type { TcsContext } from "./http.ts";

/**
 * CORS for the OPEN read surface. The data is public and read-only, so any
 * origin may read it — this is what lets an embedded client (the takos /
 * takosumi dashboards) fetch listings cross-origin. A simple GET + Accept is not
 * preflighted, so a response-side `Access-Control-Allow-Origin` suffices; the
 * OPTIONS shortcut covers stricter clients.
 */
export async function readCors(
  c: TcsContext,
  next: () => Promise<void>,
): Promise<Response | void> {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type, accept",
        "access-control-max-age": "86400",
      },
    });
  }
  await next();
  c.header("access-control-allow-origin", "*");
}
