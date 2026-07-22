import { isSafeRemoteUrl } from "./ssrf.ts";

export class FetchGuardError extends Error {}

export interface GuardedResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

async function readCapped(
  res: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const cl = res.headers.get("content-length");
  if (cl && Number.isFinite(Number(cl)) && Number(cl) > limit) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new FetchGuardError(`response body exceeds ${limit} bytes`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          throw new FetchGuardError(`response body exceeds ${limit} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * SSRF-guarded fetch with a hard timeout, a body byte cap, and no redirect
 * following (a followed redirect would re-open the SSRF vector). Used for the
 * publish-path icon re-host and read-path README fetches.
 */
export async function guardedFetch(
  url: string,
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<GuardedResult> {
  if (!isSafeRemoteUrl(url)) throw new FetchGuardError(`unsafe url: ${url}`);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: opts.headers,
      redirect: "manual",
      signal: ctrl.signal,
    });
    const bytes = await readCapped(res, maxBytes, ctrl.signal);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      bytes,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function guardedFetchText(
  url: string,
  opts?: {
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
  },
): Promise<{ status: number; text: string }> {
  const r = await guardedFetch(url, opts);
  return { status: r.status, text: new TextDecoder().decode(r.bytes) };
}
