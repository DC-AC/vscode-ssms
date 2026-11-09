import * as vscode from "vscode";
import type { QueryRunner } from "./backupHistory";

/** One replica row in the grid (values are the T-SQL tokens). */
export interface ReplicaRow {
  server: string;
  role: string;
  availabilityMode: string;
  failoverMode: string;
  primaryConnections: string;
  readableSecondary: string;
  seedingMode: string;
  sessionTimeout: string;
}

/** AG-level options shown below the grid. */
export interface AgLevel {
  backupPref: string;
  requiredSecondaries: string;
  healthCheckTimeout: string;
  dbFailover: boolean;
}

export interface AgPropertiesConfig {
  agName: string;
  replicas: ReplicaRow[];
  ag: AgLevel;
  /** Connected instance's SQL Server major version, for feature gating. */
  majorVersion: number;
  /** Build the batch from the edited grid + AG options. */
  makeBatch: (replicas: ReplicaRow[], ag: AgLevel) => string;
  onApplied: () => void;
}

/** A selectable option: [token, label, optional minimum SQL major version]. */
type Opt = [string, string, number?];

/** Column definitions. `minMajor` hides the whole column below that version. */
const COLS: Array<{ field: keyof ReplicaRow; label: string; options: Opt[]; minMajor?: number }> = [
  {
    field: "availabilityMode",
    label: "Availability Mode",
    options: [
      ["SYNCHRONOUS_COMMIT", "Synchronous commit"],
      ["ASYNCHRONOUS_COMMIT", "Asynchronous commit"],
      ["CONFIGURATION_ONLY", "Configuration only", 14],
    ],
  },
  {
    field: "failoverMode",
    label: "Failover Mode",
    options: [
      ["AUTOMATIC", "Automatic"],
      ["MANUAL", "Manual"],
    ],
  },
  {
    field: "primaryConnections",
    label: "Connections in Primary Role",
    options: [
      ["ALL", "Allow all connections"],
      ["READ_WRITE", "Allow read/write connections"],
    ],
  },
  {
    field: "readableSecondary",
    label: "Readable Secondary",
    options: [
      ["NO", "No"],
      ["READ_ONLY", "Read-intent only"],
      ["ALL", "Yes"],
    ],
  },
  {
    field: "seedingMode",
    label: "Seeding Mode",
    options: [
      ["AUTOMATIC", "Automatic"],
      ["MANUAL", "Manual"],
    ],
    minMajor: 13,
  },
];

const BACKUP_OPTS: Array<[string, string]> = [
  ["SECONDARY", "Prefer Secondary"],
  ["SECONDARY_ONLY", "Secondary only"],
  ["PRIMARY", "Primary"],
  ["NONE", "Any Replica"],
];

/**
 * SSMS-style Availability Group Properties: a per-replica grid (availability /
 * failover / connection / readable-secondary / seeding / session timeout) plus
 * the AG-level options. OK applies the generated ALTERs, Script opens them.
 */
export function openAvailabilityGroupProperties(
  run: QueryRunner,
  cfg: AgPropertiesConfig
): void {
  const panel = vscode.window.createWebviewPanel(
    "ssms.agProperties",
    `Availability Group Properties — ${cfg.agName}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml(cfg);

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; execute?: boolean; replicas?: ReplicaRow[]; ag?: AgLevel }) => {
      try {
        if (msg.type === "cancel") {
          panel.dispose();
          return;
        }
        if (msg.type === "apply" && msg.replicas && msg.ag) {
          const batch = cfg.makeBatch(msg.replicas, msg.ag);
          if (msg.execute) {
            await run(batch);
            vscode.window.showInformationMessage(
              `Availability Group Properties — ${cfg.agName}: applied.`
            );
            cfg.onApplied();
            panel.dispose();
          } else {
            const doc = await vscode.workspace.openTextDocument({
              language: "sql",
              content: batch + "\n",
            });
            await vscode.window.showTextDocument(doc, { preview: false });
          }
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

function nonce(): string {
  return Array.from({ length: 16 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
      Math.floor(Math.random() * 62)
    )
  ).join("");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A <select> baked with the current value pre-selected, options filtered to
 * those supported by the instance's major version. */
function selectCell(
  field: string,
  server: string,
  current: string,
  options: Opt[],
  major: number
): string {
  const avail = options.filter(([, , min]) => !min || major >= min);
  // Include the current token even if it isn't in our (filtered) option list.
  const known = avail.some(([v]) => v === current);
  const opts = (known ? avail : [[current, current] as Opt, ...avail])
    .map(([v, label]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(label)}</option>`)
    .join("");
  return `<select data-field="${field}" data-server="${esc(server)}">${opts}</select>`;
}

