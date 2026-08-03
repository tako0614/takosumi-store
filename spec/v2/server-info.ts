import type { TcsV2Capability } from "./version.ts";

export interface ServerInfoV2 {
  readonly spec: {
    readonly version: "2.0";
    readonly capabilities: readonly TcsV2Capability[];
    /** v1 remains available as an explicitly separate compatibility API. */
    readonly compatibleVersions?: readonly string[];
  };
  readonly server: {
    readonly name: string;
    readonly software: { readonly name: string; readonly version: string };
    /** Canonical base URL for the v2 API. */
    readonly baseUrl: string;
  };
  readonly listings: { readonly count: number };
  readonly categories: readonly {
    readonly key: string;
    readonly count: number;
  }[];
  readonly contact?: { readonly admin?: string; readonly url?: string };
  readonly defaultLocale?: "ja" | "en";
}
