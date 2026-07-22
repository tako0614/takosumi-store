import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestJson, sha256Bytes } from "../scripts/store-release-common.ts";
import {
  runExactAbsentMutation,
  runExactPresentMutation,
} from "../scripts/store-release-replica-adapter.ts";
import {
  openReplicaMutationJournal,
  requireAttemptCreatedResource,
  validateReplicaMutationJournal,
  type ReplicaMutationDescriptor,
} from "../scripts/store-release-replica-mutation-journal.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  path: string;
  authority: {
    releaseId: string;
    replicaId: string;
    accountId: string;
    targetDigest: string;
    preflightAbsenceDigest: string;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "store-mutation-journal-"));
  roots.push(root);
  await chmod(root, 0o700);
  return {
    root,
    path: join(root, "worker-release-replica-mutation-journal.json"),
    authority: {
      releaseId: "store-v013-journal",
      replicaId: "replica-v013-journal",
      accountId: "a".repeat(32),
      targetDigest: `sha256:${"b".repeat(64)}`,
      preflightAbsenceDigest: `sha256:${"c".repeat(64)}`,
    },
  };
}

describe("replica retained mutation journal", () => {
  test("recovers a lost create response from exact live ID and never recreates", async () => {
    const value = await fixture();
    let journal = await openReplicaMutationJournal(value.path, value.authority);
    const descriptor: ReplicaMutationDescriptor = {
      id: "provision:d1:create",
      kind: "d1-create",
      resourceType: "d1",
      resourceName: "store-replica-v013-db",
      expectedDigest: digestJson({
        accountId: value.authority.accountId,
        name: "store-replica-v013-db",
        preflightAbsenceDigest: value.authority.preflightAbsenceDigest,
      }),
    };
    const databaseId = "10000000-0000-4000-8000-000000000001";
    let present = false;
    let creates = 0;
    const readback = async () => {
      if (!present) return null;
      const live = {
        accountId: value.authority.accountId,
        name: descriptor.resourceName,
        id: databaseId,
      };
      return {
        value: live,
        resourceId: databaseId,
        digest: digestJson(live),
      };
    };
    const first = await runExactPresentMutation({
      path: value.path,
      journal,
      descriptor,
      accountId: value.authority.accountId,
      createdOnly: true,
      readback,
      mutate: () => {
        creates += 1;
        present = true;
        throw new Error("injected_create_response_loss");
      },
    });
    journal = first.journal;
    expect(first.readback.resourceId).toBe(databaseId);
    expect(creates).toBe(1);
    expect(journal.operations[0]).toMatchObject({
      phase: "committed",
      receipt: {
        resourceId: databaseId,
        recovery: "lost-response",
        result: "exact-present",
        createdOnly: true,
      },
    });
    const retried = await runExactPresentMutation({
      path: value.path,
      journal,
      descriptor,
      accountId: value.authority.accountId,
      createdOnly: true,
      readback,
      mutate: () => {
        creates += 1;
        return "must-not-run";
      },
    });
    expect(retried.readback.resourceId).toBe(databaseId);
    expect(creates).toBe(1);
    expect(() =>
      requireAttemptCreatedResource(
        retried.journal,
        "d1-create",
        descriptor.resourceName,
        databaseId,
      ),
    ).not.toThrow();
  });

  test("records lost delete responses only after exact absence", async () => {
    const value = await fixture();
    let journal = await openReplicaMutationJournal(value.path, value.authority);
    const descriptor: ReplicaMutationDescriptor = {
      id: "cleanup:kv:delete",
      kind: "kv-delete",
      resourceType: "kv",
      resourceName: "store-replica-v013-kv",
      resourceId: "d".repeat(32),
      expectedDigest: `sha256:${"e".repeat(64)}`,
    };
    let present = true;
    let deletes = 0;
    journal = await runExactAbsentMutation({
      path: value.path,
      journal,
      descriptor,
      accountId: value.authority.accountId,
      readback: async () =>
        present
          ? {
              value: { id: descriptor.resourceId },
              resourceId: descriptor.resourceId,
              digest: digestJson({ id: descriptor.resourceId }),
            }
          : null,
      mutate: () => {
        deletes += 1;
        present = false;
        throw new Error("injected_delete_response_loss");
      },
    });
    expect(deletes).toBe(1);
    expect(journal.operations[0]).toMatchObject({
      phase: "committed",
      receipt: { recovery: "lost-response", result: "exact-absent" },
    });
  });

  test("rejects authority drift, foreign IDs, and changed committed readback", async () => {
    const value = await fixture();
    const journal = await openReplicaMutationJournal(
      value.path,
      value.authority,
    );
    expect(() =>
      validateReplicaMutationJournal(journal, {
        ...value.authority,
        accountId: "f".repeat(32),
      }),
    ).toThrow("replica_mutation_journal_authority_mismatch");
    expect(() =>
      requireAttemptCreatedResource(
        journal,
        "d1-create",
        "foreign-database",
        "10000000-0000-4000-8000-000000000009",
      ),
    ).toThrow("replica_cleanup_created_only_authority_missing");
    const intent = (
      id: string,
      kind: "worker-upload" | "d1-create",
      resourceType: "worker" | "d1",
    ) => ({
      descriptor: {
        id,
        kind,
        resourceType,
        resourceName: `${resourceType}-replica-v013`,
        expectedDigest: `sha256:${"9".repeat(64)}`,
      },
      phase: "intent-recorded" as const,
    });
    expect(() =>
      validateReplicaMutationJournal(
        {
          ...journal,
          operations: [
            intent("provision:worker:upload", "worker-upload", "worker"),
            intent("provision:d1:create", "d1-create", "d1"),
          ],
        },
        value.authority,
      ),
    ).toThrow("replica_mutation_order_invalid");
    expect(sha256Bytes(await readFile(value.path))).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });
});
