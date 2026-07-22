import { desc, eq } from "drizzle-orm";
import type { StoreDb } from "./client.ts";
import { reports, type ReportRow } from "./schema.ts";

export async function createReport(
  db: StoreDb,
  input: {
    id: string;
    listingId: string;
    reporterSub: string | null;
    reason: string;
    now: Date;
  },
): Promise<void> {
  await db.insert(reports).values({
    id: input.id,
    listingId: input.listingId,
    reporterSub: input.reporterSub,
    reason: input.reason.slice(0, 1000),
    status: "open",
    createdAt: input.now.toISOString(),
  });
}

export interface Report {
  readonly id: string;
  readonly listingId: string;
  readonly reason: string;
  readonly status: string;
  readonly createdAt: string;
}

export async function listOpenReports(db: StoreDb): Promise<Report[]> {
  const rows = (await db
    .select()
    .from(reports)
    .where(eq(reports.status, "open"))
    .orderBy(desc(reports.createdAt))) as ReportRow[];
  return rows.map((r) => ({
    id: r.id,
    listingId: r.listingId,
    reason: r.reason,
    status: r.status,
    createdAt: r.createdAt,
  }));
}

export async function resolveReport(db: StoreDb, id: string): Promise<void> {
  await db
    .update(reports)
    .set({ status: "resolved" })
    .where(eq(reports.id, id));
}
