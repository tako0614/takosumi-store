import { describe, expect, test } from "bun:test";
import { TCS_LISTING_SOURCE_FIXTURES } from "../spec/fixtures/listing-source.ts";
import { parseTcsListingSource } from "../spec/listing-source.ts";

describe("TCS listing source contract fixtures", () => {
  for (const fixture of TCS_LISTING_SOURCE_FIXTURES) {
    test(fixture.name, () => {
      expect(parseTcsListingSource(fixture.input)).toEqual(fixture.expected);
    });
  }
});
