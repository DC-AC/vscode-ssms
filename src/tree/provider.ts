import * as vscode from "vscode";
import {
  MssqlApi,
  MssqlApiUnavailableError,
  sharingErrorCode,
} from "../mssql/api";
import { ServerContext, probeServerContext } from "../server/context";
import { SsmsNode, buildRootNodes } from "./nodes";

/**
 * Drives the Server Management view. Follows the active SQL editor's
 * connection: whatever connection backs the active editor is the server
 * shown in the tree.
 */
export class ServerManagementProvider
  implements vscode.TreeDataProvider<SsmsNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    SsmsNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private api: MssqlApi | undefined;
  private context: ServerContext | undefined;
  private statusMessage: string | undefined;
  private view: vscode.TreeView<SsmsNode> | undefined;
  /** When set, the tree is pinned to this connection URI instead of following
   * the active editor (used by "Open in SSMS Tools" from a server node). */
  private pinnedUri: string | undefined;

  /** Wire up the view once it has been created with this provider. */
  setView(view: vscode.TreeView<SsmsNode>): void {
    this.view = view;
  }

  /** Manual refresh (toolbar): force a full re-probe of the active connection. */
  refresh(): void {
    this.context = undefined;
    this.statusMessage = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Pin the tree to a specific connection URI (from a server right-click),
   * overriding active-editor follow until the user pins another or refreshes
   * onto a connected editor.
   */
  async pinConnection(uri: string): Promise<void> {
    this.pinnedUri = uri;
    this.context = undefined;
    this.statusMessage = undefined;
    await this.ensureContext();
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Soft follow when the active text editor changes. A focused, *connected*
   * editor takes over (and clears any pin). If the new editor isn't connected
   * (our webview grid, an unconnected file), we keep showing the current
   * server rather than blanking the tree.
   */
  async onActiveEditorChanged(): Promise<void> {
    try {
      this.api ??= await MssqlApi.acquire();
      const connectionId = await this.api.getActiveEditorConnectionId();
      if (!connectionId) {
        return; // not a connected editor — leave the current view as-is
      }
      const uri = await this.api.connect(connectionId);
      if (!uri) {
        return;
      }
      this.pinnedUri = undefined;
      this.context = await probeServerContext(this.api, uri, connectionId);
      this.statusMessage = undefined;
      this._onDidChangeTreeData.fire(undefined);
    } catch {
      // NO_ACTIVE_EDITOR / permission / transient — keep the current view.
    }
  }

  /** The connection URI the tree is currently showing (pinned or followed). */
  async currentConnectionUri(): Promise<string | undefined> {
    const ctx = await this.ensureContext();
    return ctx?.connectionUri;
  }

  /** The connection id the tree is currently showing, if known (used to open a
   * sibling connection to a different database, e.g. master on Azure SQL DB). */
  async currentConnectionId(): Promise<string | undefined> {
    const ctx = await this.ensureContext();
    return ctx?.connectionId;
  }

  getTreeItem(element: SsmsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SsmsNode): Promise<SsmsNode[]> {
    const ctx = await this.ensureContext();
    if (!ctx) {
      // No connection / unavailable — viewsWelcome handles the empty case;
      // surface any error in the view message.
      if (this.view) {
        this.view.message = this.statusMessage;
      }
      return [];
    }
    if (this.view) {
      this.view.message = undefined;
      this.view.title = `Server Management — ${ctx.edition} (${ctx.productVersion})`;
    }

    if (element) {
      return this.filtered(await element.getChildren(ctx, this.api!), ctx);
    }
    return this.filtered(buildRootNodes(), ctx);
  }

  private filtered(nodes: SsmsNode[], ctx: ServerContext): SsmsNode[] {
    return nodes.filter((n) => n.isAvailable(ctx));
  }

  /** Resolve API + active connection + server probe, caching the result. */
  private async ensureContext(): Promise<ServerContext | undefined> {
    if (this.context) {
      return this.context;
    }
    try {
      this.api ??= await MssqlApi.acquire();

      // Pinned mode: a server was opened explicitly via "Open in SSMS Tools".
      if (this.pinnedUri) {
        this.context = await probeServerContext(
          this.api,
          this.pinnedUri,
          this.pinnedUri
        );
        return this.context;
      }

      let connectionId: string | undefined;
      try {
        connectionId = await this.api.getActiveEditorConnectionId();
      } catch (e) {
        const code = sharingErrorCode(e);
        switch (code) {
          case "NO_ACTIVE_EDITOR":
            this.statusMessage =
              "Open and focus a connected SQL editor to see its server management.";
            return undefined;
          case "PERMISSION_REQUIRED":
            this.statusMessage =
              'This view needs permission to use your SQL connection. Run "SSMS Tools: Grant Connection Access".';
            return undefined;
          case "PERMISSION_DENIED":
            this.statusMessage =
              'Connection sharing was denied. Run "SSMS Tools: Grant Connection Access" to change it.';
            return undefined;
          default:
            throw e;
        }
      }

      if (!connectionId) {
        this.statusMessage =
          "The active SQL editor isn't connected. Connect it, then Refresh.";
        return undefined;
      }
      const uri = await this.api.connect(connectionId);
      if (!uri) {
        this.statusMessage = "Could not establish a shared connection.";
        return undefined;
      }
      this.context = await probeServerContext(this.api, uri, connectionId);
      return this.context;
    } catch (err) {
      this.statusMessage =
        err instanceof MssqlApiUnavailableError
          ? err.message
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return undefined;
    }
  }
}
