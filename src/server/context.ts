import type { SimpleExecuteResult } from "vscode-mssql";
import { MssqlApi } from "../mssql/api";

/** SERVERPROPERTY('EngineEdition') values we care about. */
export enum EngineEdition {
  Personal = 1,
  Standard = 2,
  Enterprise = 3,
  Express = 4,
  AzureSqlDatabase = 5,
  AzureSynapse = 6,
  AzureManagedInstance = 8,
  AzureSqlEdge = 9,
}

/** Everything node-availability predicates need to decide what to show. */
export interface ServerContext {
  connectionUri: string;
  connectionId: string;
  engineEdition: EngineEdition;
  isHadrEnabled: boolean;
  productVersion: string;
  edition: string;
}

export function isAzureSqlDb(ctx: ServerContext): boolean {
  return ctx.engineEdition === EngineEdition.AzureSqlDatabase;
}

export function isManagedInstance(ctx: ServerContext): boolean {
  return ctx.engineEdition === EngineEdition.AzureManagedInstance;
}

/** Boxed product (on-prem or IaaS VM) — anything that isn't Azure PaaS. */
export function isBoxedProduct(ctx: ServerContext): boolean {
  return !isAzureSqlDb(ctx) && !isManagedInstance(ctx);
}

const PROBE_SQL = `
SELECT
    CAST(SERVERPROPERTY('EngineEdition')  AS int)           AS EngineEdition,
    CAST(ISNULL(SERVERPROPERTY('IsHadrEnabled'), 0) AS int) AS IsHadrEnabled,
    CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS ProductVersion,
    CAST(SERVERPROPERTY('Edition')        AS nvarchar(128)) AS Edition;
`;

function cell(result: SimpleExecuteResult, row: number, col: string): string {
  const idx = result.columnInfo.findIndex((c) => c.columnName === col);
  const value = idx >= 0 ? result.rows[row]?.[idx] : undefined;
  return value && !value.isNull ? value.displayValue : "";
}

export async function probeServerContext(
  api: MssqlApi,
  connectionUri: string,
  connectionId: string
): Promise<ServerContext> {
  const result = await api.execute(connectionUri, PROBE_SQL);
  return {
    connectionUri,
    connectionId,
    engineEdition: Number(cell(result, 0, "EngineEdition")) as EngineEdition,
    isHadrEnabled: cell(result, 0, "IsHadrEnabled") === "1",
    productVersion: cell(result, 0, "ProductVersion"),
    edition: cell(result, 0, "Edition"),
  };
}
