/**
 * Query Store catalog queries (sys.query_store_*). These run against the
 * connected user database — Query Store is per-database. No master needed.
 */

/**
 * Selectable metrics. Each maps to the Query Store runtime-stats column family
 * (avg_/min_/max_/stdev_<base>) and a divisor to convert to display units.
 */
const METRIC_COLS: Record<string, { label: string; base: string; div: number }> = {
  duration: { label: "Duration (ms)", base: "duration", div: 1000 },
  cpu: { label: "CPU Time (ms)", base: "cpu_time", div: 1000 },
  logical_reads: { label: "Logical Reads", base: "logical_io_reads", div: 1 },
  logical_writes: { label: "Logical Writes", base: "logical_io_writes", div: 1 },
  physical_reads: { label: "Physical Reads", base: "physical_io_reads", div: 1 },
  clr: { label: "CLR Time (ms)", base: "clr_time", div: 1000 },
  dop: { label: "DOP", base: "dop", div: 1 },
  memory: { label: "Memory (KB)", base: "query_max_used_memory", div: 1 },
  rowcount: { label: "Row Count", base: "rowcount", div: 1 },
  log_memory: { label: "Log Memory (KB)", base: "log_bytes_used", div: 1024 },
  tempdb: { label: "Temp DB Used (KB)", base: "tempdb_space_used", div: 1 },
};

export const METRIC_OPTIONS: Array<{ key: string; label: string }> = Object.entries(
  METRIC_COLS
).map(([key, m]) => ({ key, label: m.label }));

/** SSMS "Based on" statistic. */
export const AGG_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "avg", label: "Avg" },
  { key: "total", label: "Total" },
  { key: "max", label: "Max" },
  { key: "min", label: "Min" },
  { key: "stdev", label: "Std Dev" },
];

export function metricLabel(key: string): string {
  return METRIC_COLS[key]?.label ?? key;
}

export function aggLabel(key: string): string {
  return AGG_OPTIONS.find((a) => a.key === key)?.label ?? key;
}

/** Aggregate expression over a GROUP for the chosen metric + statistic. */
function metricExpr(metricKey: string, agg: string): string {
  const m = METRIC_COLS[metricKey] ?? METRIC_COLS.duration;
  const b = m.base;
  const d = `${m.div}.0`;
  switch (agg) {
    case "total":
      return `SUM(rs.avg_${b} * rs.count_executions) / ${d}`;
    case "max":
      return `MAX(rs.max_${b}) / ${d}`;
    case "min":
      return `MIN(rs.min_${b}) / ${d}`;
    case "stdev":
      return `AVG(rs.stdev_${b}) / ${d}`;
    case "avg":
    default:
      return `SUM(rs.avg_${b} * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / ${d}`;
  }
}

/** Window length in whole minutes (supports sub-hour ranges). Default 1 day. */
const minutesOf = (h: number): number =>
  Math.max(1, Math.round((Number.isFinite(h) && h > 0 ? h : 24) * 60));

/**
 * Time range for a report. Either a relative window of `hours` ending now, or
 * an absolute custom range with UTC ISO `start`/`end` (e.g. "2026-06-19T17:00:00").
 */
export interface TimeWindow {
  hours: number;
  start?: string;
  end?: string;
}

/** Keep only ISO date-time characters, to make the value safe to inline. */
const sanitizeTs = (s: string): string => s.replace(/[^0-9T:.\-]/g, "").slice(0, 23);

const hasRange = (w: TimeWindow): boolean => !!(w.start && w.end);

/** SQL predicate for `col` falling within the window. */
function windowPredicate(col: string, w: TimeWindow): string {
  if (hasRange(w)) {
    return `${col} >= CAST('${sanitizeTs(w.start as string)}' AS datetime2) AND ${col} < CAST('${sanitizeTs(w.end as string)}' AS datetime2)`;
  }
  return `${col} >= DATEADD(minute, -${minutesOf(w.hours)}, SYSUTCDATETIME())`;
}

const intOf = (n: number): number => (Number.isInteger(n) ? n : -1);

const RS_JOINS = `
FROM sys.query_store_runtime_stats rs
JOIN sys.query_store_runtime_stats_interval rsi ON rs.runtime_stats_interval_id = rsi.runtime_stats_interval_id
JOIN sys.query_store_plan p ON rs.plan_id = p.plan_id
JOIN sys.query_store_query q ON p.query_id = q.query_id`;

