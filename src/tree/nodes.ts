import * as vscode from "vscode";
import { MssqlApi } from "../mssql/api";
import { ServerContext, isAzureSqlDb, isBoxedProduct } from "../server/context";
import * as Q from "../queries/management";
import * as RG from "../queries/resourceGovernor";
import * as Agent from "../queries/agent";
import type { ScriptTarget } from "../scripting/resourceGovernor";

/**
 * Base tree node. Subclasses provide children. `isAvailable` gates the node
 * by server edition so the tree builds itself per connected server.
 */
export abstract class SsmsNode extends vscode.TreeItem {
  /** When set, this node can be scripted (CREATE/ALTER) from the context menu. */
  scriptTarget?: ScriptTarget;
  /** Agent job_id, set on job nodes so context-menu commands can act on it. */
  jobId?: string;
  /** Object name, set on Alert/Operator/Proxy item nodes for context commands. */
  objectName?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }

  /** Whether this node should appear for the given server. Default: yes. */
  isAvailable(_ctx: ServerContext): boolean {
    return true;
  }

  abstract getChildren(ctx: ServerContext, api: MssqlApi): Promise<SsmsNode[]>;
}

/** A grid leaf: clicking it opens a webview that runs `sql` and renders rows. */
export class GridLeafNode extends SsmsNode {
  constructor(
    label: string,
    iconId: string,
    public readonly title: string,
    public readonly sql: string,
    available?: (ctx: ServerContext) => boolean
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.available = available;
    this.command = {
      command: "ssms.openGrid",
      title: "Open",
      arguments: [this],
    };
  }

  private available?: (ctx: ServerContext) => boolean;

  override isAvailable(ctx: ServerContext): boolean {
    return this.available ? this.available(ctx) : true;
  }

  async getChildren(): Promise<SsmsNode[]> {
    return [];
  }
}

/** A leaf that invokes an arbitrary command (e.g. opens a custom webview). */
export class CommandLeafNode extends SsmsNode {
  constructor(
    label: string,
    iconId: string,
    command: string,
    private readonly available?: (ctx: ServerContext) => boolean,
    args: unknown[] = []
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.command = { command, title: "Open", arguments: args };
  }

  override isAvailable(ctx: ServerContext): boolean {
    return this.available ? this.available(ctx) : true;
  }

  async getChildren(): Promise<SsmsNode[]> {
    return [];
  }
}

/** A non-expandable item node carrying an object name + context value, for
 * Alert/Operator/Proxy entries that support Edit/Delete via right-click. */
export class ItemNode extends SsmsNode {
  constructor(label: string, iconId: string, contextValue: string, objectName: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = contextValue;
    this.objectName = objectName;
  }

  async getChildren(): Promise<SsmsNode[]> {
    return [];
  }
}

/** A folder with a fixed set of child nodes. */
export class FolderNode extends SsmsNode {
  constructor(
    label: string,
    iconId: string,
    private readonly childFactory: () => SsmsNode[],
    private readonly available?: (ctx: ServerContext) => boolean
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = "ssmsFolder";
  }

  override isAvailable(ctx: ServerContext): boolean {
    return this.available ? this.available(ctx) : true;
  }

  async getChildren(ctx: ServerContext): Promise<SsmsNode[]> {
    return this.childFactory().filter((c) => c.isAvailable(ctx));
  }
}

/**
 * A folder whose children are produced lazily by a loader (e.g. a catalog
 * query). Used to compose dynamic, nested trees without a class per level.
 */
export class AsyncFolderNode extends SsmsNode {
  constructor(
    label: string,
    iconId: string,
    private readonly loader: (ctx: ServerContext, api: MssqlApi) => Promise<SsmsNode[]>,
    private readonly available?: (ctx: ServerContext) => boolean
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = "ssmsFolder";
  }

  override isAvailable(ctx: ServerContext): boolean {
    return this.available ? this.available(ctx) : true;
  }

  async getChildren(ctx: ServerContext, api: MssqlApi): Promise<SsmsNode[]> {
    return this.loader(ctx, api);
  }
}

