/**
 * SQL catalog for Always On availability groups (under Always On High
 * Availability). Reads from sys.availability_groups, sys.availability_replicas,
 * and sys.dm_hadr_availability_replica_states. Gated to boxed SQL Server /
 * Managed Instance with HADR enabled (not Azure SQL DB).
 */

/** N'...' literal with single quotes doubled (values come from catalog rows). */
function nLiteral(value: string): string {
  return "N'" + value.replace(/'/g, "''") + "'";
}

/** Bracket-quote an identifier (e.g. an availability group name). */
function bracket(name: string): string {
  return "[" + name.replace(/]/g, "]]") + "]";
}

export const AVAILABILITY_GROUPS = `
SELECT name
FROM sys.availability_groups
ORDER BY name;
`;

/** Replicas of one AG with their seeding mode and current role. */
export function replicasForGroup(agName: string): string {
  return `
SELECT
    ar.replica_server_name                       AS [Name],
    ar.seeding_mode_desc                         AS [SeedingMode],
    ISNULL(rs.role_desc, N'UNKNOWN')             AS [Role]
FROM sys.availability_replicas ar
JOIN sys.availability_groups ag ON ag.group_id = ar.group_id
LEFT JOIN sys.dm_hadr_availability_replica_states rs
       ON rs.replica_id = ar.replica_id
WHERE ag.name = ${nLiteral(agName)}
ORDER BY ar.replica_server_name;
`;
}

/** Current seeding mode for one replica, for the Properties form. */
export function replicaSeeding(agName: string, replicaName: string): string {
  return `
SELECT ar.seeding_mode_desc AS seeding_mode
FROM sys.availability_replicas ar
JOIN sys.availability_groups ag ON ag.group_id = ar.group_id
WHERE ag.name = ${nLiteral(agName)}
  AND ar.replica_server_name = ${nLiteral(replicaName)};
`;
}

/** The current primary replica of an AG plus this connection's own server
 * name, so a command can tell whether it's connected to the primary.
 * MODIFY REPLICA must run on the primary. */
export function agPrimaryReplica(agName: string): string {
  return `
SELECT
    ISNULL(ags.primary_replica, N'')                     AS primary_replica,
    CAST(SERVERPROPERTY('ServerName') AS nvarchar(256))  AS local_server
FROM sys.availability_groups ag
LEFT JOIN sys.dm_hadr_availability_group_states ags ON ags.group_id = ag.group_id
WHERE ag.name = ${nLiteral(agName)};
`;
}

export type SeedingMode = "AUTOMATIC" | "MANUAL";

/** ALTER to turn Automatic Seeding on (AUTOMATIC) or off (MANUAL) for a
 * replica. SEEDING_MODE is a per-replica attribute in SQL Server. */
export function buildSeedingModeAlter(
  agName: string,
  replicaName: string,
  mode: SeedingMode
): string {
  const m = mode === "AUTOMATIC" ? "AUTOMATIC" : "MANUAL";
  return `ALTER AVAILABILITY GROUP ${bracket(agName)}
MODIFY REPLICA ON ${nLiteral(replicaName)}
WITH (SEEDING_MODE = ${m});`;
}
