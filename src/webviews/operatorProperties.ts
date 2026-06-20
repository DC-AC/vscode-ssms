import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";
import * as Agent from "../queries/agent";
import {
  OperatorModel,
  OperatorNotification,
  buildOperatorBatch,
} from "../scripting/operator";
import type { QueryRunner } from "./backupHistory";

const str = (r: SimpleExecuteResult, row: number, col: string): string => {
  const i = r.columnInfo.findIndex((c) => c.columnName === col);
  const v = i >= 0 ? r.rows[row]?.[i] : undefined;
  return v && !v.isNull ? v.displayValue : "";
};
const int = (r: SimpleExecuteResult, row: number, col: string): number =>
  Number(str(r, row, col) || 0);

async function loadModel(
  run: QueryRunner,
  name: string | undefined
): Promise<OperatorModel> {
  if (!name) {
    const alerts = await run(Agent.ALL_ALERTS_FOR_NOTIFY);
    return {
      name: "",
      enabled: true,
      email: "",
      pager: "",
      pagerDays: 0,
      weekdayStart: 80000,
      weekdayEnd: 180000,
      saturdayStart: 80000,
      saturdayEnd: 180000,
      sundayStart: 80000,
      sundayEnd: 180000,
      notifications: alerts.rows.map((_, i) => ({
        alertName: str(alerts, i, "alert_name"),
        email: false,
        pager: false,
      })),
    };
  }
  const d = await run(Agent.operatorDetailFull(name));
  const n = await run(Agent.operatorNotifications(name));
  const notifications: OperatorNotification[] = n.rows.map((_, i) => {
    const method = int(n, i, "method");
    return {
      alertName: str(n, i, "alert_name"),
      email: (method & 1) !== 0,
      pager: (method & 2) !== 0,
    };
  });
  return {
    name: str(d, 0, "name"),
    enabled: int(d, 0, "enabled") === 1,
    email: str(d, 0, "email_address"),
    pager: str(d, 0, "pager_address"),
    pagerDays: int(d, 0, "pager_days"),
    weekdayStart: int(d, 0, "weekday_pager_start_time"),
    weekdayEnd: int(d, 0, "weekday_pager_end_time"),
    saturdayStart: int(d, 0, "saturday_pager_start_time"),
    saturdayEnd: int(d, 0, "saturday_pager_end_time"),
    sundayStart: int(d, 0, "sunday_pager_start_time"),
    sundayEnd: int(d, 0, "sunday_pager_end_time"),
    notifications,
  };
}

