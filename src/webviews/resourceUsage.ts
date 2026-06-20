import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";
import { resourceStatsQuery, ResourceStatsFilters } from "../queries/azure";
import type { QueryRunner } from "./backupHistory";

/**
 * Per-database resource usage (sys.resource_stats, read from master) with an
 * optional start/end date filter. The runner must reach master.
 */
export function openResourceUsage(run: QueryRunner, database: string): void {
  const panel = vscode.window.createWebviewPanel(
    "ssms.resourceUsage",
    `Resource Usage — ${database}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml(database);

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; filters?: { startDate?: string; endDate?: string } }) => {
      try {
        if (msg.type === "ready" || msg.type === "apply") {
          const filters: ResourceStatsFilters = { database, ...(msg.filters ?? {}) };
          const result = await run(resourceStatsQuery(filters));
          panel.webview.postMessage({ type: "rows", ...serialize(result) });
        }
      } catch (err) {
        panel.webview.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}

function serialize(result: SimpleExecuteResult): {
  columns: string[];
  rows: (string | null)[][];
} {
  return {
    columns: result.columnInfo.map((c) => c.columnName),
    rows: result.rows.map((row) =>
      row.map((c) => (c.isNull ? null : c.displayValue))
    ),
  };
}

function nonce(): string {
  return Array.from({ length: 16 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
      Math.floor(Math.random() * 62)
    )
  ).join("");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHtml(database: string): string {
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
  h2 { font-weight: 600; margin: 12px 0 4px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 0 0 8px; }
  .filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: end;
             padding: 10px; margin-bottom: 10px;
             background: var(--vscode-editorWidget-background);
             border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .field { display: flex; flex-direction: column; gap: 3px; }
  .field label { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  input, button { font-family: inherit; font-size: 13px; padding: 3px 6px;
           color: var(--vscode-input-foreground); background: var(--vscode-input-background);
           border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; padding: 4px 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .count { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 2px solid var(--vscode-panel-border); cursor: pointer; user-select: none; }
  th .arrow { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  td.num { text-align: right; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <h2>Resource Usage — ${esc(database)}</h2>
  <p class="hint">sys.resource_stats (read from master) — up to ~14 days of history.</p>
  <div class="filters">
    <div class="field"><label for="from">Start date</label><input type="date" id="from"></div>
    <div class="field"><label for="to">End date</label><input type="date" id="to"></div>
    <button id="apply">Apply</button>
    <button id="reset" class="secondary">Reset</button>
  </div>
  <p class="count" id="count"></p>
  <div id="msg"></div>
  <table><thead id="thead"></thead><tbody id="tbody"></tbody></table>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let columns = [], rows = [], sortCol = -1, sortDir = 1;
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function isNumCol(i){ return columns[i] !== "Time" && columns[i] !== "SKU"; }

  function sorted() {
    if (sortCol < 0) return rows;
    const num = isNumCol(sortCol);
    return [...rows].sort((a, b) => {
      const x = a[sortCol], y = b[sortCol];
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp = num ? (parseFloat(x) - parseFloat(y)) : String(x).localeCompare(String(y));
      return cmp * sortDir;
    });
  }

  function render() {
    const timeIdx = columns.indexOf("Time"), skuIdx = columns.indexOf("SKU");
    $("thead").innerHTML = "<tr>" + columns.map((c, i) => {
      const arrow = i === sortCol ? '<span class="arrow"> ' + (sortDir > 0 ? "▲" : "▼") + "</span>" : "";
      return '<th data-i="' + i + '">' + esc(c) + arrow + "</th>";
    }).join("") + "</tr>";
    const data = sorted();
    $("tbody").innerHTML = data.map(r => "<tr>" + r.map((v, i) => {
      if (v === null) return "<td></td>";
      const num = i !== timeIdx && i !== skuIdx;
      return "<td" + (num ? ' class="num"' : "") + ">" + esc(v) + "</td>";
    }).join("") + "</tr>").join("");
    [...$("thead").querySelectorAll("th")].forEach(th => th.addEventListener("click", () => {
      const i = +th.dataset.i;
      if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; }
      render();
    }));
    $("count").textContent = rows.length + " row(s)" + (rows.length === 5000 ? " (showing first 5000)" : "");
    $("msg").innerHTML = "";
  }
  function filters() { return { startDate: $("from").value, endDate: $("to").value }; }
  $("apply").addEventListener("click", () => vscode.postMessage({ type: "apply", filters: filters() }));
  $("reset").addEventListener("click", () => {
    $("from").value = ""; $("to").value = "";
    vscode.postMessage({ type: "apply", filters: {} });
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "rows") { columns = m.columns; rows = m.rows; render(); }
    else if (m.type === "error") { $("msg").innerHTML = '<p class="error">' + esc(m.message) + "</p>"; }
  });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
