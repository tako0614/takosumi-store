import { describe, expect, test } from "bun:test";
import {
  officialListingMetadataOverrides,
  officialListingSource,
} from "../scripts/official-listing-source.ts";

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

  test("does not apply root deployment semantics to an alternate module", () => {
    expect(
      officialListingMetadataOverrides(
        {
          git: "https://github.com/tako0614/yurucommu.git",
          path: "deploy/takoform",
        },
        {
          schemaVersion: "tcs.repo/v1",
          modulePath: ".",
          provider: "cloudflare",
          kind: "worker",
          surface: "service",
          description: {
            ja: "リポジトリの説明",
            en: "Repository description",
          },
        },
      ),
    ).toEqual({
      description: {
        ja: "リポジトリの説明",
        en: "Repository description",
      },
    });
  });

  test("applies deployment semantics to the exact selected module", () => {
    expect(
      officialListingMetadataOverrides(
        {
          git: "https://github.com/tako0614/takos.git",
          path: "deploy/opentofu",
        },
        {
          modulePath: "deploy/opentofu",
          provider: "cloudflare",
          kind: "worker",
          surface: "service",
          category: "workspace",
        },
      ),
    ).toEqual({
      category: "workspace",
      kind: "worker",
      surface: "service",
      provider: "cloudflare",
    });
  });
});
