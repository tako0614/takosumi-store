import { and, desc, eq, sql } from "drizzle-orm";
import type { StoreDb } from "./client.ts";
import { reports, type ReportRow } from "./schema.ts";

const MAX_OPEN_REPORTS_PER_LISTING = 100;

export async function createReport(
  db: StoreDb,
  input: {
    id: string;
    listingId: string;
    reporterKey: string;
    reasonDigest: string;
    reason: string;
    now: Date;
  },
): Promise<"created" | "duplicate" | "saturated"> {
  const inserted = await db.all<{ id: string }>(sql`
    INSERT INTO reports (
      id, listing_id, reporter_key, reason_digest, reason, status, created_at
    )
    SELECT
      ${input.id}, ${input.listingId}, ${input.reporterKey},
      ${input.reasonDigest}, ${input.reason}, 'open',
      ${input.now.toISOString()}
    WHERE (
      SELECT count(*) FROM reports
      WHERE listing_id = ${input.listingId} AND status = 'open'
    ) < ${MAX_OPEN_REPORTS_PER_LISTING}
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  if (inserted.length > 0) return "created";
  return (await hasOpenDuplicate(
    db,
    input.listingId,
    input.reporterKey,
    input.reasonDigest,
  ))
    ? "duplicate"
    : "saturated";
}

export async function hasOpenDuplicate(
  db: StoreDb,
  listingId: string,
  reporterKey: string,
  reasonDigest: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(
        eq(reports.listingId, listingId),
        eq(reports.reporterKey, reporterKey),
        eq(reports.reasonDigest, reasonDigest),
        eq(reports.status, "open"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Reserve one request in an atomic UTC-hour fixed window. */
export async function reserveReportRateLimit(
  db: StoreDb,
  reporterKey: string,
  now: Date,
  maxPerHour: number,
): Promise<boolean> {
  const bucketStart = `${now.toISOString().slice(0, 13)}:00:00.000Z`;
  const retentionCutoff = new Date(
    now.getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();
  await db.run(sql`
    DELETE FROM report_rate_limits
    WHERE reporter_key = ${reporterKey}
      AND bucket_start < ${retentionCutoff}
  `);
  const rows = await db.all<{ count: number }>(sql`
    INSERT INTO report_rate_limits (reporter_key, bucket_start, count)
    VALUES (${reporterKey}, ${bucketStart}, 1)
    ON CONFLICT (reporter_key, bucket_start) DO UPDATE
      SET count = report_rate_limits.count + 1
      WHERE report_rate_limits.count < ${maxPerHour}
    RETURNING count
  `);
  return rows.length === 1;
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
    .orderBy(desc(reports.createdAt))
    .limit(MAX_OPEN_REPORTS_PER_LISTING)) as ReportRow[];
  return rows.map((r) => ({
    id: r.id,
    listingId: r.listingId,
    reason: r.reason,
    status: r.status,
    createdAt: r.createdAt,
  }));
}

export async function resolveReport(db: StoreDb, id: string): Promise<boolean> {
  const rows = await db
    .update(reports)
    .set({ status: "resolved" })
    .where(and(eq(reports.id, id), eq(reports.status, "open")))
    .returning({ id: reports.id });
  return rows.length > 0;
}
