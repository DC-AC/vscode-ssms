import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";

/**
 * Renders a SimpleExecuteResult as a sortable, read-only HTML table.
 * Click a column header to sort (numeric-aware); click again to reverse.
 */
export function showGrid(
  title: string,
  result: SimpleExecuteResult,
  messages?: string
): void {
  const panel = vscode.window.createWebviewPanel(
    "ssms.grid",
    title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml(title, result, messages);
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

/** Safe JSON for embedding in a <script> (avoid breaking out of the tag). */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderHtml(
  title: string,
  result: SimpleExecuteResult,
  messages?: string
): string {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${n}'`,
  ].join("; ");

  const columns = result.columnInfo.map((c) => c.columnName);
  const rows = result.rows.map((row) =>
    row.map((c) => (c.isNull ? null : c.displayValue))
  );
  const note = messages ? `<p class="msg">${esc(messages)}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px 24px; }
  h2 { font-weight: 600; }
  .count { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .msg { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; font-size: var(--vscode-editor-font-size, 13px); }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 2px solid var(--vscode-panel-border); cursor: pointer; user-select: none; }
  th .arrow { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
  <h2>${esc(title)}</h2>
  <p class="count" id="count"></p>
  ${note}
  <table><thead id="thead"></thead><tbody id="tbody"></tbody></table>
<script nonce="${n}">
  const columns = ${jsonForScript(columns)};
  const rows = ${jsonForScript(rows)};
  const $ = (id) => document.getElementById(id);
  let sortCol = -1, sortDir = 1;
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function isNum(v){ return v !== null && v !== "" && !isNaN(Number(v)); }
  function sorted() {
    if (sortCol < 0) return rows;
    return [...rows].sort((a, b) => {
      const x = a[sortCol], y = b[sortCol];
      if (x === null || x === "") return 1;
      if (y === null || y === "") return -1;
      const c = (isNum(x) && isNum(y)) ? (Number(x) - Number(y)) : String(x).localeCompare(String(y));
      return c * sortDir;
    });
  }
  function render() {
    $("thead").innerHTML = "<tr>" + columns.map((c, i) =>
      '<th data-i="' + i + '">' + esc(c) + (i === sortCol ? '<span class="arrow"> ' + (sortDir > 0 ? "▲" : "▼") + "</span>" : "") + "</th>"
    ).join("") + "</tr>";
    $("tbody").innerHTML = sorted().map(r => "<tr>" + r.map(v =>
      v === null ? '<td class="null">NULL</td>' : "<td>" + esc(v) + "</td>"
    ).join("") + "</tr>").join("");
    [...$("thead").querySelectorAll("th")].forEach(th => th.addEventListener("click", () => {
      const i = +th.dataset.i;
      if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; }
      render();
    }));
    $("count").textContent = rows.length + " row(s)";
  }
  render();
</script>
</body>
</html>`;
}
