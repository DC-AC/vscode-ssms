import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";
import * as RG from "../queries/resourceGovernor";
import {
  ResourcePoolSettings,
  WorkloadGroupSettings,
  ExternalPoolSettings,
  ddlResourcePool,
  ddlWorkloadGroup,
  ddlExternalPool,
  bracket,
  RECONFIGURE,
} from "../scripting/resourceGovernor";
import type { QueryRunner } from "./backupHistory";

interface RGModel {
  enabled: boolean;
  classifier: string; // "" = none, else "[schema].[func]"
  pools: ResourcePoolSettings[];
  groups: WorkloadGroupSettings[];
  external: ExternalPoolSettings[];
}

const num = (result: SimpleExecuteResult, row: number, col: string): number => {
  const i = result.columnInfo.findIndex((c) => c.columnName === col);
  const v = i >= 0 ? result.rows[row]?.[i] : undefined;
  return v && !v.isNull ? Number(v.displayValue) : 0;
};
const str = (result: SimpleExecuteResult, row: number, col: string): string => {
  const i = result.columnInfo.findIndex((c) => c.columnName === col);
  const v = i >= 0 ? result.rows[row]?.[i] : undefined;
  return v && !v.isNull ? v.displayValue : "";
};

async function loadModel(run: QueryRunner): Promise<RGModel> {
  const cfg = await run(RG.RG_CONFIGURATION);
  const schema = str(cfg, 0, "classifier_schema");
  const fname = str(cfg, 0, "classifier_name");
  const classifier = fname ? `${bracket(schema)}.${bracket(fname)}` : "";

  const poolsRes = await run(RG.RESOURCE_POOLS_FULL);
  const pools: ResourcePoolSettings[] = poolsRes.rows.map((_, i) => ({
    name: str(poolsRes, i, "name"),
    minCpu: num(poolsRes, i, "min_cpu_percent"),
    maxCpu: num(poolsRes, i, "max_cpu_percent"),
    capCpu: num(poolsRes, i, "cap_cpu_percent"),
    minMem: num(poolsRes, i, "min_memory_percent"),
    maxMem: num(poolsRes, i, "max_memory_percent"),
    minIops: num(poolsRes, i, "min_iops_per_volume"),
    maxIops: num(poolsRes, i, "max_iops_per_volume"),
  }));

  const grpRes = await run(RG.WORKLOAD_GROUPS_FULL);
  const groups: WorkloadGroupSettings[] = grpRes.rows.map((_, i) => ({
    name: str(grpRes, i, "name"),
    importance: str(grpRes, i, "importance") || "Medium",
    maxMemGrantPct: num(grpRes, i, "request_max_memory_grant_percent"),
    maxCpuSec: num(grpRes, i, "request_max_cpu_time_sec"),
    memGrantTimeoutSec: num(grpRes, i, "request_memory_grant_timeout_sec"),
    maxDop: num(grpRes, i, "max_dop"),
    maxRequests: num(grpRes, i, "group_max_requests"),
    pool: str(grpRes, i, "pool"),
  }));

  const extRes = await run(RG.EXTERNAL_POOLS_FULL);
  const external: ExternalPoolSettings[] = extRes.rows.map((_, i) => ({
    name: str(extRes, i, "name"),
    maxCpu: num(extRes, i, "max_cpu_percent"),
    maxMem: num(extRes, i, "max_memory_percent"),
    maxProcesses: num(extRes, i, "max_processes"),
  }));

  return {
    enabled: num(cfg, 0, "is_enabled") === 1,
    classifier,
    pools,
    groups,
    external,
  };
}

/** Diff the edited model against the original and emit CREATE/ALTER DDL,
 * classifier change, and enable/disable. Never touches the 'internal' objects. */
