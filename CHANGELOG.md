# Changelog

All notable changes to **SSMS Tools for SQL Server** are documented here.

## [0.4.0] - 2026-11-08

### Added
- **Availability Group lifecycle** under Always On High Availability, mirroring SSMS right-click actions:
  - **New Availability Group** (right-click **Availability Groups**) — name, cluster type, databases,
    automated backup preference, database-level health detection, and one or more replicas. Creates the
    AG on the connected (primary) instance; because the extension drives only the primary connection,
    each secondary's endpoint creation, `JOIN`, and `GRANT CREATE ANY DATABASE` (for automatic
    seeding) is emitted as a ready-to-run block in the script to run on that secondary. The
    database-mirroring (`Hadr_endpoint`) endpoint is created if missing — on the primary as part of
    the applied batch and on each secondary in its block — using the TCP port from that replica's
    endpoint URL in the Replicas box.
  - **Availability Group Properties** (right-click an **AG**) — an SSMS-style per-replica grid
    (Availability Mode, Failover Mode, Connections in Primary Role, Readable Secondary, Seeding Mode,
    Session Timeout), scaling to any number of replicas, plus AG-level settings below it: Automated
    Backup Preference, Required Synchronized Secondaries To Commit, Health Check Timeout, and Database
    Level Health Detection. Only the changed settings are scripted/applied (one `MODIFY REPLICA` per
    changed attribute, `SET` for AG options).
  - **Delete** (right-click an **AG**) — `DROP AVAILABILITY GROUP` after a modal confirm; databases are
    left in place.
  - **Add Replica** (right-click **Availability Replicas**) — server, endpoint URL, availability mode,
    failover mode, and seeding mode; `ADD REPLICA` runs on the primary, then offers to **connect to the
    new secondary and create its endpoint + `JOIN` automatically** (via the SQL Server extension's
    connection dialog). Declining leaves the ready-to-run `JOIN` script for that server.
  - **Remove from Availability Group** (right-click a **replica**) — `REMOVE REPLICA` on the primary,
    then offers to generate a `DROP DATABASE` script (naming each AG database) to run on the removed
    server, where those databases are left behind.
  - All AG-config actions keep the primary-only guard: acting from a secondary warns and offers Script.
  - **Version awareness**: settings that need a newer SQL Server are hidden/disabled based on the
    connected instance's major version (Seeding Mode & Database Level Health Detection need 2016+,
    Required Synchronized Secondaries & `CONFIGURATION_ONLY`/`CLUSTER_TYPE NONE|EXTERNAL` need 2017+),
    and **New Availability Group** gains a **Per-Database DTC Support** (`DTC_SUPPORT = PER_DB`, 2016+)
    checkbox. A replica must be the same or a higher major version than the primary: New AG / Add Replica
    offer an optional up-front check (via the SQL Server extension's connection dialog), and every
    generated secondary `JOIN` block also self-checks and aborts with a clear error if the version is lower.

### Changed
- The Automatic Seeding control moved from per-replica **Properties** to the **Availability Group
  Properties** dialog (per replica). Replica right-click now offers **Remove from Availability Group**.

## [0.3.1] - 2026-11-08

### Fixed
- **Open in SSMS Tools** (server right-click) failed with `this.ext.connect is not a function`
  on current SQL Server (mssql) builds, whose Connection Sharing API object does not expose the
  top-level `connect`. The command now connects through the Connection Sharing service using the
  server node's saved-connection id (falling back to the legacy top-level `connect` when present),
  and the resolved connection id is threaded through the pinned connection so per-database features
  work too.

## [0.3.0] - 2026-11-08

### Added
- **Always On High Availability** branch (shown on HADR-enabled on-premises / Managed Instance
  servers), mirroring SSMS:
  - **Availability Groups → _AG_ → Availability Replicas**, each replica showing its current role
    and seeding mode (e.g. `PRIMARY · Seeding: AUTOMATIC`).
  - **Availability Replica Properties** — right-click a replica to turn **Automatic Seeding** on
    (`AUTOMATIC`) or off (`MANUAL`); OK applies the `ALTER AVAILABILITY GROUP … MODIFY REPLICA …
    WITH (SEEDING_MODE = …)` and Script opens it in a SQL editor.
  - Primary-only guard: opening the Properties dialog while connected to a secondary warns that the
    change must run on the primary (naming it), since `MODIFY REPLICA` is primary-only.

## [0.2.0] - 2026-06-20

### Added
- **Query Store** branch under each Query Store-enabled database, mirroring the SSMS reports:
  - **Regressed Queries** — queries that got worse versus a preceding baseline.
  - **Overall Resource Consumption** — total Duration, Execution Count, CPU, and Logical Reads
    bucketed over time; click any bar to drill into the top queries for that time bucket.
  - **Top Resource Consuming Queries** — ranked by a chosen metric and statistic.
  - **Queries With Forced Plans** — split view with a plan-summary chart and Force/Unforce/Open Plan.
  - **Queries With High Variation** — ranked by variability (coefficient of variation or std dev).
  - **Query Wait Statistics** — wait categories with a per-query plan-summary chart.
  - **Tracked Queries** — track a specific Query Id's plans over time.
- Shared plan-summary **bubble chart** across reports (execution-count sizing, forced-plan rings,
  hover tooltips) and graphical **showplan** open via the mssql plan viewer.
- **Database Properties** / **Query Store Properties** — right-click a database for an editable
  Query Store settings dialog (operation mode, capture mode, sizing, intervals); applying refreshes
  the database list from the server so a database that just turned Query Store on/off gains or loses
  its Query Store folder.

### Changed
- Databases with Query Store disabled now appear as plain nodes (no "Query Store off" label).

## [0.1.2] - 2026-06-19

### Added
- Azure SQL Database branch (shown on Azure SQL DB):
  - **Event Log** viewer over `sys.event_log` (connectivity/login events), filterable by severity, date range, and text.
  - **Resource Usage** per database over `sys.resource_stats`, with optional start/end date filters.
- Click-to-sort on all grid panes (Backup History, Job History, Log viewer, Event Log, Resource Usage, and generic grids) — numeric-aware, click a header to sort, click again to reverse.

## [0.1.1] - 2026-06-19

### Changed
- Updated repository, issues, and homepage URLs to the `DC-AC/vscode-ssms` GitHub org.

## [0.1.0] - 2026-06-19

First public release.

### Management
- Backup / Restore History with server-side filtering (database, type, date range).
- SQL Server Logs viewer (current + archives) with date, message-text, source, and sort filters.
- Database Mail (sent items, profiles).
- Resource Governor tree (resource pools → workload groups, external pools) with an editable
  Properties dialog and Script as CREATE/ALTER for user-defined objects.

### SQL Server Agent
- Jobs tree with Steps and Schedules; filterable Job History.
- Full Job editor (General, Steps, full-recurrence Schedules) with New / Edit / Delete.
- Alerts, Operators, and Proxies with New / Edit / Delete.
- Operators include pager duty schedule and per-alert notifications.
- Proxies grouped by subsystem, with credential, subsystem grants, and principals.
- SQL Agent Error Logs viewer.

### Platform
- Connection reuse via the mssql Connection Sharing API.
- Edition-aware tree (on-premises, Azure SQL Managed Instance, Azure SQL Database).
- All changes are scriptable before they are applied.
