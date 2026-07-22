/**
 * The visitor's own Takos origin (where install handoff links point). The store
 * cannot bake one Takos host — hostnames are operator-deployment choices — so
 * each user provides their own once; we keep it in localStorage.
 */
const LS_KEY = "tcs.takosOrigin";

export function getTakosOrigin(): string {
  try {
    return localStorage.getItem(LS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Validate + persist a Takos origin; returns the normalized origin or null. */
export function setTakosOrigin(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const origin = url.origin;
  try {
    localStorage.setItem(LS_KEY, origin);
  } catch {
    /* ignore */
  }
  return origin;
}
