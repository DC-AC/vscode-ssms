# vscode-ssms — Design

A VS Code extension that fills the gap between the official **ms-mssql** extension
and **SQL Server Management Studio (SSMS)**. It surfaces SSMS's server-management
capabilities — the parts mssql doesn't have — as a companion sidebar tree plus
detail webviews.

## Guiding principles

1. **Don't duplicate the mssql extension.** It already provides connections,
   query editing/execution, IntelliSense, and an Object Explorer covering
   **Databases → Tables / Views / Programmability / Security**, plus server-level
   **Security** and basic **Server Objects**. We do not rebuild any of that.
2. **Fill the SSMS gap only.** Our tree begins where mssql goes dark: the
   server-management folders (Management, SQL Server Agent, Replication, Always On,
   etc.).
3. **System objects only.** Every feature is powered by reads against `sys.*`,
   `msdb.*`, `INFORMATION_SCHEMA`, and DMVs. No proprietary metadata store.
4. **Native SQL Server permissions are the security model.** We add no auth layer.
   If a login lacks rights, the server returns an error or empty set and we surface
   that as-is (e.g. a login outside `SQLAgentReaderRole` sees an empty Agent node).
5. **Read-first.** Milestones ship read/monitor functionality. Actions (run job,
   restore, etc.) come later and rely entirely on server-side permission checks.

## UI model decision: two separate trees (decided)

VS Code provides **no API to inject nodes into another extension's tree**, so we
cannot extend Microsoft's Object Explorer. We register our **own** view in our
own **SSMS Tools** activity-bar container. The result is two trees side by side —
Microsoft's (Databases / Security / Server Objects) and ours (Management / Agent
/ …) — both following the same active-editor connection, no re-auth.

**Decision (current):** ship the two-tree model. It matches the "don't duplicate
mssql" scope and is fully supported by the API.

**Deferred option:** if a single unified SSMS-style tree later proves important,
the only path is to build our *own* full Object Explorer (re-implementing the
Databases/Tables/Security branches) and have users use ours instead of
Microsoft's. Larger scope; revisit only if the two-tree UX proves insufficient.

## Architecture

### Connection reuse + query execution (verified against the real API)
The official typings live at `microsoft/vscode-mssql` →
`extensions/mssql/typings/vscode-mssql.d.ts`. **Note:** the `vscode-mssql`
package on npm is a squatted *security placeholder* (`0.0.1-security`), **not**
the types — we **vendor** that `.d.ts` into our repo (e.g. `src/typings/`).

- Depend on the mssql extension via `extensionDependencies: ["ms-mssql.mssql"]`
  and pin a recent minimum version (Connection Sharing is a recent addition).
- Acquire the API: `vscode.extensions.getExtension('ms-mssql.mssql').exports`
  as `IExtension`.

The top-level `IExtension` has **no direct query method** — only `connect`,
`getConnectionString`, `listDatabases`, and a raw `sendRequest` escape hatch.
**However**, `IExtension.connectionSharing` (`IConnectionSharingService`) is
purpose-built for companion extensions and gives us exactly what we need:

- `executeSimpleQuery(connectionUri, queryString): Promise<SimpleExecuteResult>`
  — runs our catalog T-SQL and returns results. **This is our primary execution
  path; no own connection pool needed.**
- `getActiveEditorConnectionId(extensionId)` / `connect(extensionId, connectionId,
  database?)` — reuse the user's *existing* mssql connection by id and get a
  `connectionUri`. Users connect once.
- `scriptObject(connectionUri, ScriptOperation, IScriptingObject)` — SSMS-style
  scripting (Create/Alter/Drop/Select/…) via STS, **for free**, if we want it later.
- Consent gate: first use prompts the user; `editConnectionSharingPermissions`
  returns `ConnectionSharingApproval = "approved" | "denied"`. We handle "denied"
  with a clear call-to-action node.
- `getConnectionString(...)` remains as a fallback to open our own pooled
  connection, but is **not required** for the planned milestones.

**Result shape caveat that affects query design:** `SimpleExecuteResult` =
`{ rowCount, columnInfo: IDbColumn[], rows: DbCellValue[][], messages? }`, and
`DbCellValue` is only `{ displayValue: string, isNull: boolean }`. **Every value
comes back as a display string.** So we `CAST`/`CONVERT`/`FORMAT` in the SQL
itself to control rendering (dates ISO-8601, sizes in bytes, etc.) rather than
re-parsing strings in TypeScript.

### Graceful degradation
If `exports.connectionSharing` is undefined (older mssql build), show a
single banner node telling the user to update the SQL Server extension, rather
than failing silently.

### Edition / environment gating
A single probe at connect time decides which folders and leaves appear:

