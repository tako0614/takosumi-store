/**
 * Takosumi Capsule Store (TCS) — open read-API version + capability vocabulary.
 *
 * The TCS read API is the contract the takos / takosumi clients consume to
 * browse and install Capsules. This module is pure data — it carries no runtime
 * and may be copied/published verbatim.
 */

/** Spec version. `major.minor`; minor bumps are additive-only. */
export const TCS_SPEC_VERSION = "1.0" as const;

/** Default content type for TCS JSON responses. */
export const TCS_MEDIA_TYPE = "application/json" as const;

/**
 * Optional behaviors a server may advertise in {@link ServerInfo.spec.capabilities}.
 * A client branches on these (e.g. skip a node that lacks `search` during an
 * aggregated search). The four read endpoints in §api are mandatory regardless.
 */
export type TcsCapability =
  | "search"
  | "filter.category"
  | "filter.kind"
  | "filter.provider"
  | "filter.surface"
  | "sort.updated"
  | "sort.created"
  | "sort.name"
  | "icons";
