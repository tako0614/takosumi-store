import type { ListingSourceV2 } from "../v2/listing-source.ts";

export interface ListingSourceV2Fixture {
  readonly name: string;
  readonly input: unknown;
  readonly expected: ListingSourceV2 | undefined;
}

export const TCS_V2_LISTING_SOURCE_FIXTURES: readonly ListingSourceV2Fixture[] =
  [
    {
      name: "canonicalizes a credential-free Git URL",
      input: { git: "https://GitHub.com/tako0614/takos.git/" },
      expected: { git: "https://github.com/tako0614/takos" },
    },
    {
      name: "keeps and canonicalizes the module the listing reviewed",
      input: {
        git: "https://github.com/tako0614/takos",
        path: "deploy/opentofu/cloudflare/",
      },
      expected: {
        git: "https://github.com/tako0614/takos",
        path: "deploy/opentofu/cloudflare",
      },
    },
    {
      name: "canonicalizes every root module spelling to dot",
      input: { git: "https://github.com/tako0614/takos", path: "./" },
      expected: { git: "https://github.com/tako0614/takos", path: "." },
    },
    {
      name: "rejects a module path that escapes the repository",
      input: { git: "https://github.com/tako0614/takos", path: "../secret" },
      expected: undefined,
    },
    {
      name: "rejects refs and install configuration",
      input: { git: "https://github.com/tako0614/takos", ref: "main" },
      expected: undefined,
    },
    {
      name: "rejects credentials and query strings",
      input: { git: "https://user:secret@example.com/takos.git?ref=main" },
      expected: undefined,
    },
    {
      name: "rejects URL serializer-only authorities and path spellings",
      input: { git: "https://[2001:db8::1]/tako" },
      expected: undefined,
    },
    {
      name: "rejects percent, Unicode, and dot path segments",
      input: { git: "https://github.com/tako/%2e%2e/秘密" },
      expected: undefined,
    },
  ];