```sql
SELECT
    SERVERPROPERTY('EngineEdition')   AS EngineEdition,
    SERVERPROPERTY('IsHadrEnabled')   AS IsHadrEnabled,
    SERVERPROPERTY('ProductVersion')  AS ProductVersion,
    SERVERPROPERTY('Edition')         AS Edition;
```

`EngineEdition` mapping that drives the tree:

| Value | Environment                | Agent | Server-level Mgmt | Replication | Notes |
|-------|----------------------------|-------|-------------------|-------------|-------|
| 5     | Azure SQL Database         | no    | no                | no          | DB-scoped only; surface DB-scoped equivalents only |
| 8     | Azure SQL Managed Instance | yes   | most              | yes         | hide box-only items |
| other | Boxed SQL Server (2/3/4…)  | yes   | yes               | yes         | full tree |

`IsHadrEnabled = 1` gates the **Always On High Availability** node.

Each tree node is registered with an availability predicate
`(ctx: ServerContext) => boolean`, so the tree builds itself per connected server.

### UI surfaces
- **Sidebar:** a dedicated "SSMS" view container with a `TreeDataProvider`.
  Children are **lazy** — we don't query `msdb` until a node is expanded.
- **Detail panes:** Webviews for grid/dashboard content (backup history, log
  viewer, job history) — the SSMS dialogs we must recreate because mssql has no
  equivalent.

### Project layout (proposed, set at scaffold time)
```
src/
  extension.ts            activate(): register view, commands, mssql API handshake
  mssql/api.ts            wrapper over the ms-mssql exported API
  server/context.ts       EngineEdition probe + ServerContext
  tree/provider.ts        TreeDataProvider; lazy children
  tree/nodes/             node definitions w/ availability predicates
  queries/                versioned SQL catalog (one file per feature)
  webviews/               detail panes (React or plain HTML/CSS)
```

## Tree scope (the "missing SSMS" folders)

Top-level under a connected server, minus the mssql-covered folders you excluded
(Databases, Security, Server Objects):

- **Management**  ← *Milestone 1*
- **SQL Server Agent**
- **Replication**
- **Always On High Availability** (gated by `IsHadrEnabled`)
- **PolyBase**, **Integration Services Catalogs** (later, edition-gated)

## Milestone 1 — Management (read-only)

Goal: prove the full architecture (mssql API handshake → edition gating → lazy
tree → webview detail) on a self-contained, high-value folder.

Nodes under **Management**:

1. **Backup / Restore history**
   - Source: `msdb.dbo.backupset`, `backupmediafamily`, `restorehistory`.
   - Tree: per-database recent backups; leaf opens a webview with full history
     (type, start/finish, size, LSNs, device path, user).
2. **SQL Server Logs**
   - Source: `sys.sp_readerrorlog` / `xp_readerrorlog` (current + archived logs
     enumerated via `sys.sp_enumerrorlogs`).
   - Webview: filterable log viewer (date, severity, text search).
3. **Database Mail**
   - Source: `msdb.dbo.sysmail_*` (accounts, profiles, `sysmail_allitems`,
     `sysmail_event_log`).
   - Webview: sent-mail history + configuration summary.
4. **Distributed Transaction Coordinator** (status only) and
   **Data Collection** (presence/state) — thin leaves to round out the folder.

Edition behavior for Milestone 1:
- Azure SQL DB (5): Management folder hidden or reduced to DB-scoped items only
  (most of the above don't exist there).
- Managed Instance (8): show backup history (note: native backups are managed),
  logs, Database Mail; hide DTC.
- Boxed: full Management folder.

Permissions surfaced as-is: e.g. reading `msdb` backup tables needs membership in
`db_backupoperator`/appropriate roles or `VIEW SERVER STATE`; `xp_readerrorlog`
needs `securityadmin` or membership in the right role. Denials become a clear
toast + an explanatory placeholder node.

## Later milestones (sketch)

- **M2 — SQL Server Agent:** Jobs tree, Job Activity Monitor, schedules,
  operators, alerts, job/step history (`msdb.dbo.sysjobs`, `sysjobhistory`,
  `sysjobactivity`, `sysjobschedules`, `sysoperators`, `sysalerts`).
- **M3 — Replication monitoring** and **Always On dashboard**
  (`sys.dm_hadr_*`, `sys.availability_*`).
- **M4 — Actions:** start/stop job, run backup, etc., still gated by native perms.

## Open questions / decisions deferred to scaffold time

- Webview stack: plain HTML/CSS + VS Code toolkit vs. a bundled React app.
- Caching strategy for tree refresh (manual refresh vs. TTL).
- Minimum `ms-mssql.mssql` version to require for `connectionSharing` (pin once
  we confirm the version that introduced it).

*(Resolved: query execution uses `connectionSharing.executeSimpleQuery`; an own
pooled connection is a fallback only, seeded from `getConnectionString`.)*