/** Whether Query Store is on for the database. */
export const QS_STATUS = `SELECT actual_state_desc AS [State] FROM sys.database_query_store_options;`;

/** Top resource-consuming queries by the chosen metric + statistic over the window. */
export function topConsumersQuery(metricKey: string, agg: string, win: TimeWindow): string {
  return `
SELECT TOP (25)
    q.query_id                              AS [QueryId],
    CAST(${metricExpr(metricKey, agg)} AS decimal(38, 2)) AS [Value],
    SUM(rs.count_executions)                AS [Executions],
    SUBSTRING(qt.query_sql_text, 1, 300)    AS [QueryText]
${RS_JOINS}
JOIN sys.query_store_query_text qt ON q.query_text_id = qt.query_text_id
WHERE ${windowPredicate("rsi.start_time", win)}
GROUP BY q.query_id, qt.query_sql_text
ORDER BY [Value] DESC;
`;
}

/* ---- Overall Resource Consumption ---- */

/** Metrics shown as bucketed bar charts in the Overall Resource Consumption report. */
export const OVERALL_METRICS: Array<{ key: string; label: string }> = [
  { key: "Duration", label: "Total Duration (ms)" },
  { key: "Executions", label: "Execution Count" },
  { key: "Cpu", label: "Total CPU (ms)" },
  { key: "LogicalReads", label: "Total Logical Reads" },
];

/**
 * Total resource use per time bucket across all queries — drives the four
 * Overall Resource Consumption bar charts. One row per bucket.
 */
export function overallConsumptionQuery(win: TimeWindow, intervalMinutes: number): string {
  const n = bucketOf(intervalMinutes);
  const bucket = `DATEADD(minute, (DATEDIFF(minute, '2000-01-01', rsi.start_time) / ${n}) * ${n}, CAST('2000-01-01' AS datetime2))`;
  return `
SELECT
    CONVERT(varchar(19), ${bucket}, 126)                                          AS [BucketStart],
    CAST(SUM(rs.avg_duration * rs.count_executions) / 1000.0 AS decimal(38, 2))   AS [Duration],
    SUM(rs.count_executions)                                                      AS [Executions],
    CAST(SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS decimal(38, 2))   AS [Cpu],
    CAST(SUM(rs.avg_logical_io_reads * rs.count_executions) AS bigint)            AS [LogicalReads]
FROM sys.query_store_runtime_stats rs
JOIN sys.query_store_runtime_stats_interval rsi ON rs.runtime_stats_interval_id = rsi.runtime_stats_interval_id
WHERE ${windowPredicate("rsi.start_time", win)}
GROUP BY ${bucket}
ORDER BY ${bucket};
`;
}

/**
 * Plan-summary series for one query: per plan, per interval, the metric value
 * over time. Drives the SSMS plan-summary bubble chart.
 */
/** Bucket-length options (minutes) for the plan-summary chart. */
export const INTERVAL_OPTIONS: Array<{ key: number; label: string }> = [
  { key: 5, label: "5 minutes" },
  { key: 15, label: "15 minutes" },
  { key: 30, label: "30 minutes" },
  { key: 60, label: "1 hour" },
  { key: 720, label: "12 hours" },
  { key: 1440, label: "1 day" },
];

const bucketOf = (n: number): number => {
  const valid = INTERVAL_OPTIONS.some((o) => o.key === n);
  return valid ? n : 60;
};

export function planSummaryQuery(
  queryId: number,
  metricKey: string,
  agg: string,
  win: TimeWindow,
  intervalMinutes: number
): string {
  const m = METRIC_COLS[metricKey] ?? METRIC_COLS.duration;
  const b = m.base;
  const d = `${m.div}.0`;
  const n = bucketOf(intervalMinutes);
  // Floor each native QS interval's start to the chosen bucket size (UTC anchor).
  const bucket = `DATEADD(minute, (DATEDIFF(minute, '2000-01-01', rsi.start_time) / ${n}) * ${n}, CAST('2000-01-01' AS datetime2))`;
  return `
SELECT
    p.plan_id                                       AS [PlanId],
    CONVERT(varchar(19), ${bucket}, 126)            AS [IntervalStart],
    CONVERT(varchar(19), DATEADD(minute, ${n}, ${bucket}), 126) AS [IntervalEnd],
    rs.execution_type_desc                          AS [ExecutionType],
    CAST(p.is_forced_plan AS int)                   AS [Forced],
    SUM(rs.count_executions)                        AS [Executions],
    CAST(${metricExpr(metricKey, agg)} AS decimal(38, 2)) AS [Value],
    CAST(SUM(rs.avg_${b} * rs.count_executions) / ${d} AS decimal(38, 2)) AS [Total],
    CAST(SUM(rs.avg_${b} * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / ${d} AS decimal(38, 2)) AS [Avg],
    CAST(MIN(rs.min_${b}) / ${d} AS decimal(38, 2)) AS [Min],
    CAST(MAX(rs.max_${b}) / ${d} AS decimal(38, 2)) AS [Max],
    CAST(AVG(rs.stdev_${b}) / ${d} AS decimal(38, 2)) AS [StdDev]
${RS_JOINS}
WHERE p.query_id = ${intOf(queryId)}
  AND ${windowPredicate("rsi.start_time", win)}
GROUP BY p.plan_id, ${bucket}, rs.execution_type_desc, p.is_forced_plan
ORDER BY [IntervalStart];
`;
}

