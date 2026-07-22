import type { CursorPayload } from "../../../spec/pagination.ts";

/** UTF-8-safe base64url encode/decode (names may contain non-latin1 chars). */
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function encodeCursor(payload: CursorPayload): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decode an opaque cursor; returns null for malformed input (→ 400). */
export function decodeCursor(value: string): CursorPayload | null {
  try {
    const json = new TextDecoder().decode(fromBase64Url(value));
    const obj = JSON.parse(json) as unknown;
    if (
      obj &&
      typeof obj === "object" &&
      typeof (obj as Record<string, unknown>).k === "string" &&
      typeof (obj as Record<string, unknown>).id === "string"
    ) {
      return {
        k: (obj as { k: string }).k,
        id: (obj as { id: string }).id,
      };
    }
    return null;
  } catch {
    return null;
  }
}
