import type {
  D1Database,
  Fetcher,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";

/** Plain env vars (wrangler `[vars]` + secrets). */
export interface EnvVars {
  /** Canonical public origin of this node (ServerInfo.baseUrl, url normalization). */
  readonly APP_URL?: string;
  /** Sign in with Takosumi Accounts (OIDC) — issuer origin. */
  readonly TAKOSUMI_ACCOUNTS_ISSUER_URL?: string;
  /** Sign in with Takosumi Accounts (OIDC) — public PKCE client id. */
  readonly TAKOSUMI_ACCOUNTS_CLIENT_ID?: string;
  /** Optional confidential-client secret (public PKCE clients omit this). */
  readonly TAKOSUMI_ACCOUNTS_CLIENT_SECRET?: string;
  /** Salt for hashing session cookie material. */
  readonly SESSION_HASH_SALT?: string;
  /** Comma-separated OIDC subjects granted the moderator role. */
  readonly TCS_MODERATOR_SUBS?: string;
  /** Max visible listings per scope (publisher). Default 10. */
  readonly TCS_MAX_LISTINGS_PER_SCOPE?: string;
}

/** Worker bindings + env. Used as the Hono `Bindings` type. */
export interface Env extends EnvVars {
  readonly DB: D1Database;
  readonly ICONS: R2Bucket;
  readonly KV: KVNamespace;
  /** Static-assets fetcher (the built SPA). Absent in unit tests. */
  readonly ASSETS?: Fetcher;
}

/** Request-scoped Hono variables. */
export interface Variables {
  requestId: string;
}
