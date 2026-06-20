import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";
import { JOB_LIST, jobHistoryQuery, JobHistoryFilters } from "../queries/agent";
import type { QueryRunner } from "./backupHistory";

interface JobOption {
  id: string;
  name: string;
}

/**
 * SQL Server Agent job history with server-side filtering on job, outcome, and
 * date range. Opened from the Jobs folder or a specific job's History node
 * (which pre-selects that job).
 */
export function openJobHistory(run: QueryRunner, jobId?: string): void {
  const panel = vscode.window.createWebviewPanel(
    "ssms.jobHistory",
    "Job History",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml();

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; filters?: JobHistoryFilters }) => {
      try {
        if (msg.type === "ready") {
          const list = await run(JOB_LIST);
          const idIdx = list.columnInfo.findIndex((c) => c.columnName === "job_id");
          const nameIdx = list.columnInfo.findIndex((c) => c.columnName === "name");
          const jobs: JobOption[] = list.rows.map((r) => ({
            id: r[idIdx]?.displayValue ?? "",
            name: r[nameIdx]?.displayValue ?? "",
          }));
          const initial: JobHistoryFilters = jobId ? { jobId } : {};
          const result = await run(jobHistoryQuery(initial));
          panel.webview.postMessage({
            type: "init",
            jobs,
            selected: jobId ?? "",
            ...serialize(result),
          });
        } else if (msg.type === "apply") {
          const result = await run(jobHistoryQuery(msg.filters ?? {}));
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
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; padding: 4px 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .count { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 2px solid var(--vscode-panel-border); }
  td.msg { white-space: pre-wrap; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .fail { color: var(--vscode-errorForeground); }
  .error { color: var(--vscode-errorForeground); }
  #job { min-width: 220px; }
</style>
</head>
<body>
  <h2>Job History</h2>
  <div class="filters">
    <div class="field">
      <label for="job">Job</label>
      <select id="job"><option value="">(all jobs)</option></select>
    </div>
    <div class="field">
      <label for="outcome">Outcome</label>
      <select id="outcome">
        <option value="">(all)</option>
        <option value="1">Succeeded</option>
        <option value="0">Failed</option>
        <option value="3">Canceled</option>
        <option value="2">Retry</option>
        <option value="4">In Progress</option>
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
  let columns = [];

  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function render(rows) {
    const outIdx = columns.indexOf("Outcome");
    const msgIdx = columns.indexOf("Message");
    $("thead").innerHTML = "<tr>" + columns.map(c => "<th>" + esc(c) + "</th>").join("") + "</tr>";
    $("tbody").innerHTML = rows.map(r => "<tr>" + r.map((v, i) => {
      if (v === null) return "<td></td>";
      let cls = "";
      if (i === msgIdx) cls = "msg";
      if (i === outIdx) cls = v === "Succeeded" ? "ok" : (v === "Failed" ? "fail" : "");
      return "<td" + (cls ? ' class="' + cls + '"' : "") + ">" + esc(v) + "</td>";
    }).join("") + "</tr>").join("");
    $("count").textContent = rows.length + " row(s)" + (rows.length === 1000 ? " (showing first 1000)" : "");
    $("msg").innerHTML = "";
  }

  function filters() {
    return { jobId: $("job").value, runStatus: $("outcome").value, startDate: $("from").value, endDate: $("to").value };
  }

  $("apply").addEventListener("click", () => vscode.postMessage({ type: "apply", filters: filters() }));
  $("job").addEventListener("change", () => vscode.postMessage({ type: "apply", filters: filters() }));
  $("reset").addEventListener("click", () => {
    $("job").value = ""; $("outcome").value = ""; $("from").value = ""; $("to").value = "";
    vscode.postMessage({ type: "apply", filters: {} });
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "init") {
      const sel = $("job");
      for (const jb of m.jobs) {
        const o = document.createElement("option");
        o.value = jb.id; o.textContent = jb.name;
        if (jb.id === m.selected) o.selected = true;
        sel.appendChild(o);
      }
      columns = m.columns; render(m.rows);
    } else if (m.type === "rows") {
      columns = m.columns; render(m.rows);
    } else if (m.type === "error") {
      $("msg").innerHTML = '<p class="error">' + esc(m.message) + "</p>";
    }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
