import { dirname } from "node:path";

import {
  SURFACE_ID,
  canonicalJson,
  digestJson,
  isRecord,
  readPrivateJson,
  writePrivateJson,
  type JsonObject,
} from "./store-release-common.ts";

export const REPLICA_MUTATION_JOURNAL_FILE =
  "worker-release-replica-mutation-journal.json";

export type ReplicaMutationKind =
  | "d1-create"
  | "kv-create"
  | "r2-create"
  | "d1-migrations-apply"
  | "d1-snapshot-import"
  | "r2-icon-put"
  | "worker-upload"
  | "worker-deploy"
  | "worker-trigger-deploy"
  | "worker-rehearsal-delete"
  | "worker-repair-upload"
  | "worker-repair-deploy"
  | "worker-repair-trigger-deploy"
  | "worker-delete"
  | "r2-object-delete"
  | "r2-bucket-delete"
  | "kv-delete"
  | "d1-delete";

export interface ReplicaMutationDescriptor extends JsonObject {
  readonly id: string;
  readonly kind: ReplicaMutationKind;
  readonly resourceType: "worker" | "d1" | "kv" | "r2";
  readonly resourceName: string;
  readonly resourceId?: string;
  readonly objectKey?: string;
  readonly expectedDigest: string;
}

export interface ReplicaMutationReceipt extends JsonObject {
  readonly accountId: string;
  readonly resourceName: string;
  readonly resourceId?: string;
  readonly objectKey?: string;
  readonly liveReadbackDigest: string;
  readonly commandReceiptDigest?: string;
  readonly recovery: "direct" | "lost-response" | "resume";
  readonly result: "exact-present" | "exact-absent";
  readonly createdOnly: boolean;
}

export interface ReplicaMutationRecord extends JsonObject {
  readonly descriptor: ReplicaMutationDescriptor;
  readonly phase: "intent-recorded" | "committed";
  readonly receipt?: ReplicaMutationReceipt;
}

export interface ReplicaMutationJournal extends JsonObject {
  readonly kind: "takosumi.store-replica-mutation-journal@v1";
  readonly surfaceId: typeof SURFACE_ID;
  readonly releaseId: string;
  readonly replicaId: string;
  readonly accountId: string;
  readonly targetDigest: string;
  readonly preflightAbsenceDigest: string;
  readonly operations: readonly ReplicaMutationRecord[];
  readonly productionFallback: false;
}

export interface ReplicaMutationJournalAuthority {
  readonly releaseId: string;
  readonly replicaId: string;
  readonly accountId: string;
  readonly targetDigest: string;
  readonly preflightAbsenceDigest: string;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu;
const KV_ID = /^[0-9a-f]{32}$/u;
const MUTATION_ORDER: Readonly<Record<ReplicaMutationKind, number>> = {
  "d1-create": 0,
  "kv-create": 1,
  "r2-create": 2,
  "d1-migrations-apply": 3,
  "d1-snapshot-import": 4,
  "r2-icon-put": 5,
  "worker-upload": 6,
  "worker-deploy": 7,
  "worker-trigger-deploy": 8,
  "worker-rehearsal-delete": 9,
  "worker-repair-upload": 10,
  "worker-repair-deploy": 11,
  "worker-repair-trigger-deploy": 12,
  "worker-delete": 13,
  "r2-object-delete": 14,
  "r2-bucket-delete": 15,
  "kv-delete": 16,
  "d1-delete": 17,
};

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is JsonObject {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson([...expected].sort())
  ) {
    throw new Error(`${label}_schema_invalid`);
  }
}

function descriptorKeys(value: ReplicaMutationDescriptor): string[] {
  return [
    "id",
    "kind",
    "resourceType",
    "resourceName",
    ...(value.resourceId === undefined ? [] : ["resourceId"]),
    ...(value.objectKey === undefined ? [] : ["objectKey"]),
    "expectedDigest",
  ];
}

function receiptKeys(value: ReplicaMutationReceipt): string[] {
  return [
    "accountId",
    "resourceName",
    ...(value.resourceId === undefined ? [] : ["resourceId"]),
    ...(value.objectKey === undefined ? [] : ["objectKey"]),
    "liveReadbackDigest",
    ...(value.commandReceiptDigest === undefined
      ? []
      : ["commandReceiptDigest"]),
    "recovery",
    "result",
    "createdOnly",
  ];
}

