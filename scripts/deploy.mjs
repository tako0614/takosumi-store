#!/usr/bin/env bun

// takosumi-store の唯一の deploy entrypoint です。
//
// 共通の obligation と trigger は takos-control の
// `engineering.policy.json` → `deploy` が正本です。
//
//   bun run deploy -- takosumi-store-worker
//
// この surface が publish するのは **Worker の code だけ** です。durable store
// (D1 / KV / R2) には触れません。schema 変更は `irreversible` な別の作業で、この
// entrypoint の副作用として起きてはいけないからです。
//
// `deploy:self-host` は利用者が自分の infrastructure に対して走らせる別物で、
// 公式 store.takosumi.com を拒否します。contract の otherProviderScripts で宣言済み。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_GATE = "bun run check";

const W = {
  surface: "takosumi-store-worker",
  worker: "takosumi-store",
  config: "wrangler.toml",
};
const L = {
  surface: "takosumi-store-official-listings",
};

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: W.surface,
      target: `cloudflare-worker:${W.worker}`,
      covers: ["wrangler.toml", "wrangler.local.toml"],
      requiresScripts: ["check"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: ["TAKOSUMI_STORE_WRANGLER_CONFIG"],
      // code だけを差し替えます。直前の version がそのまま戻し先として残るので
      // irreversible は立ちません。durable store の schema を変える作業は
      // この surface ではなく、別の deliberate な手順です。
      triggers: [],
      obligations: {
        provenance: `refuses a dirty worktree, runs \`${OWNER_GATE}\`, then builds the candidate through wrangler's own bundler with \`--dry-run --outdir\` and records the commit and the sha256 of that exact bundle, so the recorded digest names the bytes that ship rather than a side artifact It takes the operator's realized deploy config from TAKOSUMI_STORE_WRANGLER_CONFIG and refuses to publish a config that still holds a self-host template placeholder.`,
        "post-conditions":
          "reads the public listing API at https://store.takosumi.com/tcs/v1/listings on the deployed Worker and requires JSON, rather than trusting a health endpoint",
        reversal: `the current version id is read and printed before publishing; restore it with \`wrangler versions list --name ${W.worker}\` and \`wrangler versions deploy <previous-id>@100%\``,
        "failure-handling":
          "prints the provider's own stdout and stderr, names whether the failure was before or after publication, and on a failed post-condition exits non-zero naming the previous version instead of retrying",
      },
    },
    {
      surface: L.surface,
      target: "cloudflare-d1:takosumi-store-db:official-listings",
      covers: [
        "scripts/load-official-listings.ts",
        "scripts/official-listing-source.ts",
      ],
      requiresScripts: ["check"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: [
        "TAKOSUMI_STORE_WRANGLER_CONFIG",
        "TAKOSUMI_STORE_OFFICIAL_DATABASE_ID",
        "TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_COMMIT",
        "TAKOSUMI_STORE_OFFICIAL_LISTINGS_REVIEW_SHA256",
        "TAKOSUMI_STORE_RELEASE_STATE_DIR",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          "requires a clean main exactly equal to origin/main, runs bun run check, renders the manifest-only SQL twice, and requires its exact SHA-256 to match an independently reviewed digest",
        "post-conditions":
          "reads every official listing through https://store.takosumi.com and compares the public projection with the reviewed manifest",
        reversal:
          "captures the exact pre-mutation official rows and writes mode-0600 rollback SQL before changing D1",
        "failure-handling":
          "refuses target or digest drift before mutation; after mutation starts, it never retries or auto-rolls back and prints the exact snapshot and rollback paths for reconciliation",
        "independent-review":
          "the exact Git commit and candidate SQL SHA-256 must be supplied after a reviewer inspects the source, generated SQL, and public expectations",
      },
    },
  ],
  otherProviderScripts: [
    {
      script: "deploy:self-host",
      why: "A wrapper a self-hoster runs against infrastructure they own. It refuses the official store.takosumi.com target, the official custom-domain route, and the public official D1, KV, and R2 names.",
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (requested.length !== 1 || ![W.surface, L.surface].includes(requested[0])) {
  process.stderr.write(
    `usage: bun run deploy -- <${W.surface}|${L.surface}>\n`,
  );
  process.exit(1);
}
if (requested[0] === L.surface) {
  execFileSync("bun", ["scripts/deploy-official-listings.ts"], {
    cwd: repo,
    stdio: "inherit",
  });
  process.exit(0);
}

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
}
const git = (...a) =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const run = (c, a) =>
  execFileSync(c, a, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const digest = (b) => createHash("sha256").update(b).digest("hex");

// operator の realized config を要求します。repo に入っている wrangler config は
// self-host 向けの template で、`example.com` のような placeholder を含みます。
// それを本番と取り違えて publish しないよう、placeholder が残っていたら止めます。
const CONFIG_ENV = "TAKOSUMI_STORE_WRANGLER_CONFIG";
const configPath = process.env[CONFIG_ENV] ?? W.config;
if (!existsSync(resolve(repo, configPath)) && !existsSync(configPath)) {
  die(
    `deploy config ${configPath} does not exist; set ${CONFIG_ENV} to the operator's realized config`,
  );
}
const configSource = readFileSync(
  existsSync(resolve(repo, configPath))
    ? resolve(repo, configPath)
    : configPath,
  "utf8",
);
// Only values count. The word "replace" appears in the explanatory comments of a
// self-host template, and matching it there blocked a config that was fine.
const configValues = configSource
  .split("\n")
  .filter((line) => !/^\s*(?:#|\/\/)/u.test(line))
  .join("\n");
const placeholder =
  /(?:[=:]\s*["']?[^"'\n]*)(example\.com|REPLACE_[A-Z_]+|<[a-z-]+>|xxxxx)/iu.exec(
    configValues,
  );
if (placeholder) {
  die(
    `${configPath} still contains the self-host template placeholder ${JSON.stringify(placeholder[1])}; ` +
      `set ${CONFIG_ENV} to the operator's realized config instead of publishing the template`,
  );
}

// provenance
const dirty = git("status", "--porcelain");
if (dirty !== "") {
  die(
    "the worktree is not clean; the published bundle must belong to one commit",
    dirty.split("\n").slice(0, 20),
  );
}
const commit = git("rev-parse", "HEAD");
process.stdout.write(
  `source ${commit} (${git("rev-parse", "--abbrev-ref", "HEAD")})\n`,
);

process.stdout.write(`\n==> ${OWNER_GATE}\n`);
execFileSync("bun", ["run", "check"], { cwd: repo, stdio: "inherit" });

// wrangler bundles from `main` in the config, so an esbuild artifact sitting in
// dist/ is not what gets uploaded. Build once through wrangler's own bundler and
// digest that, so the recorded digest is the bytes that ship.
const outDir = mkdtempSync(join(tmpdir(), "deploy-bundle-"));
process.stdout.write(`\n==> wrangler deploy --dry-run --outdir ${outDir}\n`);
try {
  run("wrangler", [
    "deploy",
    "--dry-run",
    "--outdir",
    outDir,
    "--config",
    configPath,
  ]);
} catch (error) {
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
  die("the candidate bundle could not be built; production is untouched");
}
const bundleFile = readdirSync(outDir).find((name) => name.endsWith(".js"));
if (!bundleFile) die(`wrangler produced no bundle in ${outDir}`);
const bundleDigest = digest(readFileSync(join(outDir, bundleFile)));
process.stdout.write(
  `\ncandidate ${bundleFile} sha256 ${bundleDigest.slice(0, 16)}\n`,
);

// reversal: 戻し先の version を先に読む。読めなければ publish しない。
let previous = null;
try {
  const listed = run("wrangler", [
    "versions",
    "list",
    "--name",
    W.worker,
    "--config",
    configPath,
  ]);
  previous =
    listed.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u,
    )?.[1] ?? null;
} catch (error) {
  die(`cannot read the current version list: ${error.message}`);
}
if (!previous)
  die("no current version was readable, so there is no revert point");
process.stdout.write(`previous version ${previous}\n`);

process.stdout.write(`\n==> publishing ${W.worker}\n`);
let output;
try {
  output = run("wrangler", ["deploy", "--config", configPath]);
} catch (error) {
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
  die(
    "publication failed; production may be unchanged or partially updated. " +
      `Reconcile against version ${previous} before retrying.`,
  );
}
process.stdout.write(output);

// post-conditions: 実利用者の経路が通ることまで確認する。
let postOk = false;
let postDetail = null;
try {
  const probeUrl = "https://store.takosumi.com/tcs/v1/listings";
  process.stdout.write(`\n==> GET ${probeUrl}\n`);
  const response = await fetch(probeUrl, { headers: {}, redirect: "follow" });
  const body = await response.text();
  if (!response.ok) throw new Error(`${probeUrl} responded ${response.status}`);
  if (!body.trim().startsWith("{") && !body.trim().startsWith("["))
    throw new Error("listings did not return JSON");
  postDetail = `${probeUrl} → ${response.status}, ${body.length} bytes`;
  process.stdout.write(`${postDetail}\n`);
  postOk = true;
} catch (error) {
  postDetail = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`;
  process.stderr.write(`${postDetail}\n`);
  postOk = false;
}

const result = {
  kind: "takos.deploy-result@v1",
  surface: W.surface,
  target: `cloudflare-worker:${W.worker}`,
  commit,
  bundleDigest,
  previousVersion: previous,
  postConditions: postOk ? "PASSED" : "FAILED",
  status: postOk ? "PUBLISHED" : "INDETERMINATE",
};
process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);

if (!postOk) {
  process.stderr.write(
    `\nthe new version is live on ${W.worker} but the post-conditions did not pass. ` +
      `Do not retry blindly: read \`wrangler versions list --name ${W.worker}\` and decide whether to ` +
      `roll back to ${previous}.\n`,
  );
  process.exit(1);
}
