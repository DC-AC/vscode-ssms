# SSMS Tools for SQL Server

Brings **SQL Server Management Studio (SSMS)** style server management into VS Code,
on top of the official
[SQL Server (mssql)](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql)
extension. It fills the gap between mssql and SSMS — without duplicating what mssql
already does (connections, query editing, the Databases/Security object trees).

## Features

A dedicated **SSMS Tools** view appears in the activity bar. It follows your active
SQL connection (or right-click a server in the SQL Server view → **Open in SSMS Tools**)
and surfaces the server-management tree SSMS has but mssql doesn't:

### Management
- **Backup / Restore History** — filterable by database, type, and date range.
- **SQL Server Logs** — current + archives, filterable by date, message text, source, and sort.
- **Database Mail** — sent items and profiles.
- **Resource Governor** — Resource Pools → Workload Groups, External Resource Pools, with an
  editable **Properties** dialog (enable/disable, edit pools/groups, classifier) and
  **Script as CREATE/ALTER** on user-defined objects.
- **Database Properties** — right-click any database for an editable **Query Store** settings
  dialog (operation mode, capture mode, max size, intervals). Applying turns Query Store on/off
  and refreshes the tree from the server.

### Query Store

Each Query Store-enabled database gets a **Query Store** folder with the SSMS reports:

- **Regressed Queries** — queries that regressed versus a preceding baseline.
- **Overall Resource Consumption** — total Duration, Execution Count, CPU, and Logical Reads
  bucketed over time; click a bar to drill into the top queries for that bucket.
- **Top Resource Consuming Queries** — ranked by a chosen metric and statistic.
- **Queries With Forced Plans** — plan-summary chart with **Force / Unforce / Open Plan**.
- **Queries With High Variation** — ranked by variability (coefficient of variation or std dev).
- **Query Wait Statistics** — wait categories with a per-query plan-summary chart.
- **Tracked Queries** — follow a specific Query Id's plans over time.

Reports share a plan-summary **bubble chart** (execution-count sizing, forced-plan rings, hover
tooltips) and can open the graphical **showplan** in the mssql plan viewer.

### SQL Server Agent
- **Jobs** — expand to Steps and Schedules; right-click for **View History** (filterable),
  **New Job**, **Edit** (full editor: General, Steps, full-recurrence Schedules), and **Delete**.
- **Alerts / Operators / Proxies** — listed in the tree with **New / Edit / Delete**.
  - Operators include the pager duty schedule and per-alert notifications.
  - Proxies are grouped by subsystem, with credential, subsystem grants, and principals.
- **SQL Agent Error Logs** — current + archives, in the same filterable log viewer.

## How it works

- **Reuses your existing connections** via the mssql extension's Connection Sharing API —
  you connect once.
- **System objects only.** Everything is read from `sys.*`, `msdb.*`, and DMVs.
- **Native SQL Server permissions are the only security model.** If your login lacks rights,
  the server says so and we surface it — no separate auth layer.
- **Edits are explicit.** Property dialogs generate the exact T-SQL; **OK** runs it,
  **Script** opens it in a query window so you can review before applying.
- **Environment-aware.** The tree adapts to on-premises SQL Server, Azure SQL Managed
  Instance, and Azure SQL Database based on `SERVERPROPERTY`.

## Requirements

- [SQL Server (mssql)](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql)
  extension **v1.38.0 or later** (Connection Sharing API).
- VS Code **1.90** or later.

## Getting started

1. Install this extension (the SQL Server extension is installed automatically as a dependency).
2. Connect to a server with the SQL Server extension and open a query, **or** right-click a
   server → **Open in SSMS Tools**.
3. Approve the one-time connection-sharing prompt, then open the **SSMS Tools** view.

## License

[MIT](LICENSE)
