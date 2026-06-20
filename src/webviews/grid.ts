import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";

/**
 * Renders a SimpleExecuteResult as a read-only HTML table in a webview panel.
 * Plain HTML/CSS (no bundler) — the panes are grid-heavy and this keeps the
 * build trivial while leaving a postMessage seam for richer panes later.
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
    { enableScripts: false, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml(title, result, messages);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderHtml(
  title: string,
  result: SimpleExecuteResult,
  messages?: string
): string {
  const cols = result.columnInfo.map((c) => c.columnName);
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = result.rows
    .map((row) => {
      const cells = row
        .map((cell) =>
          cell.isNull
            ? `<td class="null">NULL</td>`
            : `<td>${esc(cell.displayValue)}</td>`
        )
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  const note = messages ? `<p class="msg">${esc(messages)}</p>` : "";
  const empty = result.rows.length === 0 ? `<p class="msg">No rows.</p>` : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px 24px; }
  h2 { font-weight: 600; }
  .count { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  table { border-collapse: collapse; width: 100%; font-size: var(--vscode-editor-font-size, 13px); }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 2px solid var(--vscode-panel-border); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  .msg { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h2>${esc(title)}</h2>
  <p class="count">${result.rows.length} row(s)</p>
  ${note}
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  ${empty}
</body>
</html>`;
}