/** Graphical showplan XML for a plan, to hand off to the mssql plan viewer.
 *  Returned in 65 000-char chunks (p1..p4) because the mssql driver truncates
 *  any single nvarchar(max) column at 65 536 chars. */
export function planXmlQuery(planId: number): string {
  const id = intOf(planId);
  return `
DECLARE @p nvarchar(max) = (SELECT CONVERT(nvarchar(max), query_plan) FROM sys.query_store_plan WHERE plan_id = ${id});
SELECT
  SUBSTRING(@p,      1, 65000) AS p1,
  SUBSTRING(@p,  65001, 65000) AS p2,
  SUBSTRING(@p, 130001, 65000) AS p3,
  SUBSTRING(@p, 195001, 65000) AS p4;`;
}

/** Full SQL text for a query. */
export function queryTextQuery(queryId: number): string {
  return `
SELECT qt.query_sql_text AS [QueryText]
FROM sys.query_store_query q
JOIN sys.query_store_query_text qt ON q.query_text_id = qt.query_text_id
WHERE q.query_id = ${intOf(queryId)};
`;
}

/**
 * Plans for a query over the window, with execution-weighted runtime stats and
 * forced state. Scoped to the same window as the plan-summary chart so the two
 * stay consistent (only plans with activity in the window appear).
 */
export function queryPlansQuery(queryId: number, win: TimeWindow): string {
  return `
SELECT
    p.plan_id                                       AS [PlanId],
    p.is_forced_plan                                AS [Forced],
    SUM(rs.count_executions)                        AS [Executions],
    CAST(SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS decimal(18, 2)) AS [AvgDurationMs],
    CAST(SUM(rs.avg_cpu_time * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS decimal(18, 2)) AS [AvgCpuMs],
    CAST(SUM(rs.avg_logical_io_reads * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) AS bigint) AS [AvgLogicalReads]
FROM sys.query_store_plan p
JOIN sys.query_store_runtime_stats rs ON p.plan_id = rs.plan_id
JOIN sys.query_store_runtime_stats_interval rsi ON rs.runtime_stats_interval_id = rsi.runtime_stats_interval_id
WHERE p.query_id = ${intOf(queryId)}
  AND ${windowPredicate("rsi.start_time", win)}
GROUP BY p.plan_id, p.is_forced_plan
ORDER BY p.plan_id;
`;
}

export function forcePlanStatement(queryId: number, planId: number): string {
  return `EXEC sys.sp_query_store_force_plan @query_id = ${intOf(queryId)}, @plan_id = ${intOf(planId)};`;
}

export function unforcePlanStatement(queryId: number, planId: number): string {
  return `EXEC sys.sp_query_store_unforce_plan @query_id = ${intOf(queryId)}, @plan_id = ${intOf(planId)};`;
}

/* ---- Regressed Queries ---- */

/**
 * Queries that got worse: compare a recent window to the preceding history
 * (history = 8× the recent window) on the chosen metric + statistic.
 * Excludes queries run fewer than `minExec` times in the recent window.
 */
