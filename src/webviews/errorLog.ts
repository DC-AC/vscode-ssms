import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";
import {
  errorLogQuery,
  enumErrorLogs,
  ErrorLogFilters,
} from "../queries/management";
import type { QueryRunner } from "./backupHistory";

interface LogFile {
  number: number;
  label: string;
}

/**
 * SQL Server / Agent error log viewer with SSMS-style filtering. Date range,
 * message text, and sort are pushed to xp_readerrorlog (server-side); Source is
 * filtered client-side on the ProcessInfo column. logType: 1 = SQL Server,
 * 2 = SQL Server Agent.
 */
export function openErrorLog(run: QueryRunner, logNumber = 0, logType: 1 | 2 = 1): void {
  const panel = vscode.window.createWebviewPanel(
    "ssms.errorLog",
    logType === 2 ? "SQL Server Agent Logs" : "SQL Server Logs",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml(logType);

  const load = async (filters: ErrorLogFilters): Promise<void> => {
    const result = await run(errorLogQuery({ ...filters, logType }));
    panel.webview.postMessage({ type: "rows", ...serialize(result) });
  };

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; filters?: ErrorLogFilters }) => {
      try {
        if (msg.type === "ready") {
          const logs = await loadLogList(run, logType);
          const initial: ErrorLogFilters = { logNumber, sort: "desc", logType };
          const result = await run(errorLogQuery(initial));
          panel.webview.postMessage({
            type: "init",
            logs,
            selected: logNumber,
            ...serialize(result),
          });
        } else if (msg.type === "apply") {
          await load(msg.filters ?? { logNumber: 0 });
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

async function loadLogList(run: QueryRunner, logType: 1 | 2): Promise<LogFile[]> {
  const result = await run(enumErrorLogs(logType));
  const numIdx = result.columnInfo.findIndex((c) => /Archive/i.test(c.columnName));
  const dateIdx = result.columnInfo.findIndex((c) => /Date/i.test(c.columnName));
  return result.rows.map((row, i) => {
    const number = numIdx >= 0 ? Number(row[numIdx]?.displayValue) : i;
    const date = dateIdx >= 0 ? row[dateIdx]?.displayValue ?? "" : "";
    const base = number === 0 ? "Current" : `Archive #${number}`;
    return { number, label: date ? `${base} — ${date}` : base };
  });
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

function renderHtml(logType: 1 | 2): string {
  const heading = logType === 2 ? "SQL Server Agent Logs" : "SQL Server Logs";
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
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 2px solid var(--vscode-panel-border); cursor: pointer; user-select: none; }
  th .arrow { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  td.text { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .error { color: var(--vscode-errorForeground); }
  .search { min-width: 200px; }
</style>
</head>
<body>
  <h2>${heading}</h2>
  <div class="filters">
    <div class="field">
      <label for="log">Log</label>
      <select id="log"></select>
    </div>
    <div class="field">
      <label for="from">Start Date</label>
      <input type="date" id="from">
    </div>
    <div class="field">
      <label for="to">End Date</label>
      <input type="date" id="to">
    </div>
    <div class="field">
      <label for="search">Message contains text</label>
      <input type="text" id="search" class="search" placeholder="e.g. login failed">
    </div>
    <div class="field">
      <label for="source">Source</label>
      <input type="text" id="source" placeholder="e.g. Logon, spid51">
    </div>
    <div class="field">
      <label for="sort">Sort</label>
      <select id="sort">
        <option value="desc">Newest first</option>
        <option value="asc">Oldest first</option>
      </select>
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
  let columns = [], rows = [], sortCol = -1, sortDir = 1;

  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function isNum(v){ return v !== null && v !== "" && !isNaN(Number(v)); }

  function sourceColIndex() {
    const i = columns.findIndex(c => /ProcessInfo/i.test(c));
    return i >= 0 ? i : 1;
  }
  function textColIndex() {
    const i = columns.findIndex(c => /^Text$/i.test(c));
    return i >= 0 ? i : columns.length - 1;
  }

  function render() {
    const srcTerm = $("source").value.trim().toLowerCase();
    const srcIdx = sourceColIndex(), txtIdx = textColIndex();
    let shown = srcTerm
      ? rows.filter(r => String(r[srcIdx] ?? "").toLowerCase().includes(srcTerm))
      : rows.slice();
    if (sortCol >= 0) {
      shown = shown.slice().sort((a, b) => {
        const x = a[sortCol], y = b[sortCol];
        if (x === null || x === "") return 1;
        if (y === null || y === "") return -1;
        const c = (isNum(x) && isNum(y)) ? (Number(x) - Number(y)) : String(x).localeCompare(String(y));
        return c * sortDir;
      });
    }
    $("thead").innerHTML = "<tr>" + columns.map((c, i) =>
      '<th data-i="' + i + '">' + esc(c) + (i === sortCol ? '<span class="arrow"> ' + (sortDir > 0 ? "▲" : "▼") + "</span>" : "") + "</th>"
    ).join("") + "</tr>";
    $("tbody").innerHTML = shown.map(r => "<tr>" + r.map((v, i) =>
      v === null ? "<td></td>"
                 : "<td" + (i === txtIdx ? ' class="text"' : "") + ">" + esc(v) + "</td>"
    ).join("") + "</tr>").join("");
    [...$("thead").querySelectorAll("th")].forEach(th => th.addEventListener("click", () => {
      const i = +th.dataset.i;
      if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; }
      render();
    }));
    $("count").textContent = shown.length + " row(s)" + (srcTerm ? " (Source filtered)" : "");
    $("msg").innerHTML = "";
  }

  function serverFilters() {
    return {
      logNumber: Number($("log").value || 0),
      search: $("search").value.trim(),
      startDate: $("from").value,
      endDate: $("to").value,
      sort: $("sort").value
    };
  }

  $("apply").addEventListener("click", () => vscode.postMessage({ type: "apply", filters: serverFilters() }));
  $("log").addEventListener("change", () => vscode.postMessage({ type: "apply", filters: serverFilters() }));
  $("source").addEventListener("input", render);
  $("reset").addEventListener("click", () => {
    $("from").value = ""; $("to").value = ""; $("search").value = ""; $("source").value = ""; $("sort").value = "desc";
    vscode.postMessage({ type: "apply", filters: serverFilters() });
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "init") {
      const sel = $("log");
      for (const lf of m.logs) {
        const o = document.createElement("option");
        o.value = lf.number; o.textContent = lf.label;
        if (lf.number === m.selected) o.selected = true;
        sel.appendChild(o);
      }
      columns = m.columns; rows = m.rows; render();
    } else if (m.type === "rows") {
      columns = m.columns; rows = m.rows; render();
    } else if (m.type === "error") {
      $("msg").innerHTML = '<p class="error">' + esc(m.message) + "</p>";
    }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
