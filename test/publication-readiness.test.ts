import { describe, expect, test } from "bun:test";

const root = `${import.meta.dir}/..`;
const read = (path: string): Promise<string> =>
  Bun.file(`${root}/${path}`).text();

describe("public repository contract", () => {
  test("keeps package, runtime, and Capsule versions aligned", async () => {
    const packageJson = JSON.parse(await read("package.json")) as {
      name: string;
      version: string;
      private: boolean;
      license: string;
    };
    const runtimeVersion = await read("src/backend/version.ts");
    const outputs = await read("outputs.tf");
    const lockfile = await read("bun.lock");

    expect(packageJson).toMatchObject({
      name: "@takosjp/takosumi-store",
      version: "0.1.10",
      private: true,
      license: "AGPL-3.0-only",
    });
    expect(runtimeVersion).toContain(
      `STORE_VERSION = "${packageJson.version}"`,
    );
    expect(outputs).toContain(`version = "${packageJson.version}"`);
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

    expect(readme).toContain("server-selection trust");
    expect(readme).toContain("`{ git, path }`");
    expect(readme).not.toContain("commit-pin only");
    expect(readme).not.toContain("declared output allowlist");
  });
});
