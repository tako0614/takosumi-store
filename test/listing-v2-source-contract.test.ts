import { describe, expect, test } from "bun:test";
import { TCS_V2_LISTING_SOURCE_FIXTURES } from "../spec/fixtures/listing-v2.ts";
import {
  parseTcsV2ListingSource,
  tcsV2ListingSourceIdentity,
} from "../spec/v2/listing-source.ts";
import { canonicalTcsGitUrl } from "../spec/listing-source.ts";

describe("TCS 2.0 source fixtures", () => {
  for (const fixture of TCS_V2_LISTING_SOURCE_FIXTURES) {
    test(fixture.name, () => {
      expect(parseTcsV2ListingSource(fixture.input)).toEqual(fixture.expected);
    });
  }
});

test("v2 identity stays the canonical Git URL, not a module path", () => {
  const source = parseTcsV2ListingSource({
    git: "https://github.com/tako0614/takos.git/",
    path: "deploy/opentofu/cloudflare",
  });
  expect(source).toEqual({
    git: "https://github.com/tako0614/takos",
    path: "deploy/opentofu/cloudflare",
  });
  expect(tcsV2ListingSourceIdentity(source)).toBe(
    "https://github.com/tako0614/takos",
  );
});

test("Git URL trimming and scheme matching are ASCII-only", () => {
  expect(canonicalTcsGitUrl(" https://github.com/tako/app ")).toBe(
    "https://github.com/tako/app",
  );
  expect(canonicalTcsGitUrl("HTTPS://GITHUB.COM/tako/app")).toBe(
    "https://github.com/tako/app",
  );
  for (const wrapped of [
    "\u00a0https://github.com/tako/app\u00a0",
    "\ufeffhttps://github.com/tako/app\ufeff",
    "\u2003https://github.com/tako/app\u2003",
    "http\u017f://github.com/tako/app",
  ]) {
    expect(canonicalTcsGitUrl(wrapped)).toBeUndefined();
  }
});
