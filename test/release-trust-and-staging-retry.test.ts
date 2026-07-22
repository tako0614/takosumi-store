import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STAGING_EDGE_HEALTH_ATTEMPTS,
  STAGING_EDGE_HEALTH_DELAY_MS,
  runWithStagingEdgePropagationRetry,
  verifyTrackedReleaseTagSignature,
} from "../scripts/store-release-common.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function git(root: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function signedRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "store-tag-trust-"));
  roots.push(root);
  await chmod(root, 0o700);
  execFileSync("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    join(root, "signer"),
  ]);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Store Release Test");
  git(root, "config", "user.email", "shoutatomiyama0614@gmail.com");
  await mkdir(join(root, "release/trust"), { recursive: true });
  const publicKey = (await readFile(join(root, "signer.pub"), "utf8"))
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .join(" ");
  await writeFile(
    join(root, "release/trust/allowed-signers"),
    `shoutatomiyama0614@gmail.com ${publicKey}\n`,
  );
  await writeFile(join(root, "source.txt"), "sealed\n");
  git(root, "add", "release/trust/allowed-signers", "source.txt");
  git(root, "commit", "-m", "test: sealed source");
  git(
    root,
    "-c",
    "gpg.format=ssh",
    "-c",
    `user.signingkey=${join(root, "signer")}`,
    "tag",
    "-s",
    "vtest",
    "-m",
    "signed test tag",
  );
  return root;
}

describe("tracked release tag trust", () => {
  test("ignores hostile repo/global-style signer configuration", async () => {
    const root = await signedRepository();
    git(root, "config", "gpg.format", "openpgp");
    git(root, "config", "gpg.ssh.program", "/bin/false");
    git(root, "config", "gpg.ssh.allowedSignersFile", "/dev/null");
    await expect(
      verifyTrackedReleaseTagSignature(root, "vtest"),
    ).resolves.toBeUndefined();
  });

  test("rejects modified and symlinked trust roots", async () => {
    const root = await signedRepository();
    const trust = join(root, "release/trust/allowed-signers");
    const copy = join(root, "allowed-signers-copy");
    await copyFile(trust, copy);
    await writeFile(trust, "attacker ssh-ed25519 AAAA\n");
    await expect(
      verifyTrackedReleaseTagSignature(root, "vtest"),
    ).rejects.toThrow("release_tag_trust_root_invalid");
    await rm(trust);
    await symlink(copy, trust);
    await expect(
      verifyTrackedReleaseTagSignature(root, "vtest"),
    ).rejects.toThrow("release_tag_trust_root_invalid");
  });

  test("keeps historical tags valid while accepting a rotated signer", async () => {
    const root = await signedRepository();
    execFileSync("/usr/bin/ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(root, "rotated-signer"),
    ]);
    const rotatedPublicKey = (
      await readFile(join(root, "rotated-signer.pub"), "utf8")
    )
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .join(" ");
    const trust = join(root, "release/trust/allowed-signers");
    await writeFile(
      trust,
      `${await readFile(trust, "utf8")}shoutatomiyama0614@gmail.com ${rotatedPublicKey}\n`,
    );
    git(root, "add", "release/trust/allowed-signers");
    git(root, "commit", "-m", "test: rotate release signer");
    git(
      root,
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${join(root, "rotated-signer")}`,
      "tag",
      "-s",
      "vnext",
      "-m",
      "rotated signed test tag",
    );
    await expect(
      verifyTrackedReleaseTagSignature(root, "vtest"),
    ).resolves.toBeUndefined();
    await expect(
      verifyTrackedReleaseTagSignature(root, "vnext"),
    ).resolves.toBeUndefined();
  });
});

describe("staging edge propagation retry", () => {
  test("retries the complete strict suite with the fixed cadence", async () => {
    let attempts = 0;
    let clock = 0;
    const waits: number[] = [];
    await expect(
      runWithStagingEdgePropagationRetry(
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("stale_edge_body");
          return "strict-current-body";
        },
        async (milliseconds) => {
          waits.push(milliseconds);
          clock += milliseconds;
        },
        () => clock,
      ),
    ).resolves.toBe("strict-current-body");
    expect(attempts).toBe(3);
    expect(waits).toEqual([
      STAGING_EDGE_HEALTH_DELAY_MS,
      STAGING_EDGE_HEALTH_DELAY_MS,
    ]);
  });

  test("fails closed at both the attempt ceiling and absolute deadline", async () => {
    let attempts = 0;
    await expect(
      runWithStagingEdgePropagationRetry(
        async () => {
          attempts += 1;
          throw new Error("permanent_semantic_mismatch");
        },
        async () => {},
        () => 0,
      ),
    ).rejects.toThrow("staging_edge_propagation_exhausted");
    expect(attempts).toBe(STAGING_EDGE_HEALTH_ATTEMPTS);

    let clock = 0;
    let deadlineAttempts = 0;
    await expect(
      runWithStagingEdgePropagationRetry(
        async (deadlineAtMs) => {
          deadlineAttempts += 1;
          clock = deadlineAtMs;
          throw new Error("slow_stale_edge");
        },
        async () => {},
        () => clock,
      ),
    ).rejects.toThrow("staging_edge_propagation_exhausted");
    expect(deadlineAttempts).toBe(1);
  });
});