export function regressedQueriesQuery(
  metricKey: string,
  agg: string,
  win: TimeWindow,
  minExec: number
): string {
  const expr = metricExpr(metricKey, agg);
  const me = Math.max(0, Math.floor(Number.isFinite(minExec) ? minExec : 0));
  let recentPred: string;
  let histPred: string;
  if (hasRange(win)) {
    // Recent = the custom range; history = an 8×-length window immediately before it.
    const s = `CAST('${sanitizeTs(win.start as string)}' AS datetime2)`;
    const e = `CAST('${sanitizeTs(win.end as string)}' AS datetime2)`;
    recentPred = `rsi.start_time >= ${s} AND rsi.start_time < ${e}`;
    histPred = `rsi.start_time < ${s} AND rsi.start_time >= DATEADD(minute, -8 * DATEDIFF(minute, ${s}, ${e}), ${s})`;
  } else {
    const r = minutesOf(win.hours);
    const histStart = r * 8; // baseline window = 8× the recent window, preceding it
    recentPred = `rsi.start_time >= DATEADD(minute, -${r}, SYSUTCDATETIME())`;
    histPred = `rsi.start_time < DATEADD(minute, -${r}, SYSUTCDATETIME()) AND rsi.start_time >= DATEADD(minute, -${histStart}, SYSUTCDATETIME())`;
  }
  return `
WITH recent AS (
    SELECT q.query_id, ${expr} AS m, SUM(rs.count_executions) AS execs
    ${RS_JOINS}
    WHERE ${recentPred}
    GROUP BY q.query_id
    HAVING SUM(rs.count_executions) >= ${me}
),
hist AS (
    SELECT q.query_id, ${expr} AS m
    ${RS_JOINS}
    WHERE ${histPred}
    GROUP BY q.query_id
)
SELECT TOP (25)
    r.query_id                              AS [QueryId],
    CAST(h.m AS decimal(18, 2))             AS [Baseline],
    CAST(r.m AS decimal(18, 2))             AS [Recent],
    CAST(r.m - h.m AS decimal(18, 2))       AS [Regression],
    CAST((r.m - h.m) * 100.0 / NULLIF(h.m, 0) AS decimal(18, 1)) AS [Regression %],
    r.execs                                 AS [Executions],
    SUBSTRING(qt.query_sql_text, 1, 300)    AS [QueryText]
FROM recent r
JOIN hist h ON r.query_id = h.query_id
JOIN sys.query_store_query q2 ON r.query_id = q2.query_id
JOIN sys.query_store_query_text qt ON q2.query_text_id = qt.query_text_id
WHERE h.m > 0 AND r.m > h.m
ORDER BY (r.m - h.m) DESC;
`;
}

/* ---- Queries With High Variation ---- */

/** "Based on" options for the High Variation report. */
export const VARIATION_AGG_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "variation", label: "Variation" },
  { key: "stdev", label: "Std Dev" },
];

export function variationAggLabel(key: string): string {
  return VARIATION_AGG_OPTIONS.find((a) => a.key === key)?.label ?? key;
}

/**
 * Queries whose chosen metric varies the most over the window.
 *  - "variation" = coefficient of variation (exec-weighted stdev / exec-weighted avg), unitless
 *  - "stdev"     = exec-weighted average of the per-interval standard deviation, in metric units
 * Excludes queries run fewer than `minExec` times in the window.
 */
export function highVariationQuery(
  metricKey: string,
  agg: string,
  win: TimeWindow,
  minExec: number
): string {
  const m = METRIC_COLS[metricKey] ?? METRIC_COLS.duration;
  const b = m.base;
  const d = `${m.div}.0`;
  const me = Math.max(0, Math.floor(Number.isFinite(minExec) ? minExec : 0));
  const valueExpr =
    agg === "stdev"
      ? `SUM(rs.stdev_${b} * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / ${d}`
      : `SUM(rs.stdev_${b} * rs.count_executions) / NULLIF(SUM(rs.avg_${b} * rs.count_executions), 0)`;
  return `
SELECT TOP (25)
    q.query_id                              AS [QueryId],
    CAST(${valueExpr} AS decimal(18, 2))    AS [Variation],
    SUM(rs.count_executions)                AS [Executions],
    SUBSTRING(qt.query_sql_text, 1, 300)    AS [QueryText]
${RS_JOINS}
JOIN sys.query_store_query_text qt ON q.query_text_id = qt.query_text_id
WHERE ${windowPredicate("rsi.start_time", win)}
GROUP BY q.query_id, qt.query_sql_text
HAVING SUM(rs.count_executions) >= ${me}
ORDER BY [Variation] DESC;
`;
}

/* ---- Query Wait Statistics ---- */

/** Wait-time aggregate expression for the chosen statistic (result in ms). */
function waitAggExpr(agg: string): string {
  switch (agg) {
    case "avg":
      return "AVG(ws.avg_query_wait_time_ms)";
    case "max":
      return "MAX(ws.max_query_wait_time_ms)";
    case "min":
      return "MIN(ws.min_query_wait_time_ms)";
    case "stdev":
      return "AVG(ws.stdev_query_wait_time_ms)";
    case "total":
    default:
      return "SUM(ws.total_query_wait_time_ms)";
  }
}

