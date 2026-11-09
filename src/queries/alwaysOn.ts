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

/** This connection's own server name (SERVERPROPERTY('ServerName')), used to
 * prefill the primary replica when creating a new AG. */
export const LOCAL_SERVER_NAME = `
SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(256)) AS local_server;
`;

/** The connected instance's SQL Server major version (e.g. 17 for 2025), used
 * to gate version-specific AG features and to build the replica version guard. */
export const SERVER_MAJOR_VERSION = `
SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major;
`;

/** Minimum SQL Server major version for each version-gated AG feature. */
export const FEATURE_MIN_MAJOR = {
  /** SEEDING_MODE / automatic seeding (SQL 2016). */
  seeding: 13,
  /** DB_FAILOVER database-level health detection (SQL 2016). */
  dbFailover: 13,
  /** DTC_SUPPORT = PER_DB (SQL 2016). */
  dtc: 13,
  /** REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT (SQL 2017). */
  requiredSecondaries: 14,
  /** CLUSTER_TYPE NONE/EXTERNAL and CONFIGURATION_ONLY replicas (SQL 2017). */
  clusterless: 14,
} as const;

/** The guard, run on a joining secondary, that blocks the JOIN when the
 * secondary's SQL Server major version is older than the primary's. A replica
 * must be the same or a higher major version than the primary. */
function versionGuard(primaryMajor: number): string {
  return `IF CAST(SERVERPROPERTY('ProductMajorVersion') AS int) < ${primaryMajor}
  THROW 50000, N'This instance is an older SQL Server major version than the primary (major ${primaryMajor}). An availability replica must be the same or a higher major version.', 1;`;
}

/** The databases belonging to an AG (as known on this replica), so a removal
 * flow can name them when offering to drop them from a removed server. */
export function agDatabases(agName: string): string {
  return `
SELECT adc.database_name AS database_name
FROM sys.availability_databases_cluster adc
JOIN sys.availability_groups ag ON ag.group_id = adc.group_id
WHERE ag.name = ${nLiteral(agName)}
ORDER BY adc.database_name;
`;
}

/** The current primary replica's endpoint URL, used to derive the domain
 * suffix so an added replica's endpoint can default to an FQDN (short names
 * often don't resolve between AG nodes). */
export function primaryEndpointUrl(agName: string): string {
  return `
SELECT TOP 1 ar.endpoint_url AS endpoint_url
FROM sys.availability_replicas ar
JOIN sys.availability_groups ag ON ag.group_id = ar.group_id
JOIN sys.dm_hadr_availability_replica_states rs
     ON rs.replica_id = ar.replica_id AND rs.role_desc = N'PRIMARY'
WHERE ag.name = ${nLiteral(agName)};
`;
}

/** AG-level options for the AG Properties dialog. */
export function agProperties(agName: string): string {
  return `
SELECT
    ag.automated_backup_preference_desc                     AS backup_pref,
    CAST(ag.health_check_timeout AS nvarchar(20))           AS health_check_timeout,
    CAST(ag.db_failover AS int)                             AS db_failover,
    CAST(ISNULL(ag.required_synchronized_secondaries_to_commit, 0) AS nvarchar(20))
                                                            AS required_secondaries
FROM sys.availability_groups ag
WHERE ag.name = ${nLiteral(agName)};
`;
}

/** Full per-replica configuration for the AG Properties grid. */
export function replicaConfig(agName: string): string {
  return `
SELECT
    ar.replica_server_name                           AS server,
    ISNULL(rs.role_desc, N'RESOLVING')               AS role,
    ar.availability_mode_desc                        AS availability_mode,
    ar.failover_mode_desc                            AS failover_mode,
    ar.primary_role_allow_connections_desc           AS primary_connections,
    ar.secondary_role_allow_connections_desc         AS readable_secondary,
    ar.seeding_mode_desc                             AS seeding_mode,
    CAST(ar.session_timeout AS nvarchar(20))         AS session_timeout
FROM sys.availability_replicas ar
JOIN sys.availability_groups ag ON ag.group_id = ar.group_id
LEFT JOIN sys.dm_hadr_availability_replica_states rs ON rs.replica_id = ar.replica_id
WHERE ag.name = ${nLiteral(agName)}
ORDER BY CASE WHEN rs.role_desc = N'PRIMARY' THEN 0 ELSE 1 END, ar.replica_server_name;
`;
}