/** Read a column from a result row by column name; "" when null/missing. */
function cell(
  result: import("vscode-mssql").SimpleExecuteResult,
  row: number,
  column: string
): string {
  const idx = result.columnInfo.findIndex((c) => c.columnName === column);
  const value = idx >= 0 ? result.rows[row]?.[idx] : undefined;
  return value && !value.isNull ? value.displayValue : "";
}

/** A logs folder whose children are the individual log files (current +
 * archives). logType 1 = SQL Server error log, 2 = SQL Server Agent log. */
export class ErrorLogsNode extends SsmsNode {
  constructor(
    label: string,
    private readonly logType: 1 | 2,
    private readonly available?: (ctx: ServerContext) => boolean
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("output");
  }

  override isAvailable(ctx: ServerContext): boolean {
    return this.available ? this.available(ctx) : true;
  }

  async getChildren(ctx: ServerContext, api: MssqlApi): Promise<SsmsNode[]> {
    const result = await api.execute(ctx.connectionUri, Q.enumErrorLogs(this.logType));
    const archiveIdx = result.columnInfo.findIndex(
      (c) => /Archive/i.test(c.columnName)
    );
    return result.rows
      .map((row, i) => (archiveIdx >= 0 ? Number(row[archiveIdx]?.displayValue) : i))
      .sort((a, b) => a - b) // Current (0) first, then archives ascending.
      .map((logNumber) => {
        const label = logNumber === 0 ? "Current" : `Archive #${logNumber}`;
        return new CommandLeafNode(label, "file", "ssms.openErrorLog", undefined, [
          logNumber,
          this.logType,
        ]);
      });
  }
}

interface Pool {
  id: number;
  name: string;
}

/** Resource Governor subtree: Resource Pools + External Resource Pools, each
 * splitting user-defined pools from a System ... subfolder (as in SSMS). */
function buildResourceGovernorNode(): SsmsNode {
  const workloadGroupsFolder = (pool: Pool): SsmsNode =>
    new AsyncFolderNode("Workload Groups", "group-by-ref-type", async (ctx, api) => {
      const res = await api.execute(ctx.connectionUri, RG.workloadGroupsForPool(pool.id));
      return res.rows.map((_, i) => {
        const name = cell(res, i, "name");
        const leaf = new GridLeafNode(
          name,
          "settings-gear",
          `Workload Group — ${name}`,
          RG.workloadGroupDetails(name)
        );
        // Only user-defined groups are scriptable; system ones aren't.
        if (!RG.isSystemPoolName(name)) {
          leaf.contextValue = "ssmsWorkloadGroup";
          leaf.scriptTarget = { kind: "workloadGroup", name };
        }
        return leaf;
      });
    });

  const poolNode = (pool: Pool): SsmsNode => {
    const node = new AsyncFolderNode(pool.name, "database", async () => [
      workloadGroupsFolder(pool),
    ]);
    if (!RG.isSystemPoolName(pool.name)) {
      node.contextValue = "ssmsResourcePool";
      node.scriptTarget = { kind: "resourcePool", name: pool.name };
    }
    return node;
  };

  const resourcePools = new AsyncFolderNode("Resource Pools", "folder", async (ctx, api) => {
    const res = await api.execute(ctx.connectionUri, RG.RESOURCE_POOLS);
    const pools: Pool[] = res.rows.map((_, i) => ({
      id: Number(cell(res, i, "pool_id")),
      name: cell(res, i, "name"),
    }));
    const children: SsmsNode[] = pools
      .filter((p) => !RG.isSystemPoolName(p.name))
      .map(poolNode);
    children.push(
      new AsyncFolderNode("System Resource Pools", "folder", async () =>
        pools.filter((p) => RG.isSystemPoolName(p.name)).map(poolNode)
      )
    );
    return children;
  });

  const externalLeaf = (pool: Pool): SsmsNode => {
    const leaf = new GridLeafNode(
      pool.name,
      "database",
      `External Resource Pool — ${pool.name}`,
      RG.externalPoolDetails(pool.name)
    );
    if (!RG.isSystemPoolName(pool.name)) {
      leaf.contextValue = "ssmsExternalPool";
      leaf.scriptTarget = { kind: "externalPool", name: pool.name };
    }
    return leaf;
  };

  const externalPools = new AsyncFolderNode(
    "External Resource Pools",
    "folder",
    async (ctx, api) => {
      const res = await api.execute(ctx.connectionUri, RG.EXTERNAL_RESOURCE_POOLS);
      const pools: Pool[] = res.rows.map((_, i) => ({
        id: Number(cell(res, i, "external_pool_id")),
        name: cell(res, i, "name"),
      }));
      const children: SsmsNode[] = pools
        .filter((p) => !RG.isSystemPoolName(p.name))
        .map(externalLeaf);
      children.push(
        new AsyncFolderNode("System External Resource Pools", "folder", async () =>
          pools.filter((p) => RG.isSystemPoolName(p.name)).map(externalLeaf)
        )
      );
      return children;
    }
  );

  const rgNode = new AsyncFolderNode(
    "Resource Governor",
    "dashboard",
    async () => [resourcePools, externalPools],
    // Resource Governor is boxed-product only (not Azure SQL DB / MI).
    isBoxedProduct
  );
  // Right-click target for the editable Resource Governor Properties dialog.
  rgNode.contextValue = "ssmsResourceGovernor";
  return rgNode;
}

