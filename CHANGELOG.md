# Changelog

All notable changes to **SSMS Tools for SQL Server** are documented here.

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
