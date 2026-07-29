import { describe, expect, test } from "bun:test";

const root = `${import.meta.dir}/..`;
const read = (path: string): Promise<string> =>
  Bun.file(`${root}/${path}`).text();

describe("public repository contract", () => {
  test("keeps package and runtime versions aligned without claiming a fake Capsule", async () => {
    const packageJson = JSON.parse(await read("package.json")) as {
      name: string;
      version: string;
      private: boolean;
      license: string;
    };
    const runtimeVersion = await read("src/backend/version.ts");
    const lockfile = await read("bun.lock");

    expect(packageJson).toMatchObject({
      name: "@takosjp/takosumi-store",
      version: "0.1.14",
      private: true,
      license: "AGPL-3.0-only",
    });
    expect(runtimeVersion).toContain(
      `STORE_VERSION = "${packageJson.version}"`,
    );
    expect(await Bun.file(`${root}/outputs.tf`).exists()).toBe(false);
    expect(lockfile).toContain(`"name": "${packageJson.name}"`);
  });

  test("ships the intended split licenses and font notices", async () => {
    expect(await read("LICENSE")).toContain(
      "SPDX-License-Identifier: AGPL-3.0-only",
    );
    expect(await read("spec/LICENSE")).toContain("MIT License");

    const notices = await read("web/public/THIRD_PARTY_NOTICES.txt");
    expect(notices).toContain("The Bricolage Grotesque Project Authors");
    expect(notices).toContain("The JetBrains Mono Project Authors");
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  test("keeps realized operator identifiers out of public config", async () => {
    const wrangler = await read("wrangler.toml");

    expect(wrangler).toContain('APP_URL = "https://store.example.com"');
    expect(wrangler.match(/^database_id = "([^"]+)"$/m)?.[1]).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(wrangler.match(/^id = "([^"]+)"$/m)?.[1]).toBe(
      "00000000000000000000000000000000",
    );
  });

  test("documents TCS listings as presentation, not install authority", async () => {
    const readme = await read("README.md");
    const deploy = await read("docs/deploy.md");
    const spec = await read("docs/SPEC.md");

    expect(readme).toContain("server-selection trust");
    expect(readme).toContain("`{ git, path }`");
    expect(readme).toContain("`.well-known/tcs.json`");
    expect(readme).toContain("`.well-known/takosumi.json`");
    expect(readme).toContain(
      "The Store does not read, validate, persist, return, merge, or",
    );
    expect(spec).toContain("That file is not\npart of TCS");
    expect(spec).toContain(
      "A Store MUST NOT read, validate, proxy, persist, return, merge, or",
    );
    expect(spec).toContain(
      "Switching Store\nnodes therefore cannot change effective install configuration",
    );
    expect(readme).not.toContain("package-as-Capsule");
    expect(deploy).not.toContain("Install as a Capsule");
    expect(readme).not.toContain("commit-pin only");
    expect(readme).not.toContain("declared output allowlist");
  });

  test("removes retired install authority columns through a forward migration", async () => {
    const schema = await read("src/backend/db/schema.ts");
    const migration = await read(
      "migrations/0007_listing_authority_boundary.sql",
    );

    for (const retired of [
      "resolvedCommit",
      "installExperience",
      "outputAllowlist",
      'text("inputs")',
      'text("ref")',
    ]) {
      expect(schema).not.toContain(retired);
    }
    expect(migration).toContain("ALTER TABLE listings_v2 RENAME TO listings");
    expect(migration).not.toContain("resolved_commit");
    expect(migration).not.toContain("output_allowlist");
    expect(migration).not.toContain("install_experience");
  });
});