function buildBatch(original: RGModel, edited: RGModel): string {
  const stmts: string[] = [];
  const byName = <T extends { name: string }>(arr: T[]) =>
    new Map(arr.map((x) => [x.name, x]));

  const origPools = byName(original.pools);
  for (const p of edited.pools) {
    if (p.name === "internal") continue;
    const prev = origPools.get(p.name);
    if (!prev) stmts.push(ddlResourcePool(p, "create"));
    else if (JSON.stringify(prev) !== JSON.stringify(p))
      stmts.push(ddlResourcePool(p, "alter"));
  }

  const origGroups = byName(original.groups);
  for (const g of edited.groups) {
    if (g.name === "internal") continue;
    const prev = origGroups.get(g.name);
    if (!prev) stmts.push(ddlWorkloadGroup(g, "create"));
    else if (JSON.stringify(prev) !== JSON.stringify(g))
      stmts.push(ddlWorkloadGroup(g, "alter"));
  }

  const origExt = byName(original.external);
  for (const e of edited.external) {
    const prev = origExt.get(e.name);
    if (!prev) stmts.push(ddlExternalPool(e, "create"));
    else if (JSON.stringify(prev) !== JSON.stringify(e))
      stmts.push(ddlExternalPool(e, "alter"));
  }

  if (edited.classifier !== original.classifier) {
    const fn = edited.classifier ? edited.classifier : "NULL";
    stmts.push(`ALTER RESOURCE GOVERNOR WITH (CLASSIFIER_FUNCTION = ${fn});`);
  }

  // Enable/disable + apply pending changes.
  if (edited.enabled) {
    stmts.push(RECONFIGURE);
  } else if (original.enabled && !edited.enabled) {
    stmts.push("ALTER RESOURCE GOVERNOR DISABLE;");
  }

  return stmts.join("\n\n");
}

