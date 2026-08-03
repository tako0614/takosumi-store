export function realizedOrigin(value: string): string;

export function parseRealizedConfig(source: string): {
  workerName: string;
  configOrigin: string;
  databaseName: string;
  databaseId: string;
  migrationsTable: string;
  routeHostnames: string[];
};

export function sha256(value: string): string;
export function assetTreeDigest(root: string): string;

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string;

export function assertPrivateStateDirectory(
  path: string,
  repositoryRoot: string,
): string;

export function canonicalCollisionAuditSql(): string;
export function schemaReadbackSql(): string;
export function v2IndexReadbackSql(): string;
export function schemaDataReadbackSql(): string;
export function schemaIdentityReadbackSql(): string;
export function tableDataReadbackSql(table: string): string;
export function migrationLedgerReadbackSql(table?: string): string;
export function migrationConfigSource(
  source: string,
  migrationsDirectory: string,
): string;
export function requireMigrationPrefix(
  localNames: readonly string[],
  ledgerRows: readonly Record<string, unknown>[],
): string[];
export function migrationManifest(
  entries: readonly { name: string; bytes: string }[],
): string;
export function verifySchemaMigrationProjection(input: {
  pendingMigrations?: readonly string[];
  beforeListings: readonly Record<string, unknown>[] | null;
  afterListings: readonly Record<string, unknown>[] | null;
  beforeReports: readonly Record<string, unknown>[] | null;
  afterReports: readonly Record<string, unknown>[] | null;
  beforeReportRateLimits?: readonly Record<string, unknown>[] | null;
  afterReportRateLimits?: readonly Record<string, unknown>[] | null;
}): { listings: number; reports: number; reportRateLimits: number };
