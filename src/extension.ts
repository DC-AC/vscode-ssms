import * as vscode from "vscode";
import type { SimpleExecuteResult, ITreeNodeInfo } from "vscode-mssql";
import { MssqlApi } from "./mssql/api";
import { ServerManagementProvider } from "./tree/provider";
import { GridLeafNode, SsmsNode } from "./tree/nodes";
import { generateScript, ScriptOp } from "./scripting/resourceGovernor";
import { openResourceGovernorProperties } from "./webviews/resourceGovernorProperties";
import { showGrid } from "./webviews/grid";
import { openBackupHistory } from "./webviews/backupHistory";
import { openErrorLog } from "./webviews/errorLog";
import { openJobHistory } from "./webviews/jobHistory";
import { openJobProperties } from "./webviews/jobProperties";
import { deleteJobStatement } from "./scripting/agentJob";
import { openEntityForm, FormValues, FieldDef } from "./webviews/entityForm";
import { EntityConfig, PROXY, ALERT } from "./scripting/agentEntities";
import { openOperatorProperties } from "./webviews/operatorProperties";
import { openAzureEventLog } from "./webviews/azureEventLog";
import { openResourceUsage } from "./webviews/resourceUsage";
import { openQueryStoreTopConsumers, openQueryStoreRegressed, openQueryStoreHighVariation } from "./webviews/queryStore";
import { openQueryStoreWaits, openQueryStoreForcedPlans, openQueryStoreTracked, openQueryStoreOverall } from "./webviews/queryStoreExtra";
import { QS_OPTIONS, buildQueryStoreAlter, QueryStoreOptions } from "./queries/queryStore";
import { deleteOperatorStatement } from "./scripting/operator";
import {
  agPrimaryReplica,
  replicaConfig,
  agProperties as agPropertiesQuery,
  agDatabases,
  primaryEndpointUrl,
  LOCAL_SERVER_NAME,
  SERVER_MAJOR_VERSION,
  FEATURE_MIN_MAJOR,
  buildCreateAg,
  buildDropAg,
  buildAddReplica,
  buildReplicaJoin,
  buildRemoveReplica,
  buildDropDatabases,
  buildModifyReplica,
  buildAgLevelAlter,
  SeedingMode,
  AvailabilityMode,
  FailoverMode,
  ClusterType,
  ReplicaSpec,
} from "./queries/alwaysOn";
import {
  openAvailabilityGroupProperties,
  ReplicaRow,
  AgLevel,
} from "./webviews/availabilityGroupProperties";
import { USER_DATABASES } from "./queries/management";

/**
 * Hand a query-runner bound to the connection the tree is currently showing
 * (whether pinned from a server right-click or followed from the active editor)
 * to `work`. This keeps detail panes on the same server as the tree.
 */
async function withTreeConnection(
  provider: ServerManagementProvider,
  work: (run: (sql: string) => Promise<SimpleExecuteResult>) => Promise<void>
): Promise<void> {
  try {
    const uri = await provider.currentConnectionUri();
    if (!uri) {
      vscode.window.showWarningMessage(
        "No SQL Server connection. Open the SSMS Tools view on a connected editor, or right-click a server and choose \"Open in SSMS Tools\"."
      );
      return;
    }
    const api = await MssqlApi.acquire();
    // Wrap every query the page runs in a status-bar progress spinner so the
    // user gets a clear "busy" indicator during slow calls.
    const run = (sql: string): Promise<SimpleExecuteResult> =>
      Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "SSMS Tools: running query…" },
          () => api.execute(uri, sql)
        )
      );
    await work(run);
  } catch (err) {
    vscode.window.showErrorMessage(
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Bracket-quote a database identifier for a USE statement. */
function bracketDb(name: string): string {
  return "[" + name.replace(/]/g, "]]") + "]";
}

/** Read one cell from a result by row + column name; "" when null/missing. */
function cellAt(r: SimpleExecuteResult, row: number, col: string): string {
  const idx = r.columnInfo.findIndex((c) => c.columnName === col);
  const v = idx >= 0 ? r.rows[row]?.[idx] : undefined;
  return v && !v.isNull ? v.displayValue : "";
}

/**
 * Best-effort pre-check that each named replica is the same or a higher SQL
 * Server major version than the primary. For each server, offers to open mssql's
 * connection dialog (the user authenticates to the replica); reads its major
 * version and returns an error message if it's lower. Skipping, cancelling, or
 * an mssql build without `promptForConnection` all fall through to undefined —
 * the in-script JOIN guard still enforces the rule on the secondary.
 */
async function preCheckReplicaVersions(
  servers: string[],
  primaryMajor: number
): Promise<string | undefined> {
  const api = await MssqlApi.acquire();
  for (const server of servers) {
    const choice = await vscode.window.showInformationMessage(
      `Verify the SQL Server version of replica "${server}"? You'll be asked to connect to it.`,
      { modal: true },
      "Connect & Verify",
      "Skip"
    );
    if (choice !== "Connect & Verify") {
      return undefined; // skip this and any remaining checks
    }
    const res = await api.promptForServerMajorVersion();
    if (res === "unsupported") {
      vscode.window.showWarningMessage(
        "This SQL Server (mssql) build can't pre-check replica versions; the JOIN script will verify it on the secondary instead."
      );
      return undefined;
    }
    if (res === "cancelled") {
      return undefined; // user backed out of the connection dialog
    }
    if (res.major && res.major < primaryMajor) {
      return `Replica "${res.server}" is SQL Server major version ${res.major}, lower than the primary (major ${primaryMajor}). An availability replica must be the same or a higher major version. Change or upgrade the replica, then try again.`;
    }
  }
  return undefined;
}

/** Parse the New AG "replicas" textarea: one replica per line, as
 * `server, endpointURL, SYNC|ASYNC, AUTO|MANUAL (failover), AUTO|MANUAL (seeding)`. */
function parseReplicaLines(text: string): ReplicaSpec[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const p = line.split(",").map((s) => s.trim());
      return {
        server: p[0] ?? "",
        endpointUrl: p[1] ?? "",
        availabilityMode: (/^async/i.test(p[2] ?? "")
          ? "ASYNCHRONOUS_COMMIT"
          : "SYNCHRONOUS_COMMIT") as AvailabilityMode,
        failoverMode: (/^auto/i.test(p[3] ?? "") ? "AUTOMATIC" : "MANUAL") as FailoverMode,
        seedingMode: (/^man/i.test(p[4] ?? "") ? "MANUAL" : "AUTOMATIC") as SeedingMode,
      };
    })
    .filter((r) => r.server);
}

