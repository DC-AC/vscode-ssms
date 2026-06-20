/**
 * SQL catalog for the Management folder (Milestone 1).
 *
 * IMPORTANT: every value comes back from executeSimpleQuery as a display
 * string (DbCellValue.displayValue), so all formatting — dates, sizes — is
 * done here in T-SQL with CONVERT/FORMAT, never re-parsed in TypeScript.
 */

/** Filters for the backup history pane. Empty / invalid values are ignored. */
export interface BackupFilters {
  database?: string;
  /** Backup type code: 'D' full, 'I' differential, 'L' log, 'F' file. */
  type?: string;
  /** Inclusive start date, 'YYYY-MM-DD'. */
  startDate?: string;
  /** Inclusive end date, 'YYYY-MM-DD'. */
  endDate?: string;
}

const BACKUP_TYPE_CODES = new Set(["D", "I", "L", "F"]);

/** N'...' literal with single quotes doubled — values come from a fixed UI. */
function nLiteral(value: string): string {
  return "N'" + value.replace(/'/g, "''") + "'";
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Build the backup history query for the given filters (server-side filtered). */
export function backupHistoryQuery(f: BackupFilters): string {
  const where: string[] = ["1 = 1"];
  if (f.database) {
    where.push(`bs.database_name = ${nLiteral(f.database)}`);
  }
  if (f.type && BACKUP_TYPE_CODES.has(f.type)) {
    where.push(`bs.type = '${f.type}'`);
  }
  if (f.startDate && isIsoDate(f.startDate)) {
    where.push(`bs.backup_finish_date >= '${f.startDate}'`);
  }
  if (f.endDate && isIsoDate(f.endDate)) {
    where.push(`bs.backup_finish_date < DATEADD(day, 1, '${f.endDate}')`);
  }
  return `
SELECT TOP (1000)
    bs.database_name                                              AS [Database],
    CASE bs.type WHEN 'D' THEN 'Full'
                 WHEN 'I' THEN 'Differential'
                 WHEN 'L' THEN 'Log'
                 WHEN 'F' THEN 'File/Filegroup'
                 ELSE bs.type END                                 AS [Type],
    CONVERT(varchar(19), bs.backup_start_date, 126)              AS [Started],
    CONVERT(varchar(19), bs.backup_finish_date, 126)             AS [Finished],
    CAST(bs.backup_size / 1024.0 / 1024.0 AS decimal(18,2))      AS [SizeMB],
    bmf.physical_device_name                                      AS [Device],
    bs.[user_name]                                               AS [By]
FROM msdb.dbo.backupset bs
JOIN msdb.dbo.backupmediafamily bmf
    ON bs.media_set_id = bmf.media_set_id
WHERE ${where.join("\n  AND ")}
ORDER BY bs.backup_finish_date DESC;
`;
}

/** Distinct databases that have backup history — populates the filter dropdown. */
export const BACKUP_DATABASES = `
SELECT DISTINCT database_name AS [Database]
FROM msdb.dbo.backupset
WHERE database_name IS NOT NULL
ORDER BY database_name;
`;

/** Enumerate the available SQL Server error logs (current + archives). */
export const ENUM_ERROR_LOGS = `EXEC sys.sp_enumerrorlogs;`;

/** Enumerate logs by type: 1 = SQL Server (default), 2 = SQL Server Agent. */
export function enumErrorLogs(logType: 1 | 2 = 1): string {
  return `EXEC sys.sp_enumerrorlogs ${logType};`;
}

/** Server-side filters for the error log viewer (maps to xp_readerrorlog params). */
export interface ErrorLogFilters {
  /** Log file number: 0 = current, 1..n = archives. */
  logNumber: number;
  /** 1 = SQL Server log (default), 2 = SQL Server Agent log. */
  logType?: 1 | 2;
  /** Free text the message must contain (xp_readerrorlog @p3). */
  search?: string;
  /** Inclusive start date 'YYYY-MM-DD' (xp_readerrorlog @p5). */
  startDate?: string;
  /** Inclusive end date 'YYYY-MM-DD' (xp_readerrorlog @p6). */
  endDate?: string;
  /** Sort order by time (xp_readerrorlog @p7). Default newest first. */
  sort?: "asc" | "desc";
}

/**
 * Read a SQL Server error log with server-side filtering.
 * xp_readerrorlog params are positional: (logNumber, logType=1 for SQL Server,
 * search1, search2, startTime, endTime, sortOrder).
 */
export function errorLogQuery(f: ErrorLogFilters): string {
  const n = Number.isInteger(f.logNumber) ? f.logNumber : 0;
  const search = f.search ? nLiteral(f.search) : "NULL";
  const start =
    f.startDate && isIsoDate(f.startDate) ? `'${f.startDate} 00:00:00'` : "NULL";
  const end =
    f.endDate && isIsoDate(f.endDate) ? `'${f.endDate} 23:59:59.997'` : "NULL";
  const sort = f.sort === "asc" ? "N'asc'" : "N'desc'";
  const logType = f.logType === 2 ? 2 : 1;
  return `EXEC sys.xp_readerrorlog ${n}, ${logType}, ${search}, NULL, ${start}, ${end}, ${sort};`;
}

/** Database Mail: recently sent/failed items. */
export const DATABASE_MAIL_ITEMS = `
SELECT TOP (200)
    i.mailitem_id                                   AS [Id],
    i.sent_status                                   AS [Status],
    CONVERT(varchar(19), i.send_request_date, 126)  AS [Requested],
    CONVERT(varchar(19), i.sent_date, 126)          AS [Sent],
    i.recipients                                    AS [To],
    i.subject                                       AS [Subject],
    i.send_request_user                             AS [By]
FROM msdb.dbo.sysmail_allitems i
ORDER BY i.send_request_date DESC;
`;

/** Database Mail: configured profiles. */
export const DATABASE_MAIL_PROFILES = `
SELECT
    p.name        AS [Profile],
    p.description AS [Description]
FROM msdb.dbo.sysmail_profile p
ORDER BY p.name;
`;
