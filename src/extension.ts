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
import { openEntityForm, FormValues } from "./webviews/entityForm";
import { EntityConfig, PROXY, ALERT } from "./scripting/agentEntities";
import { openOperatorProperties } from "./webviews/operatorProperties";
import { openAzureEventLog } from "./webviews/azureEventLog";
import { openResourceUsage } from "./webviews/resourceUsage";
import { openQueryStoreTopConsumers, openQueryStoreRegressed, openQueryStoreHighVariation } from "./webviews/queryStore";
import { openQueryStoreWaits, openQueryStoreForcedPlans, openQueryStoreTracked, openQueryStoreOverall } from "./webviews/queryStoreExtra";
import { QS_OPTIONS, buildQueryStoreAlter, QueryStoreOptions } from "./queries/queryStore";
import { deleteOperatorStatement } from "./scripting/operator";

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
          const uri = await api.connectWithInfo(info);
          await provider.pinConnection(uri);
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