/**
 * Hand `work` a query-runner bound to a specific database. Prefers a dedicated
 * connection to that database (saved connections); otherwise runs on the current
 * connection with a `USE [db]` prefix (works on boxed SQL Server / Managed
 * Instance). Used for per-database features like Query Store.
 */
async function withDatabaseConnection(
  provider: ServerManagementProvider,
  database: string,
  work: (run: (sql: string) => Promise<SimpleExecuteResult>) => Promise<void>
): Promise<void> {
  try {
    const api = await MssqlApi.acquire();
    const connectionId = await provider.currentConnectionId();
    let uri: string | undefined;
    let prefix = "";
    if (connectionId) {
      try {
        uri = await api.connect(connectionId, database);
      } catch {
        uri = undefined;
      }
    }
    if (!uri) {
      uri = await provider.currentConnectionUri();
      prefix = `USE ${bracketDb(database)};\n`;
    }
    if (!uri) {
      vscode.window.showWarningMessage("No active SQL connection.");
      return;
    }
    const boundUri = uri;
    const run = (sql: string): Promise<SimpleExecuteResult> =>
      Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "SSMS Tools: running query…" },
          () => api.execute(boundUri, prefix + sql)
        )
      );
    await work(run);
  } catch (err) {
    vscode.window.showErrorMessage(
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Generate CREATE/ALTER T-SQL for a scriptable node and open it in a new
 * untitled SQL editor for the user to review and run. */
async function scriptObjectToEditor(
  provider: ServerManagementProvider,
  node: SsmsNode | undefined,
  op: ScriptOp
): Promise<void> {
  const target = node?.scriptTarget;
  if (!target) {
    vscode.window.showWarningMessage("This node can't be scripted.");
    return;
  }
  await withTreeConnection(provider, async (run) => {
    const ddl = await generateScript(run, target, op);
    const doc = await vscode.workspace.openTextDocument({
      language: "sql",
      content: ddl,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  });
}

/** Clone an entity's fields with any runtime select options merged in. */
async function resolveFields(
  run: (sql: string) => Promise<import("vscode-mssql").SimpleExecuteResult>,
  cfg: EntityConfig
): Promise<EntityConfig["fields"]> {
  if (!cfg.dynamicOptions && !cfg.dynamicChoices) {
    return cfg.fields;
  }
  const opts = cfg.dynamicOptions ? await cfg.dynamicOptions(run) : {};
  const choices = cfg.dynamicChoices ? await cfg.dynamicChoices(run) : {};
  return cfg.fields.map((f) => {
    if (opts[f.key]) {
      return { ...f, options: opts[f.key] };
    }
    if (choices[f.key]) {
      return { ...f, choices: choices[f.key] };
    }
    return f;
  });
}

/** Load one Agent object's current field values into a form-values map. */
async function loadEntityValues(
  run: (sql: string) => Promise<import("vscode-mssql").SimpleExecuteResult>,
  cfg: EntityConfig,
  name: string
): Promise<FormValues> {
  const res = await run(cfg.detail(name));
  const values: FormValues = {};
  for (const f of cfg.fields) {
    if (f.type === "checklist") {
      values[f.key] = [];
      continue;
    }
    const i = res.columnInfo.findIndex((c) => c.columnName === f.key);
    const v = i >= 0 ? res.rows[0]?.[i] : undefined;
    const disp = v && !v.isNull ? v.displayValue : "";
    values[f.key] = f.type === "checkbox" ? disp === "1" : disp;
  }
  return values;
}

/** Combine the main add/update statement with any extra (grant/revoke) batch. */
function combineBatch(main: string, extra: string): string {
  return [main, extra].filter((p) => p.trim()).join("\n\n");
}

/** Human label for an encoded "ptype|name" checklist value (principals). */
function choiceLabel(value: string): string {
  const i = value.indexOf("|");
  if (i < 0) {
    return value;
  }
  const ptype = value.slice(0, i);
  const name = value.slice(i + 1);
  const t = ptype === "srole" ? "Server Role" : ptype === "mrole" ? "MSDB Role" : "SQL Login";
  return `${name}  (${t})`;
}

/** Ensure every currently-set checklist value exists as a choice, so loaded
 * values (e.g. granted principals not in the standard "available" list) still
 * render and show as checked. */
function augmentChoices(
  fields: EntityConfig["fields"],
  values: FormValues
): EntityConfig["fields"] {
  return fields.map((f) => {
    const val = values[f.key];
    if (f.type !== "checklist" || !Array.isArray(val)) {
      return f;
    }
    const have = new Set((f.choices ?? []).map((c) => c.value));
    const missing = val
      .filter((v) => !have.has(v))
      .map((v) => ({ value: v, label: choiceLabel(v) }));
    return missing.length ? { ...f, choices: [...(f.choices ?? []), ...missing] } : f;
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ServerManagementProvider();
  const view = vscode.window.createTreeView("ssms.objectExplorer", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.setView(view);

  // Open the Query Store settings form for a database. Shared by the database
  // "Properties" right-click and the Query Store folder "Properties" command.
  const openQueryStorePropertiesForm = (db: string, title: string): Thenable<void> =>
    withDatabaseConnection(provider, db, async (run) => {
      const res = await run(QS_OPTIONS);
      const get = (col: string): string => {
        const i = res.columnInfo.findIndex((c) => c.columnName === col);
        const v = i >= 0 ? res.rows[0]?.[i] : undefined;
        return v && !v.isNull ? v.displayValue : "";
      };
      const initial: Record<string, string> = {
        operation_mode: get("actual_state_desc") || "READ_WRITE",
        max_storage_size_mb: get("max_storage_size_mb"),
        query_capture_mode: get("query_capture_mode_desc") || "AUTO",
        size_based_cleanup_mode: get("size_based_cleanup_mode_desc") || "AUTO",
        stale_query_threshold_days: get("stale_query_threshold_days"),
        max_plans_per_query: get("max_plans_per_query"),
        wait_stats_capture_mode: get("wait_stats_capture_mode_desc") || "ON",
        flush_interval_seconds: get("flush_interval_seconds"),
        interval_length_minutes: get("interval_length_minutes"),
      };
      openEntityForm(run, {
        title,
        fields: [
          { key: "operation_mode", label: "Operation Mode", type: "select", options: ["READ_WRITE", "READ_ONLY", "OFF"] },
          { key: "max_storage_size_mb", label: "Max Size (MB)", type: "number" },
          { key: "query_capture_mode", label: "Query Capture Mode", type: "select", options: ["AUTO", "ALL", "NONE"] },
          { key: "size_based_cleanup_mode", label: "Size-Based Cleanup", type: "select", options: ["AUTO", "OFF"] },
          { key: "stale_query_threshold_days", label: "Stale Query Threshold (days)", type: "number" },
          { key: "max_plans_per_query", label: "Max Plans Per Query", type: "number" },
          { key: "wait_stats_capture_mode", label: "Wait Stats Capture", type: "select", options: ["ON", "OFF"] },
          { key: "flush_interval_seconds", label: "Data Flush Interval (sec)", type: "number" },
          { key: "interval_length_minutes", label: "Statistics Collection Interval (min)", type: "number" },
        ],
        initial,
        makeBatch: (v) => buildQueryStoreAlter(v as unknown as QueryStoreOptions),
        // Refresh the tree so a database that just turned Query Store on/off
        // gains or loses its Query Store folder.
        onApplied: () => provider.refresh(),
      });
    });

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("ssms.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("ssms.grantAccess", async () => {
      try {
        const api = await MssqlApi.acquire();
        const supported = await api.editSharingPermission();
        if (!supported) {
          vscode.window.showInformationMessage(
            "Connection access is requested automatically when you open this view with a connected SQL editor. Just open/focus a connected query and press Refresh."
          );
        }
        provider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err)
        );
      }
    }),
    vscode.commands.registerCommand("ssms.openGrid", (node: GridLeafNode) =>
      withTreeConnection(provider, async (run) => {
        const result = await run(node.sql);
        const messages = result.messages?.map((m) => m.message).join("\n");
        showGrid(node.title, result, messages);
      })
    ),
    vscode.commands.registerCommand("ssms.openBackupHistory", () =>
      withTreeConnection(provider, async (run) => openBackupHistory(run))
    ),
    vscode.commands.registerCommand("ssms.openQueryStoreTop", (database?: string) =>
      withDatabaseConnection(provider, database ?? "", async (run) =>
        openQueryStoreTopConsumers(run, context.globalState)
      )
    ),
    vscode.commands.registerCommand("ssms.openQueryStoreRegressed", (database?: string) =>
      withDatabaseConnection(provider, database ?? "", async (run) =>
        openQueryStoreRegressed(run, context.globalState)
      )
    ),
    vscode.commands.registerCommand("ssms.openQueryStoreWaits", (database?: string) =>
      withDatabaseConnection(provider, database ?? "", async (run) =>
        openQueryStoreWaits(run, context.globalState)
      )
    ),
    vscode.commands.registerCommand("ssms.openQueryStoreForcedPlans", (database?: string) =>
      withDatabaseConnection(provider, database ?? "", async (run) =>
        openQueryStoreForcedPlans(run, context.globalState)
      )
    ),
    vscode.commands.registerCommand("ssms.openQueryStoreHighVariation", (database?: string) =>
      withDatabaseConnection(provider, database ?? "", async (run) =>
        openQueryStoreHighVariation(run, context.globalState)
      )
    ),
    vscode.commands.registerCommand("ssms.openQueryStoreTracked", (database?: string) =>
      withDatabaseConnection(provider, database ?? "", async (run) =>
        openQueryStoreTracked(run, context.globalState)
      )
    ),
    vscode.commands.registerCommand("ssms.openQueryStoreOverall", (database?: string) =>
      withDatabaseConnection(provider, database ?? "", async (run) =>
        openQueryStoreOverall(run, context.globalState)
      )
    ),
    vscode.commands.registerCommand("ssms.queryStoreProperties", (node?: SsmsNode) => {
      const db = node?.objectName;
      if (!db) {
        return;
      }
      return openQueryStorePropertiesForm(db, `Query Store Properties — ${db}`);
    }),
    vscode.commands.registerCommand("ssms.databaseProperties", (node?: SsmsNode) => {
      const db = node?.objectName;
      if (!db) {
        return;
      }
      return openQueryStorePropertiesForm(db, `Database Properties — ${db}`);
    }),
    vscode.commands.registerCommand(
      "ssms.openErrorLog",
      (logNumber?: number, logType?: 1 | 2) =>
        withTreeConnection(provider, async (run) =>
          openErrorLog(
            run,
            typeof logNumber === "number" ? logNumber : 0,
            logType === 2 ? 2 : 1
          )
        )
    ),
    vscode.commands.registerCommand("ssms.viewJobHistory", (node?: SsmsNode) =>
      withTreeConnection(provider, async (run) => openJobHistory(run, node?.jobId))
    ),
    // Azure SQL DB event log lives in master; open a connection to master.
    vscode.commands.registerCommand("ssms.openAzureEventLog", async () => {
      try {
        const api = await MssqlApi.acquire();
        const connectionId = await provider.currentConnectionId();
        // Prefer a dedicated connection to master (works for saved connections);
        // adhoc/untitled connections have no stored id, so fall back to the
        // current connection and note that it must be master to return data.
        let uri: string | undefined;
        if (connectionId) {
          try {
            uri = await api.connect(connectionId, "master");
          } catch {
            uri = undefined;
          }
        }
        uri ??= await provider.currentConnectionUri();
        if (!uri) {
          vscode.window.showWarningMessage("No active SQL connection.");
          return;
        }
        const boundUri = uri;
        const run = (sql: string): Promise<SimpleExecuteResult> =>
          Promise.resolve(
            vscode.window.withProgress(
              { location: vscode.ProgressLocation.Window, title: "SSMS Tools: running query…" },
              () => api.execute(boundUri, sql)
            )
          );
        openAzureEventLog(run);
      } catch (err) {
        vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err)
        );
      }
    }),
    // Per-database resource usage: connect to the clicked database, then query.
    vscode.commands.registerCommand("ssms.openDbResourceUsage", async (dbName?: string) => {
      if (!dbName) {
        return;
      }
      try {
        const api = await MssqlApi.acquire();
        const connectionId = await provider.currentConnectionId();
        // sys.resource_stats lives in master and covers all databases. Prefer a
        // dedicated master connection (saved connections); otherwise fall back
        // to the current connection, which works if it is already on master.
        let uri: string | undefined;
        if (connectionId) {
          try {
            uri = await api.connect(connectionId, "master");
          } catch {
            uri = undefined;
          }
        }
        uri ??= await provider.currentConnectionUri();
        if (!uri) {
          vscode.window.showWarningMessage("No active SQL connection.");
          return;
        }
        const boundUri = uri;
        const run = (sql: string): Promise<SimpleExecuteResult> =>
          Promise.resolve(
            vscode.window.withProgress(
              { location: vscode.ProgressLocation.Window, title: "SSMS Tools: running query…" },
              () => api.execute(boundUri, sql)
            )
          );
        openResourceUsage(run, dbName);
      } catch (err) {
        vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err)
        );
      }
    }),
    vscode.commands.registerCommand("ssms.editJob", (node?: SsmsNode) => {
      if (!node?.jobId) {
        vscode.window.showWarningMessage("No job selected.");
        return;
      }
      const jobId = node.jobId;
      return withTreeConnection(provider, async (run) =>
        openJobProperties(run, jobId, () => provider.refresh())
      );
    }),
    vscode.commands.registerCommand("ssms.newJob", () =>
      withTreeConnection(provider, async (run) =>
        openJobProperties(run, undefined, () => provider.refresh())
      )
    ),
    vscode.commands.registerCommand("ssms.newOperator", () =>
      withTreeConnection(provider, async (run) =>
        openOperatorProperties(run, undefined, () => provider.refresh())
      )
    ),
    vscode.commands.registerCommand("ssms.editOperator", (node?: SsmsNode) => {
      const name = node?.objectName;
      if (!name) {
        return;
      }
      return withTreeConnection(provider, async (run) =>
        openOperatorProperties(run, name, () => provider.refresh())
      );
    }),
    vscode.commands.registerCommand("ssms.deleteOperator", async (node?: SsmsNode) => {
      const name = node?.objectName;
      if (!name) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete operator "${name}"? This cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (choice !== "Delete") {
        return;
      }
      await withTreeConnection(provider, async (run) => {
        await run(deleteOperatorStatement(name));
        vscode.window.showInformationMessage(`Operator "${name}" deleted.`);
        provider.refresh();
      });
    }),
    vscode.commands.registerCommand("ssms.deleteJob", async (node?: SsmsNode) => {
      if (!node?.jobId) {
        vscode.window.showWarningMessage("No job selected.");
        return;
      }
      const name = typeof node.label === "string" ? node.label : "this job";
      const choice = await vscode.window.showWarningMessage(
        `Delete job "${name}"? This cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (choice !== "Delete") {
        return;
      }
      const jobId = node.jobId;
      await withTreeConnection(provider, async (run) => {
        await run(deleteJobStatement(jobId));
        vscode.window.showInformationMessage(`Job "${name}" deleted.`);
        provider.refresh();
      });
    }),
    // Primary-only guard: AG config changes (seeding, options, add/remove
    // replica) must run on the primary. Returns false if the user cancels.
    vscode.commands.registerCommand("ssms.newAg", () =>
      withTreeConnection(provider, async (run) => {
        const srvRes = await run(LOCAL_SERVER_NAME);
        const local = cellAt(srvRes, 0, "local_server") || "SERVER1";
        const major = parseInt(cellAt(await run(SERVER_MAJOR_VERSION), 0, "major"), 10) || 0;
        const dbRes = await run(USER_DATABASES);
        const choices = dbRes.rows.map((_, i) => {
          const name = cellAt(dbRes, i, "name");
          return { value: name, label: name };
        });
        // CLUSTER_TYPE NONE/EXTERNAL are SQL 2017+; older servers get WSFC only.
        const clusterOptions =
          major >= FEATURE_MIN_MAJOR.clusterless ? ["WSFC", "NONE", "EXTERNAL"] : ["WSFC"];
        const fields: FieldDef[] = [
          { key: "name", label: "Availability Group Name", type: "text" },
          { key: "cluster_type", label: "Cluster Type", type: "select", options: clusterOptions },
          { key: "backup_pref", label: "Automated Backup Preference", type: "select", options: ["SECONDARY", "SECONDARY_ONLY", "PRIMARY", "NONE"] },
          { key: "db_failover", label: "Database Level Health Detection", type: "checkbox" },
        ];
        // DTC_SUPPORT = PER_DB is SQL 2016+ and set only at create time.
        if (major >= FEATURE_MIN_MAJOR.dtc) {
          fields.push({ key: "dtc", label: "Per-Database DTC Support (DTC_SUPPORT = PER_DB)", type: "checkbox" });
        }
        fields.push(
          { key: "databases", label: "Databases", type: "checklist", choices },
          { key: "replicas", label: "Replicas — one per line: server, endpointURL, SYNC|ASYNC, AUTO|MANUAL (failover), AUTO|MANUAL (seeding). First line is the primary.", type: "textarea" },
          { key: "verify", label: "Verify secondary SQL versions before applying", type: "checkbox" }
        );
        openEntityForm(run, {
          title: "New Availability Group",
          fields,
          initial: {
            name: "",
            cluster_type: "WSFC",
            backup_pref: "SECONDARY",
            db_failover: true,
            dtc: false,
            databases: [],
            replicas: `${local}, TCP://${local}:5022, SYNC, AUTO, AUTO`,
            verify: true,
          },
          preApply: async (v) => {
            if (!v.verify) {
              return undefined;
            }
            const secondaries = parseReplicaLines(String(v.replicas))
              .slice(1)
              .map((r) => r.server)
              .filter(Boolean);
            return secondaries.length ? preCheckReplicaVersions(secondaries, major) : undefined;
          },
          makeBatch: (v) => {
            const replicas = parseReplicaLines(String(v.replicas));
            if (!String(v.name).trim()) {
              return "-- Enter an availability group name.";
            }
            if (replicas.length === 0) {
              return "-- Add at least one replica line (the first is the primary).";
            }
            return buildCreateAg({
              name: String(v.name).trim(),
              clusterType: v.cluster_type as ClusterType,
              databases: Array.isArray(v.databases) ? v.databases : [],
              automatedBackupPreference: String(v.backup_pref),
              dbFailover: !!v.db_failover,
              dtcSupport: major >= FEATURE_MIN_MAJOR.dtc && !!v.dtc,
              replicas,
              primaryMajor: major,
            });
          },
          onApplied: () => {
            provider.refresh();
            vscode.window.showInformationMessage(
              "Availability group created on this (primary) instance. Run the secondary JOIN commands (see Script) on each secondary replica."
            );
          },
        });
      })
    ),
    vscode.commands.registerCommand("ssms.agProperties", (node?: SsmsNode) => {
      const ag = node?.agName;
      if (!ag) {
        return;
      }
      return withTreeConnection(provider, async (run) => {
        const roleRes = await run(agPrimaryReplica(ag));
        const primary = cellAt(roleRes, 0, "primary_replica");
        const local = cellAt(roleRes, 0, "local_server");
        if (primary && local && primary.toLowerCase() !== local.toLowerCase()) {
          const choice = await vscode.window.showWarningMessage(
            `Availability-group settings can only be changed on the primary replica of "${ag}", which is "${primary}". This connection is "${local}", so applying here will fail — use Script and run it on the primary, or reconnect to the primary.`,
            { modal: true },
            "Open Anyway"
          );
          if (choice !== "Open Anyway") {
            return;
          }
        }
        const rc = await run(replicaConfig(ag));
        const replicas: ReplicaRow[] = rc.rows.map((_, i) => ({
          server: cellAt(rc, i, "server"),
          role: cellAt(rc, i, "role"),
          availabilityMode: cellAt(rc, i, "availability_mode"),
          failoverMode: cellAt(rc, i, "failover_mode"),
          primaryConnections: cellAt(rc, i, "primary_connections"),
          readableSecondary: cellAt(rc, i, "readable_secondary"),
          seedingMode: cellAt(rc, i, "seeding_mode"),
          sessionTimeout: cellAt(rc, i, "session_timeout"),
        }));
        const optRes = await run(agPropertiesQuery(ag));
        const agBefore: AgLevel = {
          backupPref: (cellAt(optRes, 0, "backup_pref") || "SECONDARY").toUpperCase(),
          requiredSecondaries: cellAt(optRes, 0, "required_secondaries") || "0",
          healthCheckTimeout: cellAt(optRes, 0, "health_check_timeout") || "30000",
          dbFailover: cellAt(optRes, 0, "db_failover") === "1",
        };
        const major = parseInt(cellAt(await run(SERVER_MAJOR_VERSION), 0, "major"), 10) || 0;
        // Keep a copy of the originals to diff against on apply.
        const repBefore = replicas.map((r) => ({ ...r }));
        openAvailabilityGroupProperties(run, {
          agName: ag,
          replicas,
          ag: agBefore,
          majorVersion: major,
          makeBatch: (repAfter, agAfter) => {
            const parts: string[] = [];
            for (const after of repAfter) {
              const before = repBefore.find((b) => b.server === after.server);
              if (before) {
                parts.push(buildModifyReplica(ag, before, after));
              }
            }
            parts.push(buildAgLevelAlter(ag, agBefore, agAfter));
            return parts.filter(Boolean).join("\n") || "-- No changes.";
          },
          onApplied: () => provider.refresh(),
        });
      });
    }),
    vscode.commands.registerCommand("ssms.deleteAg", async (node?: SsmsNode) => {
      const ag = node?.agName;
      if (!ag) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete availability group "${ag}"? This removes the AG from the server. Databases are not dropped. This cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (choice !== "Delete") {
        return;
      }
      await withTreeConnection(provider, async (run) => {
        await run(buildDropAg(ag));
        vscode.window.showInformationMessage(`Availability group "${ag}" deleted.`);
        provider.refresh();
      });
    }),
    vscode.commands.registerCommand("ssms.addReplica", (node?: SsmsNode) => {
      const ag = node?.agName;
      if (!ag) {
        return;
      }
      return withTreeConnection(provider, async (run) => {
        const major = parseInt(cellAt(await run(SERVER_MAJOR_VERSION), 0, "major"), 10) || 0;
        const clusterOptions =
          major >= FEATURE_MIN_MAJOR.clusterless ? ["WSFC", "NONE", "EXTERNAL"] : ["WSFC"];
        const seedingOptions =
          major >= FEATURE_MIN_MAJOR.seeding ? ["AUTOMATIC", "MANUAL"] : ["MANUAL"];
        // Derive the primary's domain so a bare secondary name becomes an FQDN
        // endpoint (short names usually don't resolve between AG nodes).
        const epUrl = cellAt(await run(primaryEndpointUrl(ag)), 0, "endpoint_url");
        const hostMatch = epUrl.match(/:\/\/([^:/]+)/);
        const primaryHost = hostMatch ? hostMatch[1] : "";
        const dotIdx = primaryHost.indexOf(".");
        const domain = dotIdx >= 0 ? primaryHost.substring(dotIdx + 1) : "";
        // Captured on apply so onApplied can offer to join the new secondary.
        let pending: { spec: ReplicaSpec; clusterType: ClusterType } | undefined;
        openEntityForm(run, {
          title: `Add Replica — ${ag}`,
          fields: [
            { key: "server", label: "Server Name (secondary)", type: "text" },
            { key: "endpoint", label: "Endpoint URL (e.g. TCP://host:5022)", type: "text", autoFrom: "server", autoTemplate: "TCP://{v}:5022", autoSuffix: domain },
            { key: "availability", label: "Availability Mode", type: "select", options: ["SYNCHRONOUS_COMMIT", "ASYNCHRONOUS_COMMIT"] },
            { key: "failover", label: "Failover Mode", type: "select", options: ["MANUAL", "AUTOMATIC"] },
            { key: "seeding", label: "Seeding Mode", type: "select", options: seedingOptions },
            { key: "cluster_type", label: "Cluster Type", type: "select", options: clusterOptions },
            { key: "verify", label: "Verify replica SQL version before applying", type: "checkbox" },
          ],
          initial: {
            server: "",
            endpoint: "TCP://:5022",
            availability: "SYNCHRONOUS_COMMIT",
            failover: "MANUAL",
            seeding: major >= FEATURE_MIN_MAJOR.seeding ? "AUTOMATIC" : "MANUAL",
            cluster_type: "WSFC",
            verify: true,
          },
          preApply: async (v) => {
            if (!v.verify) {
              return undefined;
            }
            const server = String(v.server).trim();
            return server ? preCheckReplicaVersions([server], major) : undefined;
          },
          makeBatch: (v) => {
            const server = String(v.server).trim();
            if (!server) {
              return "-- Enter the secondary server name.";
            }
            const clusterType = v.cluster_type as ClusterType;
            const r: ReplicaSpec = {
              server,
              endpointUrl: String(v.endpoint).trim(),
              availabilityMode: v.availability as AvailabilityMode,
              failoverMode: v.failover as FailoverMode,
              seedingMode: v.seeding as SeedingMode,
            };
            pending = { spec: r, clusterType };
            return buildAddReplica(ag, clusterType, r, major);
          },
          onApplied: async () => {
            provider.refresh();
            if (!pending) {
              return;
            }
            const { spec, clusterType } = pending;
            // The ADD REPLICA ran on the primary; the secondary must now create
            // its endpoint and JOIN — which can only run on the secondary.
            const joinSql =
              `-- Run this on "${spec.server}" to finish joining it to [${ag}].\n` +
              `-- Connect this editor to "${spec.server}", then execute.\n` +
              buildReplicaJoin(ag, clusterType, spec, major) +
              "\n";
            const openScript = async (): Promise<void> => {
              const doc = await vscode.workspace.openTextDocument({
                language: "sql",
                content: joinSql,
              });
              await vscode.window.showTextDocument(doc, { preview: false });
            };
            const choice = await vscode.window.showInformationMessage(
              `Replica "${spec.server}" was added on the primary, but it still needs to JOIN the AG from "${spec.server}" itself. Join it now?`,
              { modal: true },
              "Open JOIN Script",
              "Connect & Join"
            );
            if (choice !== "Connect & Join") {
              // Default (incl. dismiss) → give them the ready-to-run script.
              await openScript();
              vscode.window.showInformationMessage(
                `JOIN script opened. Connect it to "${spec.server}" and run it to finish joining.`
              );
              return;
            }
            try {
              const api = await MssqlApi.acquire();
              const conn = await api.promptForConnectionUri();
              if (conn === "unsupported" || conn === "cancelled") {
                await openScript();
                vscode.window.showInformationMessage(
                  `JOIN script opened. Connect it to "${spec.server}" and run it to finish joining.`
                );
                return;
              }
              await api.execute(conn.uri, buildReplicaJoin(ag, clusterType, spec, major));
              vscode.window.showInformationMessage(
                `Replica "${spec.server}" joined "${ag}".`
              );
              provider.refresh();
            } catch (err) {
              await openScript();
              vscode.window.showErrorMessage(
                `Couldn't join "${spec.server}" automatically (${err instanceof Error ? err.message : String(err)}). The JOIN script is open — connect it to "${spec.server}" and run it.`
              );
            }
          },
        });
      });
    }),
    vscode.commands.registerCommand("ssms.removeReplica", (node?: SsmsNode) => {
      const ag = node?.agName;
      const replica = node?.objectName;
      if (!ag || !replica) {
        return;
      }
      return withTreeConnection(provider, async (run) => {
        const roleRes = await run(agPrimaryReplica(ag));
        const primary = cellAt(roleRes, 0, "primary_replica");
        const local = cellAt(roleRes, 0, "local_server");
        if (primary && local && primary.toLowerCase() !== local.toLowerCase()) {
          const choice = await vscode.window.showWarningMessage(
            `Replicas can only be removed on the primary replica of "${ag}", which is "${primary}". This connection is "${local}". Reconnect to the primary, then try again.`,
            { modal: true },
            "Open Anyway"
          );
          if (choice !== "Open Anyway") {
            return;
          }
        }
        // Capture the AG's databases before removal so we can offer to drop them.
        const dbRes = await run(agDatabases(ag));
        const dbNames = dbRes.rows
          .map((_, i) => cellAt(dbRes, i, "database_name"))
          .filter(Boolean);
        const confirm = await vscode.window.showWarningMessage(
          `Remove replica "${replica}" from availability group "${ag}"? This cannot be undone.`,
          { modal: true },
          "Remove"
        );
        if (confirm !== "Remove") {
          return;
        }
        await run(buildRemoveReplica(ag, replica));
        vscode.window.showInformationMessage(`Replica "${replica}" removed from "${ag}".`);
        provider.refresh();
        if (dbNames.length > 0) {
          const drop = await vscode.window.showWarningMessage(
            `Also remove the ${dbNames.length} database(s) that were in "${ag}" from the removed server "${replica}"?`,
            {
              modal: true,
              detail: `This opens a DROP DATABASE script to run on ${replica}:\n${dbNames.join(", ")}`,
            },
            "Create Drop Script"
          );
          if (drop === "Create Drop Script") {
            const doc = await vscode.workspace.openTextDocument({
              language: "sql",
              content: buildDropDatabases(ag, replica, dbNames),
            });
            await vscode.window.showTextDocument(doc, { preview: false });
          }
        }
      });
    }),
    vscode.commands.registerCommand("ssms.resourceGovernorProperties", () =>
      withTreeConnection(provider, async (run) =>
        openResourceGovernorProperties(run, () => provider.refresh())
      )
    ),
    vscode.commands.registerCommand("ssms.scriptCreate", (node: SsmsNode) =>
      scriptObjectToEditor(provider, node, "create")
    ),
    vscode.commands.registerCommand("ssms.scriptAlter", (node: SsmsNode) =>
      scriptObjectToEditor(provider, node, "alter")
    ),
    // Invoked from the mssql Object Explorer server right-click menu. The arg
    // is an mssql ITreeNodeInfo carrying the server's connectionProfile.
    vscode.commands.registerCommand(
      "ssms.openFromServer",
      async (node?: ITreeNodeInfo) => {
        try {
          const info = node?.connectionProfile;
          if (!info) {
            vscode.window.showWarningMessage(
              "Could not read the connection from this server node."
            );
            return;
          }
          const api = await MssqlApi.acquire();
          const { uri, connectionId } = await api.connectWithInfo(info);
          await provider.pinConnection(uri, connectionId);
          await vscode.commands.executeCommand("ssms.objectExplorer.focus");
        } catch (err) {
          vscode.window.showErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    ),
    // Follow the active editor, but only when focus lands on an actual text
    // editor. Focus moving to our webview grid (or anything that isn't an
    // editor) reports `undefined` here — we ignore it so the tree stays put.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void provider.onActiveEditorChanged();
      }
    })
  );

  // New/Edit/Delete commands for the simple Agent objects (Operator/Proxy/Alert).
  const entities: Array<[string, EntityConfig]> = [
    ["Proxy", PROXY],
    ["Alert", ALERT],
  ];
  for (const [suffix, cfg] of entities) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`ssms.new${suffix}`, () =>
        withTreeConnection(provider, async (run) =>
          openEntityForm(run, {
            title: `New ${cfg.title}`,
            fields: await resolveFields(run, cfg),
            initial: cfg.defaults,
            makeBatch: (v) =>
              combineBatch(cfg.add(v), cfg.extra ? cfg.extra(cfg.defaults, v, true) : ""),
            onApplied: () => provider.refresh(),
          })
        )
      ),
      vscode.commands.registerCommand(`ssms.edit${suffix}`, (node?: SsmsNode) => {
        const name = node?.objectName;
        if (!name) {
          return;
        }
        return withTreeConnection(provider, async (run) => {
          const resolved = await resolveFields(run, cfg);
          const scalar = await loadEntityValues(run, cfg, name);
          const extraVals = cfg.loadExtra ? await cfg.loadExtra(run, name) : {};
          const initial = { ...scalar, ...extraVals } as FormValues;
          const fields = augmentChoices(resolved, initial);
          openEntityForm(run, {
            title: `${cfg.title} Properties`,
            fields,
            initial,
            makeBatch: (v) =>
              combineBatch(cfg.update(name, v), cfg.extra ? cfg.extra(initial, v, false) : ""),
            onApplied: () => provider.refresh(),
          });
        });
      }),
      vscode.commands.registerCommand(`ssms.delete${suffix}`, async (node?: SsmsNode) => {
        const name = node?.objectName;
        if (!name) {
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Delete ${cfg.title.toLowerCase()} "${name}"? This cannot be undone.`,
          { modal: true },
          "Delete"
        );
        if (choice !== "Delete") {
          return;
        }
        await withTreeConnection(provider, async (run) => {
          await run(cfg.del(name));
          vscode.window.showInformationMessage(`${cfg.title} "${name}" deleted.`);
          provider.refresh();
        });
      })
    );
  }
}

export function deactivate(): void {
  // nothing to clean up; shared connections are owned by the mssql extension.
}
