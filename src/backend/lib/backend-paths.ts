/**
 * Decide whether a pathname is a BACKEND route (must 404 as JSON when unmatched)
 * vs a client-routed SPA path (falls through to the ASSETS binding / SPA shell).
 *
 * Without this, the Cloudflare ASSETS binding's single-page-application
 * not_found_handling would serve the HTML shell with 200 for an unmatched
 * `/tcs/...` request, so an API client (or our own fetch) would get HTML instead
 * of a proper JSON 404.
 */
const BACKEND_PREFIXES = [
  "/tcs/",
  "/publish/",
  "/account/",
  "/moderation/",
] as const;

const BACKEND_EXACT = new Set<string>([
  "/.well-known/tcs",
  "/tcs",
  "/healthz",
  "/readyz",
  "/robots.txt",
]);

export function isBackendPath(pathname: string): boolean {
  if (BACKEND_EXACT.has(pathname)) return true;
  return BACKEND_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