/** TOP (n) clause, or empty for "all" (n <= 0). */
const topClause = (n: number): string =>
  Number.isFinite(n) && n > 0 ? `TOP (${Math.floor(n)})` : "";

export function waitsByCategoryQuery(agg: string, win: TimeWindow, topCats: number): string {
  return `
SELECT ${topClause(topCats)}
    ws.wait_category_desc                                AS [Category],
    CAST(${waitAggExpr(agg)} AS decimal(18, 2))          AS [WaitTimeMs],
    CAST(SUM(ws.total_query_wait_time_ms) AS decimal(18, 2)) AS [TotalWaitMs]
FROM sys.query_store_wait_stats ws
JOIN sys.query_store_runtime_stats_interval rsi ON ws.runtime_stats_interval_id = rsi.runtime_stats_interval_id
WHERE ${windowPredicate("rsi.start_time", win)}
GROUP BY ws.wait_category_desc
ORDER BY [WaitTimeMs] DESC;
`;
}

export function waitCategoryQueriesQuery(
  category: string,
  agg: string,
  win: TimeWindow,
  topQueries: number
): string {
  const cat = "N'" + category.replace(/'/g, "''") + "'";
  return `
SELECT ${topClause(topQueries)}
    q.query_id                                          AS [QueryId],
    CAST(${waitAggExpr(agg)} AS decimal(18, 2))         AS [WaitTimeMs],
    SUBSTRING(qt.query_sql_text, 1, 300)                AS [QueryText]
FROM sys.query_store_wait_stats ws
JOIN sys.query_store_runtime_stats_interval rsi ON ws.runtime_stats_interval_id = rsi.runtime_stats_interval_id
JOIN sys.query_store_plan p ON ws.plan_id = p.plan_id
JOIN sys.query_store_query q ON p.query_id = q.query_id
JOIN sys.query_store_query_text qt ON q.query_text_id = qt.query_text_id
WHERE ${windowPredicate("rsi.start_time", win)}
  AND ws.wait_category_desc = ${cat}
GROUP BY q.query_id, qt.query_sql_text
ORDER BY [WaitTimeMs] DESC;
`;
}

/**
 * Plan-summary series for the wait report: per plan, per interval bucket, the
 * wait time (chosen statistic) for one query and wait category, over time.
 */
export function waitPlanSummaryQuery(
  queryId: number,
  category: string,
  agg: string,
  win: TimeWindow,
  intervalMinutes: number
): string {
  const cat = "N'" + category.replace(/'/g, "''") + "'";
  const n = bucketOf(intervalMinutes);
  const bucket = `DATEADD(minute, (DATEDIFF(minute, '2000-01-01', rsi.start_time) / ${n}) * ${n}, CAST('2000-01-01' AS datetime2))`;
  return `
SELECT
    p.plan_id                                       AS [PlanId],
    CONVERT(varchar(19), ${bucket}, 126)            AS [IntervalStart],
    CONVERT(varchar(19), DATEADD(minute, ${n}, ${bucket}), 126) AS [IntervalEnd],
    ws.wait_category_desc                           AS [WaitCategory],
    CAST(p.is_forced_plan AS int)                   AS [Forced],
    CAST(${waitAggExpr(agg)} AS decimal(38, 2))     AS [Value],
    SUM(rs.count_executions)                        AS [Executions],
    CAST(SUM(ws.total_query_wait_time_ms) AS decimal(38, 2)) AS [Total],
    CAST(AVG(ws.avg_query_wait_time_ms) AS decimal(38, 2))   AS [Avg],
    CAST(MIN(ws.min_query_wait_time_ms) AS decimal(38, 2))   AS [Min],
    CAST(MAX(ws.max_query_wait_time_ms) AS decimal(38, 2))   AS [Max],
    CAST(AVG(ws.stdev_query_wait_time_ms) AS decimal(38, 2)) AS [StdDev]
FROM sys.query_store_wait_stats ws
JOIN sys.query_store_runtime_stats_interval rsi ON ws.runtime_stats_interval_id = rsi.runtime_stats_interval_id
JOIN sys.query_store_plan p ON ws.plan_id = p.plan_id
LEFT JOIN sys.query_store_runtime_stats rs
    ON rs.plan_id = ws.plan_id
   AND rs.runtime_stats_interval_id = ws.runtime_stats_interval_id
   AND rs.execution_type = ws.execution_type
WHERE p.query_id = ${intOf(queryId)}
  AND ws.wait_category_desc = ${cat}
  AND ${windowPredicate("rsi.start_time", win)}
GROUP BY p.plan_id, ${bucket}, ws.wait_category_desc, p.is_forced_plan
ORDER BY [IntervalStart];
`;
}

/* ---- Queries With Forced Plans ---- */

export function forcedPlansQuery(topN: number, minPlans: number): string {
  const topClause = topN > 0 ? `TOP (${intOf(topN)}) ` : "";
  // Min-plans filter: only include queries that have at least N total plans.
  const minPlansFilter = minPlans > 1
    ? `AND (SELECT COUNT(*) FROM sys.query_store_plan p2 WHERE p2.query_id = q.query_id) >= ${intOf(minPlans)}`
    : "";
  return `
SELECT ${topClause}q.query_id                                       AS [QueryId],
    SUBSTRING(qt.query_sql_text, 1, 400)             AS [QueryText],
    p.plan_id                                        AS [ForcedPlanId],
    p.force_failure_count                            AS [ForceFailureCount],
    CONVERT(varchar(19), p.last_execution_time, 126) AS [LastExecution]
FROM sys.query_store_plan p
JOIN sys.query_store_query q  ON p.query_id = q.query_id
JOIN sys.query_store_query_text qt ON q.query_text_id = qt.query_text_id
WHERE p.is_forced_plan = 1
  ${minPlansFilter}
ORDER BY q.query_id;`;
}

/* ---- Query Store options (Properties dialog) ---- */

export const QS_OPTIONS = `
SELECT actual_state_desc, current_storage_size_mb, max_storage_size_mb,
       query_capture_mode_desc, size_based_cleanup_mode_desc, stale_query_threshold_days,
       max_plans_per_query, wait_stats_capture_mode_desc,
       flush_interval_seconds, interval_length_minutes
FROM sys.database_query_store_options;
`;

export interface QueryStoreOptions {
  operation_mode: string; // OFF | READ_ONLY | READ_WRITE
  max_storage_size_mb: string;
  query_capture_mode: string; // ALL | AUTO | NONE
  size_based_cleanup_mode: string; // AUTO | OFF
  stale_query_threshold_days: string;
  max_plans_per_query: string;
  wait_stats_capture_mode: string; // ON | OFF
  flush_interval_seconds: string;
  interval_length_minutes: string;
}

const intOr = (v: string, fallback: number): string =>
  v !== "" && !isNaN(Number(v)) ? String(Math.floor(Number(v))) : String(fallback);

/** Build ALTER DATABASE ... SET QUERY_STORE from the edited options. */
export function buildQueryStoreAlter(o: QueryStoreOptions): string {
  if (o.operation_mode === "OFF") {
    return "ALTER DATABASE CURRENT SET QUERY_STORE = OFF;";
  }
  const mode = o.operation_mode === "READ_ONLY" ? "READ_ONLY" : "READ_WRITE";
  const capture = ["ALL", "AUTO", "NONE"].includes(o.query_capture_mode)
    ? o.query_capture_mode
    : "AUTO";
  const cleanup = o.size_based_cleanup_mode === "OFF" ? "OFF" : "AUTO";
  const waits = o.wait_stats_capture_mode === "OFF" ? "OFF" : "ON";
  return [
    "ALTER DATABASE CURRENT SET QUERY_STORE = ON",
    "(",
    `    OPERATION_MODE = ${mode},`,
    `    MAX_STORAGE_SIZE_MB = ${intOr(o.max_storage_size_mb, 1000)},`,
    `    QUERY_CAPTURE_MODE = ${capture},`,
    `    SIZE_BASED_CLEANUP_MODE = ${cleanup},`,
    `    CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = ${intOr(o.stale_query_threshold_days, 30)}),`,
    `    MAX_PLANS_PER_QUERY = ${intOr(o.max_plans_per_query, 200)},`,
    `    WAIT_STATS_CAPTURE_MODE = ${waits},`,
    `    DATA_FLUSH_INTERVAL_SECONDS = ${intOr(o.flush_interval_seconds, 900)},`,
    `    INTERVAL_LENGTH_MINUTES = ${intOr(o.interval_length_minutes, 60)}`,
    ");",
  ].join("\n");
}