function renderHtml(cfg: AgPropertiesConfig): string {
  const nc = nonce();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nc}'`,
  ].join("; ");
  const major = cfg.majorVersion;
  const cols = COLS.filter((c) => !c.minMajor || major >= c.minMajor);

  const headCells =
    `<th>Server Instance</th><th>Role</th>` +
    cols.map((c) => `<th>${esc(c.label)}</th>`).join("") +
    `<th>Session Timeout (s)</th>`;

  const rows = cfg.replicas
    .map((r) => {
      const cells = cols
        .map((c) => `<td>${selectCell(c.field, r.server, String(r[c.field]), c.options, major)}</td>`)
        .join("");
      // Full original row travels in data-orig so hidden columns keep their value.
      const orig = esc(JSON.stringify(r));
      return `<tr data-server="${esc(r.server)}" data-role="${esc(r.role)}" data-orig="${orig}">
        <td class="ro">${esc(r.server)}</td>
        <td class="ro">${esc(r.role)}</td>
        ${cells}
        <td><input type="number" min="5" data-field="sessionTimeout" data-server="${esc(r.server)}" value="${esc(r.sessionTimeout)}"></td>
      </tr>`;
    })
    .join("\n");

  const backupOpts = BACKUP_OPTS.map(
    ([v, label]) => `<option value="${esc(v)}"${v === cfg.ag.backupPref ? " selected" : ""}>${esc(label)}</option>`
  ).join("");

  const showRequired = major >= 14;
  const showDbFailover = major >= 13;
  const agOrig = esc(JSON.stringify(cfg.ag));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 14px 72px; font-size: 13px; }
  h3 { font-weight: 600; margin: 0 0 4px; }
  .section { font-weight: 600; margin: 18px 0 6px; color: var(--vscode-foreground); }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 6px; text-align: left; white-space: nowrap; }
  th { background: var(--vscode-editorWidget-background); font-weight: 600; }
  td.ro { color: var(--vscode-descriptionForeground); }
  select, input { font-family: inherit; font-size: 13px; padding: 2px 4px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  input[type=number] { width: 70px; }
  .ag { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .ag label { color: var(--vscode-descriptionForeground); min-width: 260px; }
  .ag select, .ag input[type=number] { width: 240px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; cursor: pointer; padding: 3px 12px; border-radius: 2px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 14px;
    background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-panel-border);
    display: flex; gap: 8px; justify-content: flex-end; }
  .error { color: var(--vscode-errorForeground); margin-top: 8px; }
  .wrap { overflow-x: auto; }
</style>
</head>
<body>
  <h3>Availability Group Properties — ${esc(cfg.agName)}</h3>
  <div class="section">Availability Replicas</div>
  <div class="wrap">
  <table>
    <thead><tr>${headCells}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>

  <div class="section">Availability Group</div>
  <div class="ag"><label for="backupPref">Automated Backup Preference</label>
    <select id="backupPref">${backupOpts}</select></div>
  ${showRequired ? `<div class="ag"><label for="requiredSecondaries">Required Synchronized Secondaries To Commit</label>
    <input type="number" min="0" id="requiredSecondaries" value="${esc(cfg.ag.requiredSecondaries)}"></div>` : ""}
  <div class="ag"><label for="healthCheckTimeout">Health Check Timeout (ms)</label>
    <input type="number" min="15000" id="healthCheckTimeout" value="${esc(cfg.ag.healthCheckTimeout)}"></div>
  ${showDbFailover ? `<div class="ag"><label for="dbFailover">Database Level Health Detection</label>
    <input type="checkbox" id="dbFailover"${cfg.ag.dbFailover ? " checked" : ""}></div>` : ""}

  <div id="agorig" style="display:none">${agOrig}</div>
  <div id="msg"></div>
  <div class="footer">
    <button id="ok">OK</button>
    <button id="script" class="secondary">Script</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>
<script nonce="${nc}">
  const vscode = acquireVsCodeApi();
  function collect() {
    const replicas = [...document.querySelectorAll("tr[data-server]")].map((tr) => {
      // Start from the original row so columns hidden for this version are kept.
      const row = JSON.parse(tr.getAttribute("data-orig"));
      tr.querySelectorAll("[data-field]").forEach((el) => { row[el.dataset.field] = el.value; });
      return row;
    });
    const agOrig = JSON.parse(document.getElementById("agorig").textContent);
    const ag = {
      backupPref: document.getElementById("backupPref").value,
      requiredSecondaries: (document.getElementById("requiredSecondaries") || {}).value ?? agOrig.requiredSecondaries,
      healthCheckTimeout: document.getElementById("healthCheckTimeout").value,
      dbFailover: document.getElementById("dbFailover") ? document.getElementById("dbFailover").checked : agOrig.dbFailover,
    };
    return { replicas, ag };
  }
  document.getElementById("ok").addEventListener("click", () => { const v = collect(); vscode.postMessage({ type: "apply", execute: true, replicas: v.replicas, ag: v.ag }); });
  document.getElementById("script").addEventListener("click", () => { const v = collect(); vscode.postMessage({ type: "apply", execute: false, replicas: v.replicas, ag: v.ag }); });
  document.getElementById("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "error") {
      document.getElementById("msg").innerHTML = '<p class="error">' + String(e.data.message).replace(/</g, "&lt;") + "</p>";
    }
  });
</script>
</body>
</html>`;
}
