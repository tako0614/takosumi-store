import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  canonicalCollisionAuditSql,
  migrationManifest,
  requireMigrationPrefix,
  parseRealizedConfig,
  realizedOrigin,
  verifySchemaMigrationProjection,
} from "../scripts/deploy-runtime.mjs";

const repo = join(import.meta.dir, "..");

describe("Store deploy entrypoint", () => {
  test("answers the contract without touching a target", () => {
    const raw = execFileSync("bun", ["run", "deploy", "--", "--contract"], {
      cwd: repo,
      encoding: "utf8",
    });
    const contract = JSON.parse(raw.slice(raw.indexOf("{"))) as {
      surfaces: { surface: string; triggers: string[] }[];
    };
    const worker = contract.surfaces.find(
      (entry) => entry.surface === "takosumi-store-worker",
    );
    const schema = contract.surfaces.find(
      (entry) => entry.surface === "takosumi-store-schema-current",
    );
    expect(worker?.triggers).toEqual([]);
    expect(schema?.triggers).toEqual(["irreversible", "authority"]);
  });

  test("uses the realized staging config for both worker and origin", () => {
    const realized = parseRealizedConfig(`
name = "store-staging-a"
[vars]
APP_URL = "https://staging-a.takosumi.example.net"
[[d1_databases]]
binding = "DB"
database_name = "store-staging-a-db"
database_id = "stage-a"
[[routes]]
pattern = "staging-a.takosumi.example.net"
`);
    expect(realized.workerName).toBe("store-staging-a");
    expect(realized.configOrigin).toBe(
      "https://staging-a.takosumi.example.net",
    );
    expect(realized.databaseId).toBe("stage-a");
    expect(() =>
      realizedOrigin("http://staging-a.takosumi.example.net"),
    ).toThrow("HTTPS");
    expect(
      readFileSync(join(repo, "scripts/deploy.mjs"), "utf8"),
    ).not.toContain("--name");
    const source = readFileSync(join(repo, "scripts/deploy.mjs"), "utf8");
    const workerImplementation = source.slice(
      source.indexOf("async function deployWorker"),
      source.indexOf("function assertReviewIdentity"),
    );
    expect(workerImplementation).not.toContain("store.takosumi.com");
  });

  test("replays Wrangler's executable outdir bundle without rebundling", () => {
    const wrangler = join(repo, "node_modules/.bin/wrangler");
    expect(existsSync(wrangler)).toBe(true);
    const fixture = mkdtempSync(
      join(tmpdir(), "takosumi-store-wrangler-test-"),
    );
    const assets = join(fixture, "assets");
    const firstOutdir = join(fixture, "first");
    const secondOutdir = join(fixture, "second");
    mkdirSync(assets, { mode: 0o700 });
    mkdirSync(firstOutdir, { mode: 0o700 });
    mkdirSync(secondOutdir, { mode: 0o700 });
    writeFileSync(
      join(fixture, "index.js"),
      'export default { fetch() { return new Response("ok"); } };\n',
    );
    writeFileSync(join(assets, "index.html"), "<!doctype html>fixture\n");
    try {
      const common = [
        "--assets",
        assets,
        "--dry-run",
        "--config",
        join(repo, "wrangler.toml"),
      ];
      execFileSync(
        wrangler,
        [
          "deploy",
          join(fixture, "index.js"),
          ...common,
          "--outdir",
          firstOutdir,
        ],
        { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const bundles = readdirSync(firstOutdir).filter(
        (name) => name === "index.js",
      );
      expect(bundles).toEqual(["index.js"]);
      const firstBundle = join(firstOutdir, "index.js");
      execFileSync(
        wrangler,
        [
          "deploy",
          firstBundle,
          "--no-bundle",
          ...common,
          "--outdir",
          secondOutdir,
        ],
        { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(readFileSync(firstBundle)).toEqual(
        readFileSync(join(secondOutdir, "index.js")),
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("collision preflight is read-only and blocks canonical duplicates", () => {
    const sql = canonicalCollisionAuditSql();
    expect(sql).toContain("GROUP BY git_identity HAVING COUNT(*) > 1");
    expect(sql).toContain("'collision'");
    expect(sql).toMatch(/^WITH RECURSIVE/);
    expect(sql).not.toMatch(/\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/u);
  });

  test("requires the exact pending suffix and reviews its canonical manifest", () => {
    const pending = requireMigrationPrefix(
      [
        "0001_init.sql",
        "0007_listing_authority_boundary.sql",
        "0009_v2_git_identity.sql",
      ],
      [{ name: "0001_init.sql" }],
    );
    expect(pending).toEqual([
      "0007_listing_authority_boundary.sql",
      "0009_v2_git_identity.sql",
    ]);
    const manifest = migrationManifest(
      pending.map((name) => ({ name, bytes: `${name}\n` })),
    );
    expect(manifest).toContain('"name":"0007_listing_authority_boundary.sql"');
    expect(() =>
      requireMigrationPrefix(
        ["0001_init.sql", "0007_listing_authority_boundary.sql"],
        [
          { name: "0001_init.sql" },
          { name: "0007_listing_authority_boundary.sql" },
        ],
      ),
    ).toThrow("already contains");
  });

  test("only projects rows for migrations in the pending suffix", () => {
    const beforeListings = [
      { id: "listing", git: "https://github.com/tako/store", path: "" },
    ];
    const afterListings = [
      {
        ...beforeListings[0],
        git_identity: "https://github.com/tako/store",
      },
    ];
    const retainedReport = {
      id: "report",
      listing_id: "listing",
      reporter_key: "opaque-key",
      reason_digest: "digest",
      reason: "reason",
      status: "open",
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(
      verifySchemaMigrationProjection({
        pendingMigrations: ["0009_v2_git_identity.sql"],
        beforeListings,
        afterListings,
        beforeReports: [retainedReport],
        afterReports: [{ ...retainedReport }],
        beforeReportRateLimits: [
          {
            reporter_key: "opaque-key",
            bucket_start: "2026-01-01T00:00:00Z",
            count: 1,
          },
        ],
        afterReportRateLimits: [
          {
            reporter_key: "opaque-key",
            bucket_start: "2026-01-01T00:00:00Z",
            count: 1,
          },
        ],
      }),
    ).toMatchObject({ listings: 1, reports: 1, reportRateLimits: 1 });

    expect(() =>
      verifySchemaMigrationProjection({
        pendingMigrations: ["0008_moderation_limits.sql"],
        beforeListings: null,
        afterListings: null,
        beforeReports: [
          {
            id: "report",
            listing_id: "listing",
            reporter_sub: "sub",
            reason: "reason",
            status: "open",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        afterReports: [
          {
            id: "report",
            listing_id: "listing",
            reporter_key: "legacy:report",
            reason_digest: "",
            reason: "reason",
            status: "open",
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "unexpected",
            listing_id: "listing",
            reporter_key: "legacy:unexpected",
            reason_digest: "",
            reason: "reason",
            status: "open",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    ).toThrow("row count changed");
  });
});