/** One replica's editable settings (values are the T-SQL tokens). */
export interface ReplicaEdit {
  server: string;
  availabilityMode: string;
  failoverMode: string;
  primaryConnections: string;
  readableSecondary: string;
  seedingMode: string;
  sessionTimeout: string;
}

/** ALTER ... MODIFY REPLICA statements for whatever changed on one replica.
 * One statement per changed attribute keeps each independently valid. */
export function buildModifyReplica(
  agName: string,
  before: ReplicaEdit,
  after: ReplicaEdit
): string {
  const ag = bracket(agName);
  const on = nLiteral(after.server);
  const mod = (opt: string): string =>
    `ALTER AVAILABILITY GROUP ${ag} MODIFY REPLICA ON ${on} WITH (${opt});`;
  const s: string[] = [];
  if (after.availabilityMode !== before.availabilityMode) {
    s.push(mod(`AVAILABILITY_MODE = ${after.availabilityMode}`));
  }
  if (after.failoverMode !== before.failoverMode) {
    s.push(mod(`FAILOVER_MODE = ${after.failoverMode}`));
  }
  if (after.seedingMode !== before.seedingMode) {
    s.push(mod(`SEEDING_MODE = ${after.seedingMode}`));
  }
  if (after.sessionTimeout !== before.sessionTimeout && /^\d+$/.test(after.sessionTimeout)) {
    s.push(mod(`SESSION_TIMEOUT = ${after.sessionTimeout}`));
  }
  if (after.primaryConnections !== before.primaryConnections) {
    s.push(mod(`PRIMARY_ROLE (ALLOW_CONNECTIONS = ${after.primaryConnections})`));
  }
  if (after.readableSecondary !== before.readableSecondary) {
    s.push(mod(`SECONDARY_ROLE (ALLOW_CONNECTIONS = ${after.readableSecondary})`));
  }
  return s.join("\n");
}

/** ALTER ... SET statements for whatever AG-level options changed. */
export function buildAgLevelAlter(
  agName: string,
  before: AgOptions,
  after: AgOptions
): string {
  const ag = bracket(agName);
  const s: string[] = [];
  if (after.backupPref !== before.backupPref) {
    s.push(`ALTER AVAILABILITY GROUP ${ag} SET (AUTOMATED_BACKUP_PREFERENCE = ${after.backupPref});`);
  }
  if (after.healthCheckTimeout !== before.healthCheckTimeout && /^\d+$/.test(after.healthCheckTimeout)) {
    s.push(`ALTER AVAILABILITY GROUP ${ag} SET (HEALTH_CHECK_TIMEOUT = ${after.healthCheckTimeout});`);
  }
  if (after.dbFailover !== before.dbFailover) {
    s.push(`ALTER AVAILABILITY GROUP ${ag} SET (DB_FAILOVER = ${after.dbFailover ? "ON" : "OFF"});`);
  }
  if (after.requiredSecondaries !== before.requiredSecondaries && /^\d+$/.test(after.requiredSecondaries)) {
    s.push(`ALTER AVAILABILITY GROUP ${ag} SET (REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = ${after.requiredSecondaries});`);
  }
  return s.join("\n");
}

export type AvailabilityMode = "SYNCHRONOUS_COMMIT" | "ASYNCHRONOUS_COMMIT";
export type FailoverMode = "AUTOMATIC" | "MANUAL";
export type ClusterType = "WSFC" | "NONE" | "EXTERNAL";

/** One replica's definition for CREATE AVAILABILITY GROUP / ADD REPLICA. */
export interface ReplicaSpec {
  server: string;
  endpointUrl: string;
  availabilityMode: AvailabilityMode;
  failoverMode: FailoverMode;
  seedingMode: SeedingMode;
}

/** One `N'server' WITH (...)` replica clause. */
function replicaClause(r: ReplicaSpec): string {
  return `${nLiteral(r.server)} WITH (
    ENDPOINT_URL = ${nLiteral(r.endpointUrl)},
    AVAILABILITY_MODE = ${r.availabilityMode},
    FAILOVER_MODE = ${r.failoverMode},
    SEEDING_MODE = ${r.seedingMode},
    SECONDARY_ROLE(ALLOW_CONNECTIONS = ALL),
    PRIMARY_ROLE(ALLOW_CONNECTIONS = ALL)
  )`;
}

/** The TCP listener port from an endpoint URL like `TCP://host:5022`
 * (defaults to 5022 when none is present). */
