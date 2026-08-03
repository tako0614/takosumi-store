import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { canonicalTcsGitUrl } from "../spec/listing-source.ts";

const migrations = `${import.meta.dir}/../migrations`;

function statements(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function apply(client: ReturnType<typeof createClient>, name: string) {
  const text = await readFile(`${migrations}/${name}`, "utf8");
  for (const statement of statements(text)) {
    await client.execute(statement);
  }
}

const PRE_V2_MIGRATIONS = [
  "0001_init.sql",
  "0002_accounts.sql",
  "0003_scope_slug.sql",
  "0004_tags.sql",
  "0005_install_experience.sql",
  "0006_source_identity.sql",
  "0007_listing_authority_boundary.sql",
  "0008_moderation_limits.sql",
] as const;

async function applyPreV2(client: ReturnType<typeof createClient>) {
  for (const name of PRE_V2_MIGRATIONS) await apply(client, name);
}

describe("forward authority-boundary migrations", () => {
  test("preserve rows, canonicalize source identity, and remove retired columns", async () => {
    const client = createClient({ url: ":memory:" });
    for (const name of [
      "0001_init.sql",
      "0002_accounts.sql",
      "0003_scope_slug.sql",
      "0004_tags.sql",
      "0005_install_experience.sql",
      "0006_source_identity.sql",
    ]) {
      await apply(client, name);
    }
    await client.execute({
      sql: `INSERT INTO listings (
        id, scope, slug, git, ref, resolved_commit, path, kind, surface,
        provider, category, tags, suggested_name, name_ja, name_en,
        inputs, install_experience, output_allowlist, status, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "alice/app",
        "alice",
        "app",
        "https://github.com/acme/app.git/",
        "main",
        "a".repeat(40),
        "/modules/app/",
        "worker",
        "service",
        "cloudflare",
        "tools",
        "[]",
        "app",
        "App",
        "App",
        "[]",
        "{}",
        "[]",
        "hidden",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      ],
    });
    await client.execute({
      sql: `INSERT INTO reports (
        id, listing_id, reporter_sub, reason, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        "rpt-1",
        "alice/app",
        "raw-oidc-sub",
        "spam",
        "open",
        "2026-01-02T00:00:00.000Z",
      ],
    });

    await apply(client, "0007_listing_authority_boundary.sql");
    await apply(client, "0008_moderation_limits.sql");

    const listing = await client.execute(
      "SELECT id, git, path, status, created_at FROM listings",
    );
    expect(listing.rows).toHaveLength(1);
    expect(listing.rows[0]?.id).toBe("alice/app");
    expect(listing.rows[0]?.git).toBe("https://github.com/acme/app");
    expect(listing.rows[0]?.path).toBe("modules/app");
    expect(listing.rows[0]?.status).toBe("hidden");
    expect(listing.rows[0]?.created_at).toBe("2026-01-01T00:00:00.000Z");
    const listingColumns = (
      await client.execute("PRAGMA table_info(listings)")
    ).rows.map((row) => row.name);
    for (const retired of [
      "ref",
      "resolved_commit",
      "inputs",
      "install_experience",
      "output_allowlist",
    ]) {
      expect(listingColumns).not.toContain(retired);
    }

    const reportColumns = (
      await client.execute("PRAGMA table_info(reports)")
    ).rows.map((row) => row.name);
    expect(reportColumns).not.toContain("reporter_sub");
    expect(reportColumns).toContain("reporter_key");
    expect(
      (await client.execute("SELECT reason FROM reports")).rows[0]?.reason,
    ).toBe("spam");
    client.close();
  });

  test("v2 Git identity migration fails closed on duplicate repositories", async () => {
    const client = createClient({ url: ":memory:" });
    await applyPreV2(client);
    await client.execute(`
      INSERT INTO listings (
        id, scope, slug, git, path, kind, surface, provider, category, tags,
        suggested_name, name_ja, name_en, description_ja, description_en,
        badge_ja, badge_en, status, created_at, updated_at
      ) VALUES (
        'one/app', 'one', 'app', 'https://github.com/acme/app', 'first',
        'worker', 'service', 'catalog', 'tools', '[]', 'app', 'App', 'App',
        '', '', '', '', 'visible', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `);
    await client.execute(`
      INSERT INTO listings (
        id, scope, slug, git, path, kind, surface, provider, category, tags,
        suggested_name, name_ja, name_en, description_ja, description_en,
        badge_ja, badge_en, status, created_at, updated_at
      ) VALUES (
        'two/app', 'two', 'app', 'https://github.com/acme/app', 'second',
        'worker', 'service', 'catalog', 'tools', '[]', 'app', 'App', 'App',
        '', '', '', '', 'visible', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `);
    await expect(apply(client, "0009_v2_git_identity.sql")).rejects.toThrow();
    const columns = (
      await client.execute("PRAGMA table_info(listings)")
    ).rows.map((row) => row.name);
    expect(columns).not.toContain("git_identity");
    client.close();
  });

  test("v2 audit folds host case, default port, slash, and .git without folding path case", async () => {
    const client = createClient({ url: ":memory:" });
    await applyPreV2(client);
    await client.execute({
      sql: `INSERT INTO listings (
        id, scope, slug, git, path, kind, surface, provider, category, tags,
        suggested_name, name_ja, name_en, description_ja, description_en,
        badge_ja, badge_en, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', 'worker', 'service', 'catalog', 'tools', '[]',
        'app', 'App', 'App', '', '', '', '', 'visible', '2026', '2026')`,
      args: [
        "one/app",
        "one",
        "app",
        "https://GitHub.com:0443/acme/CaseSensitive.git/",
      ],
    });
    await apply(client, "0009_v2_git_identity.sql");
    const row = (await client.execute("SELECT git, git_identity FROM listings"))
      .rows[0];
    expect(row?.git).toBe("https://github.com/acme/CaseSensitive");
    expect(row?.git_identity).toBe("https://github.com/acme/CaseSensitive");
    client.close();
  });

  test("v2 audit rejects canonical collisions across host/port/path spelling", async () => {
    const client = createClient({ url: ":memory:" });
    await applyPreV2(client);
    for (const [id, git] of [
      ["one/app", "https://GitHub.com:443/acme/Case.git/"],
      ["two/app", "https://github.com/acme/Case"],
    ] as const) {
      await client.execute({
        sql: `INSERT INTO listings (
          id, scope, slug, git, path, kind, surface, provider, category, tags,
          suggested_name, name_ja, name_en, description_ja, description_en,
          badge_ja, badge_en, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', 'worker', 'service', 'catalog', 'tools', '[]',
          'app', 'App', 'App', '', '', '', '', 'visible', '2026', '2026')`,
        args: [id, id.split("/")[0], "app", git],
      });
    }
    await expect(apply(client, "0009_v2_git_identity.sql")).rejects.toThrow();
    client.close();
  });

  test("v2 backfill matches the URL parser for path and authority normalization", async () => {
    const cases = [
      "https://GitHub.com:0443/acme/Case.git/",
      "HTTPS://GITHUB.COM/acme/Upper",
      "https://github.com/acme/foo.bar/Baz",
      "https://github.com/acme/.foo",
      "https://github.com/acme/Case_Name-~",
      " https://github.com/acme/AsciiSpace ",
    ];
    for (const [index, git] of cases.entries()) {
      const client = createClient({ url: ":memory:" });
      await applyPreV2(client);
      await client.execute({
        sql: `INSERT INTO listings (
          id, scope, slug, git, path, kind, surface, provider, category, tags,
          suggested_name, name_ja, name_en, description_ja, description_en,
          badge_ja, badge_en, status, created_at, updated_at
        ) VALUES (?, 'test', ?, ?, '', 'worker', 'service', 'catalog', 'tools', '[]',
          'app', 'App', 'App', '', '', '', '', 'visible', '2026', '2026')`,
        args: [`test/edge-${index}`, `edge-${index}`, git],
      });
      await apply(client, "0009_v2_git_identity.sql");
      const row = (await client.execute("SELECT git_identity FROM listings"))
        .rows[0];
      expect(row?.git_identity).toBeDefined();
      expect(row?.git_identity as string).toBe(
        canonicalTcsGitUrl(git) as string,
      );
      client.close();
    }
  });

  test("v2 audit rejects credentials, query strings, and fragments", async () => {
    for (const [index, git] of [
      "https://user:password@github.com/acme/app",
      "https://github.com/acme/app?ref=main",
      "https://github.com/acme/app#readme",
      "https://github.com/acme/app\\nested",
      "https://[2001:db8::1]/acme/app",
      "https://例え.テスト/acme/app",
      "https://github.com/acme/%20app",
      "https://github.com/acme/a/../b",
      "https://github.com/acme/a//b",
      "https://github.com/.git",
      "https://github.com/acme/..git",
      "https://github.com/acme/@path",
      "https://github.com/acme/a<b>",
      "\u00a0https://github.com/acme/app\u00a0",
      "\ufeffhttps://github.com/acme/app\ufeff",
      "\u2003https://github.com/acme/app\u2003",
      "http\u017f://github.com/acme/app",
    ].entries()) {
      const client = createClient({ url: ":memory:" });
      await applyPreV2(client);
      await client.execute({
        sql: `INSERT INTO listings (
          id, scope, slug, git, path, kind, surface, provider, category, tags,
          suggested_name, name_ja, name_en, description_ja, description_en,
          badge_ja, badge_en, status, created_at, updated_at
        ) VALUES (?, 'test', ?, ?, '', 'worker', 'service', 'catalog', 'tools', '[]',
          'app', 'App', 'App', '', '', '', '', 'visible', '2026', '2026')`,
        args: [`test/${index}`, `app-${index}`, git],
      });
      await expect(apply(client, "0009_v2_git_identity.sql")).rejects.toThrow();
      client.close();
    }
  });
});