export function validateReplicaMutationJournal(
  value: unknown,
  authority: ReplicaMutationJournalAuthority,
): ReplicaMutationJournal {
  exactKeys(
    value,
    [
      "kind",
      "surfaceId",
      "releaseId",
      "replicaId",
      "accountId",
      "targetDigest",
      "preflightAbsenceDigest",
      "operations",
      "productionFallback",
    ],
    "replica_mutation_journal",
  );
  const journal = value as unknown as ReplicaMutationJournal;
  if (
    journal.kind !== "takosumi.store-replica-mutation-journal@v1" ||
    journal.surfaceId !== SURFACE_ID ||
    journal.releaseId !== authority.releaseId ||
    journal.replicaId !== authority.replicaId ||
    journal.accountId !== authority.accountId ||
    journal.targetDigest !== authority.targetDigest ||
    journal.preflightAbsenceDigest !== authority.preflightAbsenceDigest ||
    journal.productionFallback !== false ||
    !SHA256.test(journal.targetDigest) ||
    !SHA256.test(journal.preflightAbsenceDigest) ||
    !Array.isArray(journal.operations)
  ) {
    throw new Error("replica_mutation_journal_authority_mismatch");
  }
  const ids = new Set<string>();
  let previousOrder = -1;
  for (const [index, operation] of journal.operations.entries()) {
    exactKeys(
      operation,
      operation.phase === "committed"
        ? ["descriptor", "phase", "receipt"]
        : ["descriptor", "phase"],
      `replica_mutation_${index}`,
    );
    if (
      operation.phase !== "intent-recorded" &&
      operation.phase !== "committed"
    ) {
      throw new Error("replica_mutation_phase_invalid");
    }
    const descriptor = operation.descriptor as ReplicaMutationDescriptor;
    exactKeys(
      descriptor,
      descriptorKeys(descriptor),
      `replica_mutation_descriptor_${index}`,
    );
    if (
      typeof descriptor.id !== "string" ||
      !/^[a-z0-9][a-z0-9:._/-]{2,255}$/u.test(descriptor.id) ||
      ids.has(descriptor.id) ||
      ![
        "d1-create",
        "kv-create",
        "r2-create",
        "d1-migrations-apply",
        "d1-snapshot-import",
        "r2-icon-put",
        "worker-upload",
        "worker-deploy",
        "worker-trigger-deploy",
        "worker-rehearsal-delete",
        "worker-repair-upload",
        "worker-repair-deploy",
        "worker-repair-trigger-deploy",
        "worker-delete",
        "r2-object-delete",
        "r2-bucket-delete",
        "kv-delete",
        "d1-delete",
      ].includes(descriptor.kind) ||
      !["worker", "d1", "kv", "r2"].includes(descriptor.resourceType) ||
      typeof descriptor.resourceName !== "string" ||
      descriptor.resourceName.length < 3 ||
      !SHA256.test(descriptor.expectedDigest)
    ) {
      throw new Error("replica_mutation_descriptor_invalid");
    }
    const order = MUTATION_ORDER[descriptor.kind];
    if (order < previousOrder) {
      throw new Error("replica_mutation_order_invalid");
    }
    previousOrder = order;
    ids.add(descriptor.id);
    if (operation.phase === "committed") {
      const receipt = operation.receipt as ReplicaMutationReceipt;
      exactKeys(
        receipt,
        receiptKeys(receipt),
        `replica_mutation_receipt_${index}`,
      );
      if (
        receipt.accountId !== authority.accountId ||
        receipt.resourceName !== descriptor.resourceName ||
        (descriptor.resourceId !== undefined &&
          receipt.resourceId !== descriptor.resourceId) ||
        receipt.objectKey !== descriptor.objectKey ||
        !SHA256.test(receipt.liveReadbackDigest) ||
        (receipt.commandReceiptDigest !== undefined &&
          !SHA256.test(receipt.commandReceiptDigest)) ||
        !["direct", "lost-response", "resume"].includes(receipt.recovery) ||
        !["exact-present", "exact-absent"].includes(receipt.result) ||
        typeof receipt.createdOnly !== "boolean"
      ) {
        throw new Error("replica_mutation_receipt_invalid");
      }
      const createKinds = new Set<ReplicaMutationKind>([
        "d1-create",
        "kv-create",
        "r2-create",
        "r2-icon-put",
        "worker-upload",
        "worker-repair-upload",
      ]);
      const deleteKinds = new Set<ReplicaMutationKind>([
        "worker-delete",
        "worker-rehearsal-delete",
        "r2-object-delete",
        "r2-bucket-delete",
        "kv-delete",
        "d1-delete",
      ]);
      if (
        receipt.createdOnly !== createKinds.has(descriptor.kind) ||
        (deleteKinds.has(descriptor.kind)
          ? receipt.result !== "exact-absent"
          : receipt.result !== "exact-present") ||
        (descriptor.kind === "d1-create" &&
          !UUID.test(String(receipt.resourceId))) ||
        (descriptor.kind === "kv-create" &&
          !KV_ID.test(String(receipt.resourceId))) ||
        ((descriptor.kind === "worker-upload" ||
          descriptor.kind === "worker-repair-upload") &&
          !UUID.test(String(receipt.resourceId)))
      ) {
        throw new Error("replica_mutation_receipt_semantics_invalid");
      }
    }
  }
  return journal;
}