function endpointPort(url: string): number {
  const m = url.match(/:(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 5022;
}

/** Idempotent database-mirroring (Always On) endpoint on the given port. Only
 * one DATABASE_MIRRORING endpoint is allowed per instance, so the guard skips
 * creation when one already exists (e.g. a server already in another AG). */
function createEndpointStmt(port: number): string {
  return `IF NOT EXISTS (SELECT 1 FROM sys.database_mirroring_endpoints)
  CREATE ENDPOINT [Hadr_endpoint]
    STATE = STARTED
    AS TCP (LISTENER_PORT = ${port})
    FOR DATABASE_MIRRORING (ROLE = ALL);`;
}

/** The commands a *secondary* replica must run itself to join the AG: create
 * its mirroring endpoint (on the port from its own endpoint URL), join, and —
 * for automatic seeding — grant CREATE ANY DATABASE. Returned as a block
 * comment so it can ride along in the script the user runs on each secondary. */
function secondaryJoinBlock(
  agName: string,
  clusterType: ClusterType,
  secondaries: ReplicaSpec[],
  primaryMajor: number
): string {
  if (secondaries.length === 0) {
    return "";
  }
  const join =
    clusterType === "WSFC"
      ? `ALTER AVAILABILITY GROUP ${bracket(agName)} JOIN;`
      : `ALTER AVAILABILITY GROUP ${bracket(agName)} JOIN WITH (CLUSTER_TYPE = ${clusterType});`;
  const blocks = secondaries
    .map((r) => {
      const grant =
        r.seedingMode === "AUTOMATIC"
          ? `\nALTER AVAILABILITY GROUP ${bracket(agName)} GRANT CREATE ANY DATABASE;`
          : "";
      return `-- On ${r.server}:\n${versionGuard(primaryMajor)}\n${createEndpointStmt(endpointPort(r.endpointUrl))}\n${join}${grant}`;
    })
    .join("\n\n");
  return `\n\n/* =====================================================================
   Run on EACH SECONDARY replica. This extension drives only the primary
   connection, so each secondary must create its endpoint and join itself.
   If the instances run under different service accounts, also grant each one
   CONNECT on [Hadr_endpoint] (GRANT CONNECT ON ENDPOINT::[Hadr_endpoint]
   TO [login]) so the replicas can communicate.
   =====================================================================

${blocks}

   ===================================================================== */`;
}

export interface CreateAgOptions {
  name: string;
  clusterType: ClusterType;
  databases: string[];
  automatedBackupPreference: string;
  dbFailover: boolean;
  /** DTC_SUPPORT = PER_DB (SQL 2016+); set only when supported + requested. */
  dtcSupport: boolean;
  replicas: ReplicaSpec[];
  /** The primary's (connected instance's) SQL Server major version. */
  primaryMajor: number;
}

/** CREATE AVAILABILITY GROUP on the primary, with the secondaries' JOIN
 * commands appended as a block comment. The first replica is the primary. */
export function buildCreateAg(opts: CreateAgOptions): string {
  const withParts = [
    `AUTOMATED_BACKUP_PREFERENCE = ${opts.automatedBackupPreference}`,
    `DB_FAILOVER = ${opts.dbFailover ? "ON" : "OFF"}`,
  ];
  if (opts.dtcSupport) {
    withParts.push(`DTC_SUPPORT = PER_DB`);
  }
  withParts.push(`CLUSTER_TYPE = ${opts.clusterType}`);
  const withOpts = withParts.join(",\n  ");
  const forDbs =
    opts.databases.length > 0
      ? `\nFOR DATABASE ${opts.databases.map(bracket).join(", ")}`
      : "";
  const replicaList = opts.replicas.map(replicaClause).join(",\n  ");
  // The primary's mirroring endpoint must exist before CREATE; make it here
  // (no-op if one already exists), using the port from the primary's URL.
  const primaryEndpoint = createEndpointStmt(endpointPort(opts.replicas[0].endpointUrl));
  const create = `${primaryEndpoint}

CREATE AVAILABILITY GROUP ${bracket(opts.name)}
WITH (
  ${withOpts}
)${forDbs}
REPLICA ON
  ${replicaList};`;
  return (
    create +
    secondaryJoinBlock(opts.name, opts.clusterType, opts.replicas.slice(1), opts.primaryMajor)
  );
}

/** DROP AVAILABILITY GROUP (run on the primary / a WSFC node). */
export function buildDropAg(agName: string): string {
  return `DROP AVAILABILITY GROUP ${bracket(agName)};`;
}

/** ADD REPLICA on the primary, with the new secondary's JOIN block appended. */
export function buildAddReplica(
  agName: string,
  clusterType: ClusterType,
  r: ReplicaSpec,
  primaryMajor: number
): string {
  const add = `ALTER AVAILABILITY GROUP ${bracket(agName)}
ADD REPLICA ON ${replicaClause(r)};`;
  return add + secondaryJoinBlock(agName, clusterType, [r], primaryMajor);
}

/** The executable secondary-side join for one replica: version guard, create
 * endpoint (if missing), JOIN, and — for automatic seeding — GRANT CREATE ANY
 * DATABASE. Meant to run *on the secondary* (unlike the commented block that
 * {@link buildAddReplica} appends for manual use). */
export function buildReplicaJoin(
  agName: string,
  clusterType: ClusterType,
  r: ReplicaSpec,
  primaryMajor: number
): string {
  const join =
    clusterType === "WSFC"
      ? `ALTER AVAILABILITY GROUP ${bracket(agName)} JOIN;`
      : `ALTER AVAILABILITY GROUP ${bracket(agName)} JOIN WITH (CLUSTER_TYPE = ${clusterType});`;
  const grant =
    r.seedingMode === "AUTOMATIC"
      ? `\nALTER AVAILABILITY GROUP ${bracket(agName)} GRANT CREATE ANY DATABASE;`
      : "";
  return `${versionGuard(primaryMajor)}
${createEndpointStmt(endpointPort(r.endpointUrl))}
${join}${grant}`;
}

/** REMOVE REPLICA on the primary. */
export function buildRemoveReplica(agName: string, replicaName: string): string {
  return `ALTER AVAILABILITY GROUP ${bracket(agName)}
REMOVE REPLICA ON ${nLiteral(replicaName)};`;
}

/** A DROP DATABASE script for the databases left behind on a removed replica. */
export function buildDropDatabases(
  agName: string,
  server: string,
  databases: string[]
): string {
  const header = `-- Run on the removed replica (${server}).
-- After leaving availability group [${agName}], these databases remain on that
-- server (typically in a RESTORING/standalone state). This drops them there.`;
  const drops = databases.map((d) => `DROP DATABASE ${bracket(d)};`).join("\n");
  return `${header}\n${drops}\n`;
}

export interface AgOptions {
  backupPref: string;
  healthCheckTimeout: string;
  dbFailover: boolean;
  requiredSecondaries: string;
}

/** ALTER AVAILABILITY GROUP ... SET (...) statements for changed AG options,
 * plus per-replica SEEDING_MODE MODIFY for replicas whose seeding changed. */
export function buildAgOptionsAlter(
  agName: string,
  before: AgOptions,
  after: AgOptions,
  seedingBefore: Record<string, SeedingMode>,
  seedingAfter: Record<string, SeedingMode>
): string {
  const ag = bracket(agName);
  const stmts: string[] = [];
  if (after.backupPref !== before.backupPref) {
    stmts.push(`ALTER AVAILABILITY GROUP ${ag} SET (AUTOMATED_BACKUP_PREFERENCE = ${after.backupPref});`);
  }
  if (after.healthCheckTimeout !== before.healthCheckTimeout && /^\d+$/.test(after.healthCheckTimeout)) {
    stmts.push(`ALTER AVAILABILITY GROUP ${ag} SET (HEALTH_CHECK_TIMEOUT = ${after.healthCheckTimeout});`);
  }
  if (after.dbFailover !== before.dbFailover) {
    stmts.push(`ALTER AVAILABILITY GROUP ${ag} SET (DB_FAILOVER = ${after.dbFailover ? "ON" : "OFF"});`);
  }
  if (after.requiredSecondaries !== before.requiredSecondaries && /^\d+$/.test(after.requiredSecondaries)) {
    stmts.push(`ALTER AVAILABILITY GROUP ${ag} SET (REQUIRED_SYNCHRONIZED_SECONDARIES_TO_COMMIT = ${after.requiredSecondaries});`);
  }
  for (const [replica, mode] of Object.entries(seedingAfter)) {
    if (seedingBefore[replica] !== mode) {
      stmts.push(buildSeedingModeAlter(agName, replica, mode));
    }
  }
  return stmts.join("\n");
}
