/**
 * Takosumi Capsule Store (TCS) — the open read spec.
 *
 * This barrel is the publishable contract. It is import-free of any
 * implementation and may be consumed by clients or copied into other store
 * implementations verbatim.
 */
export * from "./version.ts";
export * from "./errors.ts";
export * from "./pagination.ts";
export * from "./listing.ts";
export * from "./server-info.ts";
export * from "./api.ts";