export function openResourceGovernorProperties(
  run: QueryRunner,
  onApplied: () => void
): void {
  const panel = vscode.window.createWebviewPanel(
    "ssms.rgProperties",
    "Resource Governor Properties",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml();

  let original: RGModel | undefined;

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; execute?: boolean; model?: RGModel }) => {
      try {
        if (msg.type === "ready") {
          original = await loadModel(run);
          const candidates = await run(RG.CLASSIFIER_CANDIDATES);
          const classifierOptions = candidates.rows.map((r) => r[0]?.displayValue ?? "");
          panel.webview.postMessage({ type: "init", model: original, classifierOptions });
        } else if (msg.type === "cancel") {
          panel.dispose();
        } else if (msg.type === "apply" && msg.model && original) {
          const batch = buildBatch(original, msg.model);
          if (!batch.trim()) {
            vscode.window.showInformationMessage("Resource Governor: no changes to apply.");
            return;
          }
          if (msg.execute) {
            await run(batch);
            vscode.window.showInformationMessage("Resource Governor changes applied.");
            onApplied();
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

function renderHtml(): string {
  const nc = nonce();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nc}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 14px 60px; font-size: 13px; }
  h3 { font-weight: 600; margin: 16px 0 6px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  label { color: var(--vscode-descriptionForeground); }
  select, input { font-family: inherit; font-size: 13px; padding: 2px 5px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  input[type=number] { width: 80px; text-align: right; }
  input.name { width: 140px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 4px; }
  th, td { padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
  th { color: var(--vscode-descriptionForeground); font-weight: 500; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; cursor: pointer; padding: 3px 10px; border-radius: 2px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .add { margin: 4px 0 12px; }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 14px;
    background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-panel-border);
    display: flex; gap: 8px; justify-content: flex-end; }
  .error { color: var(--vscode-errorForeground); }
  .sys td input, .sys td select { opacity: 0.7; }
</style>
</head>
<body>
  <div class="row">
    <label for="classifier">Classifier function name</label>
    <select id="classifier"><option value="">None</option></select>
  </div>
  <div class="row">
    <input type="checkbox" id="enabled"><label for="enabled">Enable Resource Governor</label>
  </div>

  <h3>Resource pools</h3>
  <table id="poolsTbl"><thead><tr>
    <th>Name</th><th>Min CPU %</th><th>Max CPU %</th><th>Cap CPU %</th>
    <th>Min Mem %</th><th>Max Mem %</th><th>Min IOPS</th><th>Max IOPS</th>
  </tr></thead><tbody></tbody></table>
  <div class="add"><button id="addPool" class="secondary" disabled>Add pool</button></div>

  <h3>Workload groups</h3>
  <table id="groupsTbl"><thead><tr>
    <th>Name</th><th>Pool</th><th>Importance</th><th>Max Mem Grant %</th>
    <th>CPU Time (sec)</th><th>Mem Grant Timeout</th><th>Max DOP</th><th>Max Requests</th>
  </tr></thead><tbody></tbody></table>
  <div class="add"><button id="addGroup" class="secondary" disabled>Add group</button></div>

  <h3>External resource pools</h3>
  <table id="extTbl"><thead><tr>
    <th>Name</th><th>Max CPU %</th><th>Max Mem %</th><th>Max Processes</th>
  </tr></thead><tbody></tbody></table>
  <div class="add"><button id="addExt" class="secondary" disabled>Add external pool</button></div>

  <div id="msg"></div>
  <div class="footer">
    <button id="ok">OK</button>
    <button id="script" class="secondary">Script</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>

<script nonce="${nc}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let poolNames = [], classifierOptions = [];

  function inp(value, cls) {
    const i = document.createElement("input");
    i.type = "number"; i.value = value; if (cls) i.className = cls;
    return i;
  }
  function nameInp(value, readonly) {
    const i = document.createElement("input");
    i.className = "name"; i.value = value; i.disabled = readonly;
    return i;
  }
  function importanceSel(value) {
    const s = document.createElement("select");
    for (const v of ["LOW","MEDIUM","HIGH"]) {
      const o = document.createElement("option"); o.value = v; o.textContent = v;
      if (v === String(value).toUpperCase()) o.selected = true; s.appendChild(o);
    }
    return s;
  }
  function poolSel(value) {
    const s = document.createElement("select");
    for (const v of poolNames) {
      const o = document.createElement("option"); o.value = v; o.textContent = v;
      if (v === value) o.selected = true; s.appendChild(o);
    }
    return s;
  }
  function td(child) { const c = document.createElement("td"); c.appendChild(child); return c; }

  function poolRow(p) {
    const sys = p.name === "default" || p.name === "internal";
    const ro = p.name === "internal";
    const tr = document.createElement("tr"); if (sys) tr.className = "sys";
    tr.appendChild(td(nameInp(p.name, sys)));
    for (const k of ["minCpu","maxCpu","capCpu","minMem","maxMem","minIops","maxIops"]) {
      const i = inp(p[k]); i.disabled = ro; tr.appendChild(td(i));
    }
    return tr;
  }
  function groupRow(g) {
    const ro = g.name === "internal";
    const tr = document.createElement("tr"); if (g.name === "default" || ro) tr.className = "sys";
    tr.appendChild(td(nameInp(g.name, g.name === "default" || ro)));
    const ps = poolSel(g.pool); ps.disabled = ro; tr.appendChild(td(ps));
    const imp = importanceSel(g.importance); imp.disabled = ro; tr.appendChild(td(imp));
    for (const k of ["maxMemGrantPct","maxCpuSec","memGrantTimeoutSec","maxDop","maxRequests"]) {
      const i = inp(g[k]); i.disabled = ro; tr.appendChild(td(i));
    }
    return tr;
  }
  function extRow(e) {
    const tr = document.createElement("tr"); if (e.name === "default") tr.className = "sys";
    tr.appendChild(td(nameInp(e.name, false)));
    for (const k of ["maxCpu","maxMem","maxProcesses"]) tr.appendChild(td(inp(e[k])));
    return tr;
  }

  function readPools() {
    return [...$("poolsTbl").querySelectorAll("tbody tr")].map(tr => {
      const c = tr.querySelectorAll("input");
      return { name:c[0].value.trim(), minCpu:+c[1].value, maxCpu:+c[2].value, capCpu:+c[3].value,
               minMem:+c[4].value, maxMem:+c[5].value, minIops:+c[6].value, maxIops:+c[7].value };
    }).filter(p => p.name);
  }
  function readGroups() {
    return [...$("groupsTbl").querySelectorAll("tbody tr")].map(tr => {
      const sel = tr.querySelectorAll("select"), inN = tr.querySelectorAll("input");
      return { name:inN[0].value.trim(), pool:sel[0].value, importance:sel[1].value,
               maxMemGrantPct:+inN[1].value, maxCpuSec:+inN[2].value, memGrantTimeoutSec:+inN[3].value,
               maxDop:+inN[4].value, maxRequests:+inN[5].value };
    }).filter(g => g.name);
  }
  function readExternal() {
    return [...$("extTbl").querySelectorAll("tbody tr")].map(tr => {
      const c = tr.querySelectorAll("input");
      return { name:c[0].value.trim(), maxCpu:+c[1].value, maxMem:+c[2].value, maxProcesses:+c[3].value };
    }).filter(e => e.name);
  }
  function model() {
    return { enabled: $("enabled").checked, classifier: $("classifier").value,
             pools: readPools(), groups: readGroups(), external: readExternal() };
  }

  function setAddEnabled() {
    const on = $("enabled").checked;
    $("addPool").disabled = !on; $("addGroup").disabled = !on; $("addExt").disabled = !on;
  }

  $("enabled").addEventListener("change", setAddEnabled);
  $("addPool").addEventListener("click", () =>
    $("poolsTbl").querySelector("tbody").appendChild(poolRow(
      { name:"", minCpu:0, maxCpu:100, capCpu:100, minMem:0, maxMem:100, minIops:0, maxIops:0 })));
  $("addGroup").addEventListener("click", () =>
    $("groupsTbl").querySelector("tbody").appendChild(groupRow(
      { name:"", pool: poolNames[0] || "default", importance:"MEDIUM",
        maxMemGrantPct:25, maxCpuSec:0, memGrantTimeoutSec:0, maxDop:0, maxRequests:0 })));
  $("addExt").addEventListener("click", () =>
    $("extTbl").querySelector("tbody").appendChild(extRow(
      { name:"", maxCpu:100, maxMem:100, maxProcesses:0 })));

  $("ok").addEventListener("click", () => vscode.postMessage({ type:"apply", execute:true, model: model() }));
  $("script").addEventListener("click", () => vscode.postMessage({ type:"apply", execute:false, model: model() }));
  $("cancel").addEventListener("click", () => vscode.postMessage({ type:"cancel" }));

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "init") {
      const md = m.model;
      poolNames = md.pools.map(p => p.name);
      classifierOptions = m.classifierOptions || [];
      const cs = $("classifier");
      for (const f of classifierOptions) { const o=document.createElement("option"); o.value=f; o.textContent=f; cs.appendChild(o); }
      cs.value = md.classifier || "";
      $("enabled").checked = md.enabled;
      md.pools.forEach(p => $("poolsTbl").querySelector("tbody").appendChild(poolRow(p)));
      md.groups.forEach(g => $("groupsTbl").querySelector("tbody").appendChild(groupRow(g)));
      md.external.forEach(x => $("extTbl").querySelector("tbody").appendChild(extRow(x)));
      setAddEnabled();
    } else if (m.type === "error") {
      $("msg").innerHTML = '<p class="error">' + String(m.message).replace(/</g,"&lt;") + "</p>";
    }
  });

  vscode.postMessage({ type:"ready" });
</script>
</body>
</html>`;
}