/** SQL Server Agent subtree: Jobs (→ Steps/Schedules/History), Alerts,
 * Operators, Proxies, Error Logs. Not available on Azure SQL DB. */
function buildSqlAgentNode(): SsmsNode {
  const jobsFolder = new AsyncFolderNode("Jobs", "checklist", async (ctx, api) => {
    const res = await api.execute(ctx.connectionUri, Agent.JOBS);
    const idIdx = res.columnInfo.findIndex((c) => c.columnName === "job_id");
    return res.rows.map((row, i) => {
      const jobId = row[idIdx]?.displayValue ?? "";
      const name = cell(res, i, "name");
      const enabled = cell(res, i, "enabled") === "1";
      const outcome = cell(res, i, "last_outcome");
      const job = new AsyncFolderNode(name, enabled ? "play-circle" : "circle-slash", async () => [
        new GridLeafNode("Steps", "list-ordered", `${name} — Steps`, Agent.jobSteps(jobId)),
        new GridLeafNode("Schedules", "calendar", `${name} — Schedules`, Agent.jobSchedules(jobId)),
      ]);
      job.description = [enabled ? "" : "Disabled", outcome].filter(Boolean).join(" · ");
      job.contextValue = "ssmsAgentJob";
      job.jobId = jobId;
      return job;
    });
  });
  // Right-click target for the (all-jobs) Job History viewer.
  jobsFolder.contextValue = "ssmsAgentJobsRoot";

  const itemsFolder = (
    label: string,
    icon: string,
    listSql: string,
    itemIcon: string,
    itemCtx: string,
    rootCtx: string
  ): SsmsNode => {
    const folder = new AsyncFolderNode(label, icon, async (ctx, api) => {
      const res = await api.execute(ctx.connectionUri, listSql);
      return res.rows.map((_, i) => {
        const name = cell(res, i, "Name");
        return new ItemNode(name, itemIcon, itemCtx, name);
      });
    });
    folder.contextValue = rootCtx;
    return folder;
  };

  return buildAgentRoot(jobsFolder, itemsFolder);
}

