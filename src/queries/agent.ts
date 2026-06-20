/**
 * SQL catalog for SQL Server Agent (under the SQL Server Agent folder).
 * Reads from msdb.dbo.sysjobs / sysjobsteps / sysjobschedules / sysjobhistory /
 * sysalerts / sysoperators / sysproxies. Agent isn't available on Azure SQL DB.
 */

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** N'...' string literal with single quotes doubled. */
function nameLiteral(value: string): string {
  return "N'" + value.replace(/'/g, "''") + "'";
}

/** A job_id is a GUID sourced from our own queries; validate before inlining. */
function guidLiteral(id: string): string {
  return /^[0-9A-Fa-f-]{36}$/.test(id)
    ? `'${id}'`
    : `'00000000-0000-0000-0000-000000000000'`;
}

const OUTCOME_CASE = (col: string): string =>
  `CASE ${col} WHEN 0 THEN 'Failed' WHEN 1 THEN 'Succeeded' WHEN 2 THEN 'Retry' WHEN 3 THEN 'Canceled' WHEN 4 THEN 'In Progress' WHEN 5 THEN 'Unknown' ELSE '' END`;

/** Duration stored as HHMMSS int -> 'HH:MM:SS'. */
const DURATION = (col: string): string =>
  `STUFF(STUFF(RIGHT('000000' + CAST(${col} AS varchar(6)), 6), 5, 0, ':'), 3, 0, ':')`;

/** Jobs with owner, category, and last run outcome. */
export const JOBS = `
SELECT
    j.job_id,
    j.name,
    j.enabled,
    SUSER_SNAME(j.owner_sid)        AS owner,
    c.name                          AS category,
    js.last_run_outcome,
    ${OUTCOME_CASE("js.last_run_outcome")} AS last_outcome
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.syscategories c ON j.category_id = c.category_id
LEFT JOIN msdb.dbo.sysjobservers js ON j.job_id = js.job_id
ORDER BY j.name;
`;

/** Job list for the history filter dropdown. */
export const JOB_LIST = `
SELECT job_id, name FROM msdb.dbo.sysjobs ORDER BY name;
`;

export function jobSteps(jobId: string): string {
  return `
SELECT
    step_id                         AS [Step],
    step_name                       AS [Name],
    subsystem                       AS [Type],
    ${OUTCOME_CASE("last_run_outcome")} AS [LastOutcome],
    database_name                   AS [Database],
    command                         AS [Command]
FROM msdb.dbo.sysjobsteps
WHERE job_id = ${guidLiteral(jobId)}
ORDER BY step_id;
`;
}

export function jobSchedules(jobId: string): string {
  return `
SELECT
    s.name      AS [Name],
    s.enabled   AS [Enabled],
    CASE s.freq_type
        WHEN 1 THEN 'One time' WHEN 4 THEN 'Daily' WHEN 8 THEN 'Weekly'
        WHEN 16 THEN 'Monthly' WHEN 32 THEN 'Monthly relative'
        WHEN 64 THEN 'When SQL Agent starts' WHEN 128 THEN 'When CPU idle'
        ELSE '' END                             AS [Frequency],
    s.freq_interval                             AS [Interval],
    msdb.dbo.agent_datetime(
        NULLIF(s.active_start_date, 0), s.active_start_time) AS [ActiveStart]
FROM msdb.dbo.sysjobschedules js
JOIN msdb.dbo.sysschedules s ON js.schedule_id = s.schedule_id
WHERE js.job_id = ${guidLiteral(jobId)}
ORDER BY s.name;
`;
}

export interface JobHistoryFilters {
  jobId?: string;
  /** run_status: 0 Failed, 1 Succeeded, 2 Retry, 3 Canceled, 4 In Progress. */
  runStatus?: string;
  startDate?: string;
  endDate?: string;
}

export function jobHistoryQuery(f: JobHistoryFilters): string {
  const where: string[] = ["1 = 1"];
  if (f.jobId) {
    where.push(`j.job_id = ${guidLiteral(f.jobId)}`);
  }
  if (f.runStatus && /^[0-5]$/.test(f.runStatus)) {
    where.push(`h.run_status = ${f.runStatus}`);
  }
  if (f.startDate && isIsoDate(f.startDate)) {
    where.push(`h.run_date >= ${f.startDate.replace(/-/g, "")}`);
  }
  if (f.endDate && isIsoDate(f.endDate)) {
    where.push(`h.run_date <= ${f.endDate.replace(/-/g, "")}`);
  }
  return `
SELECT TOP (1000)
    j.name                              AS [Job],
    h.step_id                           AS [Step],
    h.step_name                         AS [StepName],
    ${OUTCOME_CASE("h.run_status")}     AS [Outcome],
    msdb.dbo.agent_datetime(h.run_date, h.run_time) AS [RunTime],
    ${DURATION("h.run_duration")}       AS [Duration],
    h.message                           AS [Message]
FROM msdb.dbo.sysjobhistory h
JOIN msdb.dbo.sysjobs j ON h.job_id = j.job_id
WHERE ${where.join("\n  AND ")}
ORDER BY h.instance_id DESC;
`;
}

/* ---- Job editor: detail + lookup queries ---- */

export function jobDetail(jobId: string): string {
  return `
SELECT j.job_id, j.name, j.enabled, j.description,
       SUSER_SNAME(j.owner_sid) AS owner, c.name AS category
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.syscategories c ON j.category_id = c.category_id
WHERE j.job_id = ${guidLiteral(jobId)};
`;
}

export function jobStepsDetail(jobId: string): string {
  return `
SELECT step_id, step_name, subsystem, database_name, command,
       on_success_action, on_fail_action, retry_attempts, retry_interval
FROM msdb.dbo.sysjobsteps
WHERE job_id = ${guidLiteral(jobId)}
ORDER BY step_id;
`;
}

export function jobSchedulesDetail(jobId: string): string {
  return `
SELECT s.schedule_id, s.name, s.enabled, s.freq_type, s.freq_interval,
       s.freq_subday_type, s.freq_subday_interval, s.freq_relative_interval,
       s.freq_recurrence_factor, s.active_start_date, s.active_end_date,
       s.active_start_time, s.active_end_time
FROM msdb.dbo.sysjobschedules js
JOIN msdb.dbo.sysschedules s ON js.schedule_id = s.schedule_id
WHERE js.job_id = ${guidLiteral(jobId)}
ORDER BY s.name;
`;
}

/** Job categories for the General page dropdown. */
export const JOB_CATEGORIES = `
SELECT name FROM msdb.dbo.syscategories WHERE category_class = 1 ORDER BY name;
`;

/** Databases for the step "Database" dropdown (T-SQL steps). */
export const DATABASE_NAMES = `
SELECT name FROM sys.databases ORDER BY name;
`;

export const ALERTS = `
SELECT
    name                    AS [Name],
    enabled                 AS [Enabled],
    severity                AS [Severity],
    message_id              AS [MessageId],
    occurrence_count        AS [Count],
    last_occurrence_date    AS [LastDate]
FROM msdb.dbo.sysalerts
ORDER BY name;
`;

/* ---- Operator editor ---- */

export function operatorDetailFull(name: string): string {
  return `
SELECT name, enabled, email_address, pager_address, pager_days,
       weekday_pager_start_time, weekday_pager_end_time,
       saturday_pager_start_time, saturday_pager_end_time,
       sunday_pager_start_time, sunday_pager_end_time
FROM msdb.dbo.sysoperators WHERE name = ${nameLiteral(name)};
`;
}

/** Alerts plus whether this operator is notified and by which method. */
export function operatorNotifications(name: string): string {
  return `
SELECT a.name AS alert_name, ISNULL(n.notification_method, 0) AS method
FROM msdb.dbo.sysalerts a
LEFT JOIN msdb.dbo.sysnotifications n ON a.id = n.alert_id
     AND n.operator_id = (SELECT id FROM msdb.dbo.sysoperators WHERE name = ${nameLiteral(name)})
ORDER BY a.name;
`;
}

/** All alerts with method 0 — for a brand-new operator. */
export const ALL_ALERTS_FOR_NOTIFY = `
SELECT name AS alert_name, 0 AS method FROM msdb.dbo.sysalerts ORDER BY name;
`;

export const OPERATORS = `
SELECT
    name            AS [Name],
    enabled         AS [Enabled],
    email_address   AS [Email],
    pager_address   AS [Pager]
FROM msdb.dbo.sysoperators
ORDER BY name;
`;

/** Proxies granted to a given subsystem (syssubsystems.subsystem code). */
export function proxiesForSubsystem(subsystem: string): string {
  return `
SELECT p.name AS [Name]
FROM msdb.dbo.sysproxies p
JOIN msdb.dbo.sysproxysubsystem ps ON p.proxy_id = ps.proxy_id
JOIN msdb.dbo.syssubsystems s ON ps.subsystem_id = s.subsystem_id
WHERE s.subsystem = ${nameLiteral(subsystem)}
ORDER BY p.name;
`;
}

/** Proxies not granted to any subsystem. */
export const PROXIES_UNASSIGNED = `
SELECT p.name AS [Name]
FROM msdb.dbo.sysproxies p
WHERE NOT EXISTS (SELECT 1 FROM msdb.dbo.sysproxysubsystem ps WHERE ps.proxy_id = p.proxy_id)
ORDER BY p.name;
`;

export const PROXIES = `
SELECT
    p.name          AS [Name],
    p.enabled       AS [Enabled],
    c.name          AS [Credential],
    p.description   AS [Description]
FROM msdb.dbo.sysproxies p
LEFT JOIN sys.credentials c ON p.credential_id = c.credential_id
ORDER BY p.name;
`;
