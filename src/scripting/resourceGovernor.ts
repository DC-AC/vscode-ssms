import type { SimpleExecuteResult } from "vscode-mssql";
import * as RG from "../queries/resourceGovernor";

export type ScriptKind = "resourcePool" | "workloadGroup" | "externalPool";
export type ScriptOp = "create" | "alter";

/** Identifies a Resource Governor object a tree node can be scripted from. */
export interface ScriptTarget {
  kind: ScriptKind;
  name: string;
}

/** Typed settings — the single source the DDL builders work from, used by both
 * right-click scripting (mapped from catalog rows) and the Properties dialog. */
export interface ResourcePoolSettings {
  name: string;
  minCpu: number;
  maxCpu: number;
  capCpu: number;
  minMem: number;
  maxMem: number;
  minIops: number;
  maxIops: number;
}

export interface WorkloadGroupSettings {
  name: string;
  importance: string;
  maxMemGrantPct: number;
  maxCpuSec: number;
  memGrantTimeoutSec: number;
  maxDop: number;
  maxRequests: number;
  pool: string;
}

export interface ExternalPoolSettings {
  name: string;
  maxCpu: number;
  maxMem: number;
  maxProcesses: number;
}

type Runner = (sql: string) => Promise<SimpleExecuteResult>;

export const RECONFIGURE = "ALTER RESOURCE GOVERNOR RECONFIGURE;";

/** Quote a SQL identifier with brackets, escaping any embedded ']'. */
export function bracket(name: string): string {
  return "[" + name.replace(/]/g, "]]") + "]";
}

const verb = (op: ScriptOp): string => (op === "create" ? "CREATE" : "ALTER");

export function ddlResourcePool(s: ResourcePoolSettings, op: ScriptOp): string {
  return [
    `${verb(op)} RESOURCE POOL ${bracket(s.name)}`,
    `WITH`,
    `(`,
    `    MIN_CPU_PERCENT = ${s.minCpu},`,
    `    MAX_CPU_PERCENT = ${s.maxCpu},`,
    `    CAP_CPU_PERCENT = ${s.capCpu},`,
    `    MIN_MEMORY_PERCENT = ${s.minMem},`,
    `    MAX_MEMORY_PERCENT = ${s.maxMem},`,
    `    MIN_IOPS_PER_VOLUME = ${s.minIops},`,
    `    MAX_IOPS_PER_VOLUME = ${s.maxIops}`,
    `);`,
  ].join("\n");
}

export function ddlWorkloadGroup(s: WorkloadGroupSettings, op: ScriptOp): string {
  return [
    `${verb(op)} WORKLOAD GROUP ${bracket(s.name)}`,
    `WITH`,
    `(`,
    `    IMPORTANCE = ${s.importance.toUpperCase()},`,
    `    REQUEST_MAX_MEMORY_GRANT_PERCENT = ${s.maxMemGrantPct},`,
    `    REQUEST_MAX_CPU_TIME_SEC = ${s.maxCpuSec},`,
    `    REQUEST_MEMORY_GRANT_TIMEOUT_SEC = ${s.memGrantTimeoutSec},`,
    `    MAX_DOP = ${s.maxDop},`,
    `    GROUP_MAX_REQUESTS = ${s.maxRequests}`,
    `)`,
    `USING ${bracket(s.pool)};`,
  ].join("\n");
}

export function ddlExternalPool(s: ExternalPoolSettings, op: ScriptOp): string {
  return [
    `${verb(op)} EXTERNAL RESOURCE POOL ${bracket(s.name)}`,
    `WITH`,
    `(`,
    `    MAX_CPU_PERCENT = ${s.maxCpu},`,
    `    MAX_MEMORY_PERCENT = ${s.maxMem},`,
    `    MAX_PROCESSES = ${s.maxProcesses}`,
    `);`,
  ].join("\n");
}

/** Flatten the first result row into a column-name -> value map. */
function rowMap(result: SimpleExecuteResult): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  const row = result.rows[0];
  if (!row) {
    return map;
  }
  result.columnInfo.forEach((c, i) => {
    const v = row[i];
    map[c.columnName] = v && !v.isNull ? v.displayValue : null;
  });
  return map;
}

const n = (value: string | null, fallback: number): number =>
  value !== null && value !== "" ? Number(value) : fallback;

/** Fetch an object's current settings and produce CREATE/ALTER T-SQL,
 * followed by RECONFIGURE (right-click "Script as ..."). */
export async function generateScript(
  run: Runner,
  target: ScriptTarget,
  op: ScriptOp
): Promise<string> {
  let body: string;
  if (target.kind === "resourcePool") {
    const r = rowMap(await run(RG.resourcePoolRow(target.name)));
    body = ddlResourcePool(
      {
        name: r["name"] ?? target.name,
        minCpu: n(r["min_cpu_percent"], 0),
        maxCpu: n(r["max_cpu_percent"], 100),
        capCpu: n(r["cap_cpu_percent"], 100),
        minMem: n(r["min_memory_percent"], 0),
        maxMem: n(r["max_memory_percent"], 100),
        minIops: n(r["min_iops_per_volume"], 0),
        maxIops: n(r["max_iops_per_volume"], 0),
      },
      op
    );
  } else if (target.kind === "workloadGroup") {
    const r = rowMap(await run(RG.workloadGroupRow(target.name)));
    body = ddlWorkloadGroup(
      {
        name: r["name"] ?? target.name,
        importance: r["importance"] ?? "Medium",
        maxMemGrantPct: n(r["request_max_memory_grant_percent"], 25),
        maxCpuSec: n(r["request_max_cpu_time_sec"], 0),
        memGrantTimeoutSec: n(r["request_memory_grant_timeout_sec"], 0),
        maxDop: n(r["max_dop"], 0),
        maxRequests: n(r["group_max_requests"], 0),
        pool: r["ResourcePool"] ?? "default",
      },
      op
    );
  } else {
    const r = rowMap(await run(RG.externalPoolRow(target.name)));
    body = ddlExternalPool(
      {
        name: r["name"] ?? target.name,
        maxCpu: n(r["max_cpu_percent"], 100),
        maxMem: n(r["max_memory_percent"], 100),
        maxProcesses: n(r["max_processes"], 0),
      },
      op
    );
  }
  return `${body}\n\n${RECONFIGURE}\n`;
}
