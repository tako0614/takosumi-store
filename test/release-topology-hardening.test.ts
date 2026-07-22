import { describe, expect, test } from "bun:test";

import {
  readRuntimeTopology,
  type CloudflareReadClient,
  type TargetPolicy,
} from "../scripts/store-release-common.ts";

function target(overrides: Partial<TargetPolicy> = {}): TargetPolicy {
  return {
    configPath: "store/wrangler.production.toml",
    accountId: "a".repeat(32),
    workerName: "takosumi-store",
    origin: "https://store.takosumi.com",
    databaseName: "takosumi-store-db",
    databaseId: "00000000-0000-4000-8000-000000000001",
    kvNamespaceId: "b".repeat(32),
    iconsBucketName: "takosumi-store-icons",
    publishCapability: true,
    compatibilityDate: "2026-06-25",
    compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
    requiredVarNames: ["APP_URL"],
    requiredSecretNames: [],
    customDomainHostname: "store.takosumi.com",
    readbackListingPath: "/tcs/v1/listings/tako/takos",
    ...overrides,
  };
}

function client(response: CloudflareReadClient["get"]): CloudflareReadClient {
  return { accountId: "a".repeat(32), get: response };
}

describe("runtime topology readback", () => {
  test("binds an exact custom domain to the promoted Worker service", async () => {
    const exact = client(async () => ({
      status: "ok",
      result: [
        {
          id: "domain-id",
          hostname: "store.takosumi.com",
          service: "takosumi-store",
          environment: "production",
          zone_id: "zone-id",
        },
      ],
      resultInfo: null,
    }));
    await expect(
      readRuntimeTopology(exact, target(), "custom-domain"),
    ).resolves.toMatchObject({
      hostname: "store.takosumi.com",
      workerName: "takosumi-store",
    });
    const wrongOwner = client(async () => ({
      status: "ok",
      result: [
        {
          hostname: "store.takosumi.com",
          service: "decoy-worker",
        },
      ],
      resultInfo: null,
    }));
    await expect(
      readRuntimeTopology(wrongOwner, target(), "custom-domain"),
    ).rejects.toThrow("runtime_custom_domain_owner_mismatch");
    await expect(
      readRuntimeTopology(
        client(async () => ({ status: "not-found" })),
        target(),
        "custom-domain",
      ),
    ).rejects.toThrow("runtime_custom_domain_readback_missing");
    await expect(
      readRuntimeTopology(
        client(async () => ({
          status: "ok",
          result: [
            { hostname: "store.takosumi.com", service: "takosumi-store" },
            { hostname: "store.takosumi.com", service: "takosumi-store" },
          ],
          resultInfo: null,
        })),
        target(),
        "custom-domain",
      ),
    ).rejects.toThrow("runtime_custom_domain_readback_ambiguous");
  });

  test("derives the exact workers.dev origin and verifies script enablement", async () => {
    const worker = target({
      workerName: "store-replica-review",
      origin: "https://store-replica-review.account-subdomain.workers.dev",
      customDomainHostname:
        "store-replica-review.account-subdomain.workers.dev",
    });
    const exact = client(async (path) =>
      path.endsWith("/workers/subdomain")
        ? {
            status: "ok" as const,
            result: { subdomain: "account-subdomain" },
            resultInfo: null,
          }
        : {
            status: "ok" as const,
            result: { enabled: true, previews_enabled: false },
            resultInfo: null,
          },
    );
    await expect(
      readRuntimeTopology(exact, worker, "workers-dev"),
    ).resolves.toMatchObject({ hostname: worker.customDomainHostname });
    await expect(
      readRuntimeTopology(
        exact,
        { ...worker, origin: "https://unbound.example" },
        "workers-dev",
      ),
    ).rejects.toThrow("runtime_workers_dev_origin_mismatch");
    const disabled = client(async (path) =>
      path.endsWith("/workers/subdomain")
        ? {
            status: "ok" as const,
            result: { subdomain: "account-subdomain" },
            resultInfo: null,
          }
        : {
            status: "ok" as const,
            result: { enabled: false, previews_enabled: true },
            resultInfo: null,
          },
    );
    await expect(
      readRuntimeTopology(disabled, worker, "workers-dev"),
    ).rejects.toThrow("runtime_workers_dev_readback_mismatch");
  });
});
