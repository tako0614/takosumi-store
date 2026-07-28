import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";

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
});
