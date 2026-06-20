/**
 * SQL catalog for Resource Governor (under Management).
 * All reads from sys.resource_governor_* catalog views. Resource Governor is a
 * boxed-product feature (not available on Azure SQL DB / Managed Instance).
 */

/** N'...' literal with single quotes doubled (values come from catalog rows). */
function nLiteral(value: string): string {
  return "N'" + value.replace(/'/g, "''") + "'";
}

/** System pools are the well-known 'default' and 'internal' (as in SSMS). */
export function isSystemPoolName(name: string): boolean {
  return name === "default" || name === "internal";
}

export const RESOURCE_POOLS = `
SELECT pool_id, name
FROM sys.resource_governor_resource_pools
ORDER BY name;
`;

export function workloadGroupsForPool(poolId: number): string {
  const id = Number.isInteger(poolId) ? poolId : -1;
  return `
SELECT name
FROM sys.resource_governor_workload_groups
WHERE pool_id = ${id}
ORDER BY name;
`;
}

export function workloadGroupDetails(name: string): string {
  return `
SELECT
    g.name                                  AS [Name],
    g.importance                            AS [Importance],
    g.request_max_memory_grant_percent      AS [MaxMemoryGrantPct],
    g.request_max_cpu_time_sec              AS [MaxCpuTimeSec],
    g.request_memory_grant_timeout_sec      AS [MemGrantTimeoutSec],
    g.max_dop                               AS [MaxDOP],
    g.group_max_requests                    AS [MaxRequests],
    p.name                                  AS [ResourcePool]
FROM sys.resource_governor_workload_groups g
JOIN sys.resource_governor_resource_pools p ON g.pool_id = p.pool_id
WHERE g.name = ${nLiteral(name)};
`;
}

export const EXTERNAL_RESOURCE_POOLS = `
SELECT external_pool_id, name
FROM sys.resource_governor_external_resource_pools
ORDER BY name;
`;

/** Resource Governor configuration: enabled state + classifier function. */
export const RG_CONFIGURATION = `
SELECT
    CAST(c.is_enabled AS int)                       AS is_enabled,
    OBJECT_SCHEMA_NAME(c.classifier_function_id)    AS classifier_schema,
    OBJECT_NAME(c.classifier_function_id)           AS classifier_name
FROM sys.resource_governor_configuration c;
`;

/** Full settings lists for the Properties dialog. */
export const RESOURCE_POOLS_FULL = `
SELECT name, min_cpu_percent, max_cpu_percent, cap_cpu_percent,
       min_memory_percent, max_memory_percent, min_iops_per_volume, max_iops_per_volume
FROM sys.resource_governor_resource_pools
ORDER BY name;
`;

export const WORKLOAD_GROUPS_FULL = `
SELECT g.name, g.importance, g.request_max_memory_grant_percent,
       g.request_max_cpu_time_sec, g.request_memory_grant_timeout_sec,
       g.max_dop, g.group_max_requests, p.name AS pool
FROM sys.resource_governor_workload_groups g
JOIN sys.resource_governor_resource_pools p ON g.pool_id = p.pool_id
ORDER BY p.name, g.name;
`;

export const EXTERNAL_POOLS_FULL = `
SELECT name, max_cpu_percent, max_memory_percent, max_processes
FROM sys.resource_governor_external_resource_pools
ORDER BY name;
`;

/** Scalar functions eligible to be a Resource Governor classifier. */
export const CLASSIFIER_CANDIDATES = `
SELECT QUOTENAME(SCHEMA_NAME(o.schema_id)) + N'.' + QUOTENAME(o.name) AS func
FROM sys.objects o
WHERE o.type IN ('FN')
ORDER BY func;
`;

/** Full rows for DDL generation (all columns). */
export function resourcePoolRow(name: string): string {
  return `SELECT * FROM sys.resource_governor_resource_pools WHERE name = ${nLiteral(name)};`;
}

export function workloadGroupRow(name: string): string {
  return `
SELECT g.*, p.name AS ResourcePool
FROM sys.resource_governor_workload_groups g
JOIN sys.resource_governor_resource_pools p ON g.pool_id = p.pool_id
WHERE g.name = ${nLiteral(name)};
`;
}

export function externalPoolRow(name: string): string {
  return `SELECT * FROM sys.resource_governor_external_resource_pools WHERE name = ${nLiteral(name)};`;
}

export function externalPoolDetails(name: string): string {
  return `
SELECT
    name                 AS [Name],
    max_cpu_percent      AS [MaxCpuPct],
    max_memory_percent   AS [MaxMemoryPct],
    max_processes        AS [MaxProcesses]
FROM sys.resource_governor_external_resource_pools
WHERE name = ${nLiteral(name)};
`;
}
