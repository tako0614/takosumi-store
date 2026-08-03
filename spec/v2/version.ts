/** TCS 2.0 protocol vocabulary. */

export const TCS_V2_SPEC_VERSION = "2.0" as const;
export const TCS_V2_API_PREFIX = "/tcs/v2" as const;

/** v2 advertises only filters backed by bounded indexed read paths. */
export type TcsV2Capability =
  | "filter.category"
  | "filter.scope"
  | "sort.updated"
  | "sort.created"
  | "icons";
