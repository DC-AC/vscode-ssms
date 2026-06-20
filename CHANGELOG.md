# Changelog

All notable changes to **SSMS Tools for SQL Server** are documented here.

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