/** Proxies grouped by subsystem category (as in SSMS), plus Unassigned. */
function buildProxiesFolder(): SsmsNode {
  const SUBSYSTEMS: Array<[string, string]> = [
    ["CmdExec", "Operating System (CmdExec)"],
    ["Snapshot", "Replication Snapshot"],
    ["LogReader", "Replication Transaction-Log Reader"],
    ["Distribution", "Replication Distributor"],
    ["Merge", "Replication Merge"],
    ["QueueReader", "Replication Queue Reader"],
    ["ANALYSISQUERY", "Analysis Services Query"],
    ["ANALYSISCOMMAND", "Analysis Services Command"],
    ["Dts", "SSIS Package Execution"],
    ["PowerShell", "PowerShell"],
  ];
  const proxyLeaf = (name: string): SsmsNode =>
    new ItemNode(name, "key", "ssmsProxy", name);

  const folder = new AsyncFolderNode("Proxies", "key", async () => {
    const subFolders: SsmsNode[] = SUBSYSTEMS.map(
      ([code, label]) =>
        new AsyncFolderNode(label, "folder", async (ctx, api) => {
          const res = await api.execute(ctx.connectionUri, Agent.proxiesForSubsystem(code));
          return res.rows.map((_, i) => proxyLeaf(cell(res, i, "Name")));
        })
    );
    subFolders.push(
      new AsyncFolderNode("Unassigned Proxies", "folder", async (ctx, api) => {
        const res = await api.execute(ctx.connectionUri, Agent.PROXIES_UNASSIGNED);
        return res.rows.map((_, i) => proxyLeaf(cell(res, i, "Name")));
      })
    );
    return subFolders;
  });
  folder.contextValue = "ssmsProxiesRoot";
  return folder;
}

function buildAgentRoot(
  jobsFolder: SsmsNode,
  itemsFolder: (
    label: string,
    icon: string,
    listSql: string,
    itemIcon: string,
    itemCtx: string,
    rootCtx: string
  ) => SsmsNode
): SsmsNode {
  return new FolderNode(
    "SQL Server Agent",
    "server-process",
    () => [
      jobsFolder,
      itemsFolder("Alerts", "warning", Agent.ALERTS, "bell", "ssmsAlert", "ssmsAlertsRoot"),
      itemsFolder("Operators", "person", Agent.OPERATORS, "account", "ssmsOperator", "ssmsOperatorsRoot"),
      buildProxiesFolder(),
      new ErrorLogsNode("SQL Agent Error Logs", 2),
    ],
    // SQL Server Agent isn't available on Azure SQL DB (MI and boxed have it).
    (ctx) => !isAzureSqlDb(ctx)
  );
}

/** Top-level children of the view: the SSMS server-management folders. */
export function buildRootNodes(): SsmsNode[] {
  const management = new FolderNode(
    "Management",
    "tools",
    () => [
      new CommandLeafNode(
        "Backup / Restore History",
        "history",
        "ssms.openBackupHistory",
        (ctx) => !isAzureSqlDb(ctx)
      ),
      new ErrorLogsNode("SQL Server Logs", 1, (ctx) => !isAzureSqlDb(ctx)),
      new FolderNode(
        "Database Mail",
        "mail",
        () => [
          new GridLeafNode("Sent Items", "mail", "Database Mail — Items", Q.DATABASE_MAIL_ITEMS),
          new GridLeafNode("Profiles", "account", "Database Mail — Profiles", Q.DATABASE_MAIL_PROFILES),
        ],
        (ctx) => !isAzureSqlDb(ctx)
      ),
      buildResourceGovernorNode(),
    ],
    // The whole Management folder is boxed-product / Managed Instance only.
    (ctx) => !isAzureSqlDb(ctx)
  );

  // Azure SQL Database has no Management/Agent; surface what it does expose.
  const azure = new FolderNode(
    "Azure SQL Database",
    "azure",
    () => [
      new CommandLeafNode("Event Log", "output", "ssms.openAzureEventLog"),
      // Per-database resource usage: list databases lazily; connect to a
      // database only when its node is clicked.
      new AsyncFolderNode("Resource Usage", "pulse", async (ctx, api) => {
        const dbs = await api.listDatabases(ctx.connectionUri);
        return dbs
          .filter((db) => db.toLowerCase() !== "master")
          .map(
            (db) =>
              new CommandLeafNode(db, "database", "ssms.openDbResourceUsage", undefined, [db])
          );
      }),
    ],
    isAzureSqlDb
  );

  return [management, azure, buildSqlAgentNode()];
}