export function openOperatorProperties(
  run: QueryRunner,
  name: string | undefined,
  onApplied: () => void
): void {
  const isNew = !name;
  const panel = vscode.window.createWebviewPanel(
    "ssms.operatorProperties",
    isNew ? "New Operator" : "Operator Properties",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml();

  let original: OperatorModel | undefined;

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; execute?: boolean; model?: OperatorModel }) => {
      try {
        if (msg.type === "ready") {
          original = await loadModel(run, name);
          panel.webview.postMessage({ type: "init", model: original });
        } else if (msg.type === "cancel") {
          panel.dispose();
        } else if (msg.type === "apply" && msg.model) {
          if (!msg.model.name.trim()) {
            panel.webview.postMessage({ type: "error", message: "Enter an operator name." });
            return;
          }
          const batch = buildOperatorBatch(original, msg.model, isNew);
          if (!batch.trim()) {
            vscode.window.showInformationMessage("Operator: no changes to apply.");
            return;
          }
          if (msg.execute) {
            await run(batch);
            vscode.window.showInformationMessage("Operator changes applied.");
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
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 14px 64px; font-size: 13px; }
  h3 { font-weight: 600; margin: 16px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  label { color: var(--vscode-descriptionForeground); }
  label.inline { min-width: 120px; }
  input, select { font-family: inherit; font-size: 13px; padding: 2px 5px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  input[type=text] { width: 280px; }
  input[type=time] { width: 110px; }
  .days label { color: var(--vscode-foreground); margin-right: 10px; }
  table { border-collapse: collapse; width: 100%; max-width: 560px; }
  th, td { text-align: left; padding: 3px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  th.c, td.c { text-align: center; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; cursor: pointer; padding: 3px 10px; border-radius: 2px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 14px;
    background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-panel-border);
    display: flex; gap: 8px; justify-content: flex-end; }
  .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <h3>General</h3>
  <div class="row"><label class="inline" for="name">Name</label><input type="text" id="name"><input type="checkbox" id="enabled"><label for="enabled">Enabled</label></div>
  <div class="row"><label class="inline" for="email">E-mail name</label><input type="text" id="email"></div>
  <div class="row"><label class="inline" for="pager">Pager e-mail name</label><input type="text" id="pager"></div>

  <h3>Pager on duty schedule</h3>
  <div class="row days" id="days"></div>
  <div class="row"><label class="inline">Weekday</label><input type="time" id="wdStart"><label>to</label><input type="time" id="wdEnd"></div>
  <div class="row"><label class="inline">Saturday</label><input type="time" id="satStart"><label>to</label><input type="time" id="satEnd"></div>
  <div class="row"><label class="inline">Sunday</label><input type="time" id="sunStart"><label>to</label><input type="time" id="sunEnd"></div>

  <h3>Notifications</h3>
  <table><thead><tr><th>Alert name</th><th class="c">E-mail</th><th class="c">Pager</th></tr></thead><tbody id="notify"></tbody></table>

  <div id="msg"></div>
  <div class="footer">
    <button id="ok">OK</button>
    <button id="script" class="secondary">Script</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>

<script nonce="${nc}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const DOW = [[1,"Sun"],[2,"Mon"],[4,"Tue"],[8,"Wed"],[16,"Thu"],[32,"Fri"],[64,"Sat"]];
  const intToTime = (n) => { n=n||0; const h=Math.floor(n/10000), m=Math.floor((n%10000)/100); return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0"); };
  const timeToInt = (t) => { if(!t) return 0; const [h,m]=t.split(":").map(Number); return h*10000+m*100; };
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  let dayBoxes = [];
  function buildDays(mask) {
    $("days").innerHTML = "";
    dayBoxes = DOW.map(([v,t]) => {
      const c = document.createElement("input"); c.type="checkbox"; c.value=String(v); c.checked=(mask&v)!==0;
      const l = document.createElement("label"); l.appendChild(c); l.appendChild(document.createTextNode(" "+t));
      $("days").appendChild(l); return c;
    });
  }

  function buildNotify(list) {
    $("notify").innerHTML = list.map((n,i) =>
      "<tr><td>"+esc(n.alertName)+"</td>"+
      '<td class="c"><input type="checkbox" data-i="'+i+'" data-k="email"'+(n.email?" checked":"")+"></td>"+
      '<td class="c"><input type="checkbox" data-i="'+i+'" data-k="pager"'+(n.pager?" checked":"")+"></td></tr>").join("");
    notifyData = list.map(n => ({ alertName:n.alertName, email:n.email, pager:n.pager }));
  }
  let notifyData = [];
  function readNotify() {
    for (const cb of $("notify").querySelectorAll("input")) notifyData[+cb.dataset.i][cb.dataset.k] = cb.checked;
    return notifyData;
  }

  function model() {
    return {
      name: $("name").value.trim(), enabled: $("enabled").checked,
      email: $("email").value.trim(), pager: $("pager").value.trim(),
      pagerDays: dayBoxes.reduce((a,c)=>a+(c.checked?+c.value:0),0),
      weekdayStart: timeToInt($("wdStart").value), weekdayEnd: timeToInt($("wdEnd").value),
      saturdayStart: timeToInt($("satStart").value), saturdayEnd: timeToInt($("satEnd").value),
      sundayStart: timeToInt($("sunStart").value), sundayEnd: timeToInt($("sunEnd").value),
      notifications: readNotify()
    };
  }

  $("ok").addEventListener("click", () => vscode.postMessage({ type:"apply", execute:true, model: model() }));
  $("script").addEventListener("click", () => vscode.postMessage({ type:"apply", execute:false, model: model() }));
  $("cancel").addEventListener("click", () => vscode.postMessage({ type:"cancel" }));

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "init") {
      const o = m.model;
      $("name").value=o.name; $("enabled").checked=o.enabled; $("email").value=o.email; $("pager").value=o.pager;
      buildDays(o.pagerDays);
      $("wdStart").value=intToTime(o.weekdayStart); $("wdEnd").value=intToTime(o.weekdayEnd);
      $("satStart").value=intToTime(o.saturdayStart); $("satEnd").value=intToTime(o.saturdayEnd);
      $("sunStart").value=intToTime(o.sundayStart); $("sunEnd").value=intToTime(o.sundayEnd);
      buildNotify(o.notifications);
    } else if (m.type === "error") {
      $("msg").innerHTML = '<p class="error">' + esc(m.message) + "</p>";
    }
  });
  vscode.postMessage({ type:"ready" });
</script>
</body>
</html>`;
}
