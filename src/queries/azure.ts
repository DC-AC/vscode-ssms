/**
 * Azure SQL Database catalog queries. sys.event_log is the closest thing to an
 * error log on Azure SQL DB — it records connectivity/login events. It lives in
 * the master database of the logical server, so queries must run against master.
 */

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nLiteral(value: string): string {
  return "N'" + value.replace(/'/g, "''") + "'";
}

export interface ResourceStatsFilters {
  database: string;
  startDate?: string;
  endDate?: string;
}

/** Resource utilization history for a specific database, read from
 * sys.resource_stats in the master database (≈14 days, 5-minute intervals).
 * One master connection serves every database on the logical server. */
export function resourceStatsQuery(f: ResourceStatsFilters): string {
  const where: string[] = [`database_name = ${nLiteral(f.database)}`];
  if (f.startDate && isIsoDate(f.startDate)) {
    where.push(`start_time >= '${f.startDate}'`);
  }
  if (f.endDate && isIsoDate(f.endDate)) {
    where.push(`start_time < DATEADD(day, 1, '${f.endDate}')`);
  }
  return `
SELECT TOP (5000)
    CONVERT(varchar(19), end_time, 126) AS [Time],
    avg_cpu_percent                     AS [CPU %],
    avg_data_io_percent                 AS [Data IO %],
    avg_log_write_percent               AS [Log Write %],
    max_worker_percent                  AS [Max Worker %],
    max_session_percent                 AS [Max Session %],
    storage_in_megabytes                AS [Storage MB],
    dtu_limit                           AS [DTU Limit],
    sku                                 AS [SKU]
FROM sys.resource_stats
WHERE ${where.join("\n  AND ")}
ORDER BY end_time DESC;
`;
}

export interface EventLogFilters {
  /** severity: 0 Information, 1 Warning, 2 Error. */
  severity?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

export function eventLogQuery(f: EventLogFilters): string {
  const where: string[] = ["1 = 1"];
  if (f.severity && /^[0-2]$/.test(f.severity)) {
    where.push(`severity = ${f.severity}`);
  }
  if (f.startDate && isIsoDate(f.startDate)) {
    where.push(`start_time >= '${f.startDate}'`);
  }
  if (f.endDate && isIsoDate(f.endDate)) {
    where.push(`start_time < DATEADD(day, 1, '${f.endDate}')`);
  }
  if (f.search) {
    const s = nLiteral(f.search);
    where.push(`(description LIKE '%' + ${s} + '%' OR event_type LIKE '%' + ${s} + '%')`);
  }
  return `
SELECT TOP (1000)
    database_name                               AS [Database],
    CONVERT(varchar(19), start_time, 126)       AS [Start],
    CONVERT(varchar(19), end_time, 126)         AS [End],
    event_category                              AS [Category],
    event_type                                  AS [Type],
    event_subtype_desc                          AS [Subtype],
    CASE severity WHEN 0 THEN 'Information'
                  WHEN 1 THEN 'Warning'
                  WHEN 2 THEN 'Error'
                  ELSE CAST(severity AS varchar(10)) END AS [Severity],
    event_count                                 AS [Count],
    description                                  AS [Description]
FROM sys.event_log
WHERE ${where.join("\n  AND ")}
ORDER BY start_time DESC;
`;
}
