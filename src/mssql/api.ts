import * as vscode from "vscode";
import type {
  IExtension,
  IConnectionSharingService,
  IConnectionInfo,
  SimpleExecuteResult,
} from "vscode-mssql";

export const MSSQL_EXTENSION_ID = "ms-mssql.mssql";

/** Our extension id, as <publisher>.<name> from package.json. */
export const OUR_EXTENSION_ID = "dcac.vscode-ssms";

export class MssqlApiUnavailableError extends Error {}

/** Error codes raised by the mssql Connection Sharing service. */
export type SharingErrorCode =
  | "PERMISSION_DENIED"
  | "PERMISSION_REQUIRED"
  | "NO_ACTIVE_EDITOR"
  | "NO_ACTIVE_CONNECTION"
  | string;

/**
 * Extract the ConnectionSharingError code, if this is one. The error instance
 * crosses the extension boundary in-process, so its `name`/`code` string
 * properties are readable even though `instanceof` won't match.
 */
export function sharingErrorCode(err: unknown): SharingErrorCode | undefined {
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ConnectionSharingError"
  ) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

/**
 * Thin wrapper over the official mssql extension's Connection Sharing API.
 * All catalog queries flow through here so the rest of the extension never
 * touches vscode.extensions directly.
 */
export class MssqlApi {
  private constructor(
    private readonly ext: IExtension,
    private readonly sharing: IConnectionSharingService
  ) {}

  /**
   * Acquire the mssql extension API. Activates the extension if needed.
   * Throws MssqlApiUnavailableError if the extension is missing or too old
   * (Connection Sharing was introduced in mssql v1.38.0).
   */
  static async acquire(): Promise<MssqlApi> {
    const ext = vscode.extensions.getExtension<IExtension>(MSSQL_EXTENSION_ID);
    if (!ext) {
      throw new MssqlApiUnavailableError(
        "The SQL Server (mssql) extension is not installed."
      );
    }
    const exports = ext.isActive ? ext.exports : await ext.activate();
    const sharing = exports?.connectionSharing;
    if (!sharing) {
      throw new MssqlApiUnavailableError(
        "This feature needs the SQL Server (mssql) extension v1.38.0 or later. Please update it."
      );
    }
    return new MssqlApi(exports, sharing);
  }

  /**
   * Open (or reuse) a connection from a connection profile — e.g. the
   * `connectionProfile` of an Object Explorer server node — and return its URI.
   * We don't pass saveConnection, so no new profile is persisted.
   */
  async connectWithInfo(info: IConnectionInfo): Promise<string> {
    return this.ext.connect(info);
  }

  /**
   * Connection id of the connection backing the active SQL editor.
   * Throws a ConnectionSharingError for the expected states (no active editor,
   * permission required/denied); callers classify via {@link sharingErrorCode}.
   * Returns undefined when the active editor simply isn't connected. Note: the
   * first call prompts the user to approve connection sharing for this extension.
   */
  async getActiveEditorConnectionId(): Promise<string | undefined> {
    return this.sharing.getActiveEditorConnectionId(OUR_EXTENSION_ID);
  }

  /**
   * Open mssql's approve/deny quick-pick for this extension's sharing access.
   * Returns false if the installed mssql build doesn't implement it (the method
   * exists in the typings ahead of the shipped runtime); callers then fall back
   * to the automatic prompt that fires on first connection use.
   */
  async editSharingPermission(): Promise<boolean> {
    const fn = (
      this.sharing as Partial<IConnectionSharingService>
    ).editConnectionSharingPermissions;
    if (typeof fn !== "function") {
      return false;
    }
    await fn.call(this.sharing, OUR_EXTENSION_ID);
    return true;
  }

  /** Establish (or reuse) a connection URI for a given connection id. */
  async connect(connectionId: string, database?: string): Promise<string | undefined> {
    return this.sharing.connect(OUR_EXTENSION_ID, connectionId, database);
  }

  /** Run a read query and return the raw result. */
  async execute(connectionUri: string, sql: string): Promise<SimpleExecuteResult> {
    return this.sharing.executeSimpleQuery(connectionUri, sql);
  }

  /** List databases available on a connection (no per-database connect). */
  async listDatabases(connectionUri: string): Promise<string[]> {
    return this.sharing.listDatabases(connectionUri);
  }
}