export async function openReplicaMutationJournal(
  path: string,
  authority: ReplicaMutationJournalAuthority,
): Promise<ReplicaMutationJournal> {
  try {
    return validateReplicaMutationJournal(
      await readPrivateJson(path, dirname(path)),
      authority,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
  }
  const journal: ReplicaMutationJournal = {
    kind: "takosumi.store-replica-mutation-journal@v1",
    surfaceId: SURFACE_ID,
    ...authority,
    operations: [],
    productionFallback: false,
  };
  await writePrivateJson(path, journal);
  return journal;
}

export async function retainReplicaMutationIntent(
  path: string,
  journal: ReplicaMutationJournal,
  descriptor: ReplicaMutationDescriptor,
): Promise<{ journal: ReplicaMutationJournal; existing: boolean }> {
  const existing = journal.operations.find(
    (operation) => operation.descriptor.id === descriptor.id,
  );
  if (existing) {
    if (canonicalJson(existing.descriptor) !== canonicalJson(descriptor)) {
      throw new Error("replica_mutation_descriptor_changed");
    }
    return { journal, existing: true };
  }
  const last = journal.operations.at(-1);
  if (
    last &&
    MUTATION_ORDER[descriptor.kind] < MUTATION_ORDER[last.descriptor.kind]
  ) {
    throw new Error("replica_mutation_order_invalid");
  }
  const next: ReplicaMutationJournal = {
    ...journal,
    operations: [
      ...journal.operations,
      { descriptor, phase: "intent-recorded" },
    ],
  };
  await writePrivateJson(path, next, { replace: true });
  return { journal: next, existing: false };
}

export async function retainReplicaMutationIntents(
  path: string,
  journal: ReplicaMutationJournal,
  descriptors: readonly ReplicaMutationDescriptor[],
): Promise<ReplicaMutationJournal> {
  let operations = [...journal.operations];
  let changed = false;
  for (const descriptor of descriptors) {
    const existing = operations.find(
      (operation) => operation.descriptor.id === descriptor.id,
    );
    if (existing) {
      if (canonicalJson(existing.descriptor) !== canonicalJson(descriptor)) {
        throw new Error("replica_mutation_descriptor_changed");
      }
      continue;
    }
    const last = operations.at(-1);
    if (
      last &&
      MUTATION_ORDER[descriptor.kind] < MUTATION_ORDER[last.descriptor.kind]
    ) {
      throw new Error("replica_mutation_order_invalid");
    }
    operations.push({ descriptor, phase: "intent-recorded" });
    changed = true;
  }
  if (!changed) return journal;
  const next: ReplicaMutationJournal = { ...journal, operations };
  await writePrivateJson(path, next, { replace: true });
  return next;
}

export async function commitReplicaMutation(
  path: string,
  journal: ReplicaMutationJournal,
  descriptor: ReplicaMutationDescriptor,
  receipt: ReplicaMutationReceipt,
): Promise<ReplicaMutationJournal> {
  const existing = journal.operations.find(
    (operation) => operation.descriptor.id === descriptor.id,
  );
  if (
    !existing ||
    canonicalJson(existing.descriptor) !== canonicalJson(descriptor)
  ) {
    throw new Error("replica_mutation_intent_missing");
  }
  if (existing.phase === "committed") {
    if (canonicalJson(existing.receipt) !== canonicalJson(receipt)) {
      throw new Error("replica_mutation_receipt_changed");
    }
    return journal;
  }
  const next: ReplicaMutationJournal = {
    ...journal,
    operations: journal.operations.map((operation) =>
      operation.descriptor.id === descriptor.id
        ? { descriptor, phase: "committed", receipt }
        : operation,
    ),
  };
  await writePrivateJson(path, next, { replace: true });
  return next;
}

export function committedReplicaMutation(
  journal: ReplicaMutationJournal,
  id: string,
): ReplicaMutationRecord | null {
  const operation = journal.operations.find(
    (candidate) => candidate.descriptor.id === id,
  );
  return operation?.phase === "committed" ? operation : null;
}

export function requireAttemptCreatedResource(
  journal: ReplicaMutationJournal,
  kind:
    | "d1-create"
    | "kv-create"
    | "r2-create"
    | "worker-upload"
    | "worker-repair-upload",
  name: string,
  id?: string,
): ReplicaMutationRecord {
  const matches = journal.operations.filter(
    (operation) =>
      operation.phase === "committed" &&
      operation.descriptor.kind === kind &&
      operation.descriptor.resourceName === name &&
      (id === undefined || operation.receipt?.resourceId === id) &&
      operation.receipt?.createdOnly === true &&
      operation.receipt.result === "exact-present",
  );
  if (matches.length !== 1) {
    throw new Error("replica_cleanup_created_only_authority_missing");
  }
  return matches[0]!;
}

export function mutationAuthorityDigest(
  journal: ReplicaMutationJournal,
): string {
  return digestJson({
    kind: journal.kind,
    surfaceId: journal.surfaceId,
    releaseId: journal.releaseId,
    replicaId: journal.replicaId,
    accountId: journal.accountId,
    targetDigest: journal.targetDigest,
    preflightAbsenceDigest: journal.preflightAbsenceDigest,
  });
}
