/**
 * The store's own site shows only its OWN listings — the single origin it is
 * served from. Bundling across multiple stores is a client (takos / takosumi)
 * concern, not the store's, so there is no add-server / multi-server surface
 * here.
 */
export interface KnownServer {
  readonly base: string;
  readonly home: boolean;
}

function normalizeBase(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.toLowerCase();
  }
}

export function homeBase(): string {
  return typeof location !== "undefined" ? location.origin : "";
}

/** The store's own origin — the only server its UI ever queries. */
export function getServers(): KnownServer[] {
  return [{ base: normalizeBase(homeBase()), home: true }];
}
