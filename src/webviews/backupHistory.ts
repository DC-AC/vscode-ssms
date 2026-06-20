import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";
import {
  backupHistoryQuery,
  BACKUP_DATABASES,
  BackupFilters,
} from "../queries/management";

/** Runs a query against the active connection and returns the raw result. */
export type QueryRunner = (sql: string) => Promise<SimpleExecuteResult>;

/**
 * Backup History pane with server-side filtering (database, type, date range).
 * The webview posts filter criteria back; we rebuild the query and push rows.
 */
export function openBackupHistory(run: QueryRunner): void {
  const panel = vscode.window.createWebviewPanel(
    "ssms.backupHistory",
    "Backup History",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml();

  panel.webview.onDidReceiveMessage(async (msg: { type: string; filters?: BackupFilters }) => {
    try {
      if (msg.type === "ready") {
        const dbs = await run(BACKUP_DATABASES);
        const databases = dbs.rows.map((r) => r[0]?.displayValue ?? "");
        const result = await run(backupHistoryQuery({}));
        panel.webview.postMessage({ type: "init", databases, ...serialize(result) });
      } else if (msg.type === "apply") {
        const result = await run(backupHistoryQuery(msg.filters ?? {}));
        panel.webview.postMessage({ type: "rows", ...serialize(result) });
      }
    } catch (err) {
      panel.webview.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function serialize(result: SimpleExecuteResult): {
  columns: string[];
  rows: (string | null)[][];
} {
  return {
    columns: result.columnInfo.map((c) => c.columnName),
    rows: result.rows.map((row) => row.map((c) => (c.isNull ? null : c.displayValue))),
  };
}

function nonce(): string {
  return Array.from({ length: 16 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
      Math.floor(Math.random() * 62)
    )
  ).join("");
}

function renderHtml(): string {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${n}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px 24px; }
  h2 { font-weight: 600; margin: 12px 0 8px; }
  .filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: end;
             padding: 10px; margin-bottom: 10px;
             background: var(--vscode-editorWidget-background);
             border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .field { display: flex; flex-direction: column; gap: 3px; }
  .field label { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  select, input, button { font-family: inherit; font-size: 13px; padding: 3px 6px;
           color: var(--vscode-input-foreground); background: var(--vscode-input-background);
           border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; cursor: pointer; padding: 4px 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .count { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 2px solid var(--vscode-panel-border); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  .num { text-align: right; }
  .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <h2>Backup / Restore History</h2>
  <div class="filters">
    <div class="field">
      <label for="db">Database</label>
      <select id="db"><option value="">(all)</option></select>
    </div>
    <div class="field">
      <label for="type">Type</label>
      <select id="type">
        <option value="">(all)</option>
        <option value="D">Full</option>
        <option value="I">Differential</option>
        <option value="L">Log</option>
        <option value="F">File/Filegroup</option>
      </select>
    </div>
    <div class="field">
      <label for="from">From</label>
      <input type="date" id="from">
    </div>
    <div class="field">
      <label for="to">To</label>
      <input type="date" id="to">
    </div>
    <button id="apply">Apply</button>
    <button id="reset" class="secondary">Reset</button>
  </div>
  <p class="count" id="count"></p>
  <div id="msg"></div>
  <table><thead id="thead"></thead><tbody id="tbody"></tbody></table>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const SIZE_COL = "SizeMB";

  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function render(columns, rows) {
    $("thead").innerHTML = "<tr>" + columns.map(c => "<th>" + esc(c) + "</th>").join("") + "</tr>";
    const sizeIdx = columns.indexOf(SIZE_COL);
    $("tbody").innerHTML = rows.map(r => "<tr>" + r.map((v, i) =>
      v === null ? '<td class="null">NULL</td>'
                 : '<td' + (i === sizeIdx ? ' class="num"' : '') + '>' + esc(v) + "</td>"
    ).join("") + "</tr>").join("");
    $("count").textContent = rows.length + " row(s)" + (rows.length === 1000 ? " (showing first 1000)" : "");
    $("msg").innerHTML = "";
  }

  function currentFilters() {
    return { database: $("db").value, type: $("type").value, startDate: $("from").value, endDate: $("to").value };
  }

  $("apply").addEventListener("click", () => vscode.postMessage({ type: "apply", filters: currentFilters() }));
  $("reset").addEventListener("click", () => {
    $("db").value = ""; $("type").value = ""; $("from").value = ""; $("to").value = "";
    vscode.postMessage({ type: "apply", filters: {} });
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "init") {
      const sel = $("db");
      for (const d of m.databases) { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); }
      render(m.columns, m.rows);
    } else if (m.type === "rows") {
      render(m.columns, m.rows);
    } else if (m.type === "error") {
      $("msg").innerHTML = '<p class="error">' + esc(m.message) + "</p>";
    }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
