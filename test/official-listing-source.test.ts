import { describe, expect, test } from "bun:test";
import { officialListingSource } from "../scripts/official-listing-source.ts";

describe("official listing source authority", () => {
  test("keeps the reviewed manifest path when remote metadata disagrees", () => {
    expect(
      officialListingSource(
        {
          git: "https://github.com/tako0614/takos.git",
          path: "deploy/opentofu",
        },
        {
          schemaVersion: "tcs.repo/v1",
          modulePath: "../redirected-by-remote-head",
        },
      ),
    ).toEqual({
      git: "https://github.com/tako0614/takos.git",
      path: "deploy/opentofu",
    });
  });
});
