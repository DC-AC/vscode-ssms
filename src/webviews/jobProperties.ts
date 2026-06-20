import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";
import * as Agent from "../queries/agent";
import {
  JobModel,
  JobStep,
  JobSchedule,
  buildJobBatch,
  buildNewJobBatch,
} from "../scripting/agentJob";
import type { QueryRunner } from "./backupHistory";

const str = (r: SimpleExecuteResult, row: number, col: string): string => {
  const i = r.columnInfo.findIndex((c) => c.columnName === col);
  const v = i >= 0 ? r.rows[row]?.[i] : undefined;
  return v && !v.isNull ? v.displayValue : "";
};
const int = (r: SimpleExecuteResult, row: number, col: string): number =>
  Number(str(r, row, col) || 0);

async function loadModel(run: QueryRunner, jobId: string): Promise<JobModel> {
  const d = await run(Agent.jobDetail(jobId));
  const stepsRes = await run(Agent.jobStepsDetail(jobId));
  const schedRes = await run(Agent.jobSchedulesDetail(jobId));

  const steps: JobStep[] = stepsRes.rows.map((_, i) => ({
    stepId: int(stepsRes, i, "step_id"),
    name: str(stepsRes, i, "step_name"),
    subsystem: str(stepsRes, i, "subsystem"),
    database: str(stepsRes, i, "database_name"),
    command: str(stepsRes, i, "command"),
    onSuccess: int(stepsRes, i, "on_success_action"),
    onFail: int(stepsRes, i, "on_fail_action"),
    retryAttempts: int(stepsRes, i, "retry_attempts"),
    retryInterval: int(stepsRes, i, "retry_interval"),
  }));

  const schedules: JobSchedule[] = schedRes.rows.map((_, i) => ({
    scheduleId: int(schedRes, i, "schedule_id"),
    name: str(schedRes, i, "name"),
    enabled: int(schedRes, i, "enabled") === 1,
    freqType: int(schedRes, i, "freq_type"),
    freqInterval: int(schedRes, i, "freq_interval"),
    freqRecurrenceFactor: int(schedRes, i, "freq_recurrence_factor"),
    freqRelativeInterval: int(schedRes, i, "freq_relative_interval"),
    freqSubdayType: int(schedRes, i, "freq_subday_type"),
    freqSubdayInterval: int(schedRes, i, "freq_subday_interval"),
    activeStartTime: int(schedRes, i, "active_start_time"),
    activeEndTime: int(schedRes, i, "active_end_time"),
    activeStartDate: int(schedRes, i, "active_start_date"),
    activeEndDate: int(schedRes, i, "active_end_date"),
  }));

  return {
    jobId,
    general: {
      name: str(d, 0, "name"),
      enabled: int(d, 0, "enabled") === 1,
      owner: str(d, 0, "owner"),
      category: str(d, 0, "category"),
      description: str(d, 0, "description"),
    },
    steps,
    schedules,
  };
}

/** Open the editor. Omit jobId (or pass undefined) for "New Job" mode. */
export function openJobProperties(
  run: QueryRunner,
  jobId: string | undefined,
  onApplied: () => void
): void {
  const isNew = !jobId;
  const panel = vscode.window.createWebviewPanel(
    "ssms.jobProperties",
    isNew ? "New Job" : "Job Properties",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml();

  let original: JobModel | undefined;

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; execute?: boolean; model?: JobModel }) => {
      try {
        if (msg.type === "ready") {
          original = isNew
            ? {
                jobId: "",
                general: { name: "", enabled: true, owner: "", category: "", description: "" },
                steps: [],
                schedules: [],
              }
            : await loadModel(run, jobId as string);
          const cats = await run(Agent.JOB_CATEGORIES);
          const dbs = await run(Agent.DATABASE_NAMES);
          panel.webview.postMessage({
            type: "init",
            model: original,
            categories: cats.rows.map((r) => r[0]?.displayValue ?? ""),
            databases: dbs.rows.map((r) => r[0]?.displayValue ?? ""),
          });
        } else if (msg.type === "cancel") {
          panel.dispose();
        } else if (msg.type === "apply" && msg.model && original) {
          if (isNew && !msg.model.general.name.trim()) {
            panel.webview.postMessage({ type: "error", message: "Enter a job name." });
            return;
          }
          const batch = isNew
            ? buildNewJobBatch(msg.model)
            : buildJobBatch(original, { ...msg.model, jobId: jobId as string });
          if (!batch.trim()) {
            vscode.window.showInformationMessage("Job: no changes to apply.");
            return;
          }
          if (msg.execute) {
            await run(batch);
            vscode.window.showInformationMessage("Job changes applied.");
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
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 14px 64px; font-size: 13px; }
  h3 { font-weight: 600; margin: 18px 0 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  label { color: var(--vscode-descriptionForeground); }
  label.inline { min-width: 90px; }
  select, input, textarea { font-family: inherit; font-size: 13px; padding: 2px 5px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  input[type=number] { width: 70px; }
  input.name { width: 220px; }
  textarea { width: 100%; min-height: 60px; font-family: var(--vscode-editor-font-family, monospace); }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px; margin: 8px 0;
    background: var(--vscode-editorWidget-background); }
  .card .hd { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .spacer { flex: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; cursor: pointer; padding: 3px 10px; border-radius: 2px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.icon { padding: 2px 7px; }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 14px;
    background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-panel-border);
    display: flex; gap: 8px; justify-content: flex-end; }
  .error { color: var(--vscode-errorForeground); }
  .days label { margin-right: 8px; color: var(--vscode-foreground); }
  .hidden { display: none; }
</style>
</head>
<body>
  <h3>General</h3>
  <div class="row"><label class="inline" for="jname">Name</label><input class="name" id="jname"></div>
  <div class="row"><input type="checkbox" id="jenabled"><label for="jenabled">Enabled</label></div>
  <div class="row"><label class="inline" for="jowner">Owner</label><input id="jowner"></div>
  <div class="row"><label class="inline" for="jcategory">Category</label><select id="jcategory"></select></div>
  <div class="row"><label class="inline" for="jdesc">Description</label></div>
  <div class="row"><textarea id="jdesc"></textarea></div>

  <h3>Steps</h3>
  <div id="steps"></div>
  <div class="row"><button id="addStep" class="secondary">Add step</button></div>

  <h3>Schedules</h3>
  <div id="schedules"></div>
  <div class="row"><button id="addSchedule" class="secondary">Add schedule</button></div>

  <div id="msg"></div>
  <div class="footer">
    <button id="ok">OK</button>
    <button id="script" class="secondary">Script</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>

<script nonce="${nc}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let categories = [], databases = [];

  const SUBSYSTEMS = ["TSQL","CmdExec","PowerShell","SSIS","ANALYSISQUERY","ANALYSISCOMMAND","Snapshot","LogReader","Distribution","Merge","QueueReader"];
  const ACTIONS = [[1,"Quit reporting success"],[2,"Quit reporting failure"],[3,"Go to next step"]];
  const FREQ = [[1,"One time"],[4,"Daily"],[8,"Weekly"],[16,"Monthly"],[32,"Monthly relative"],[64,"When SQL Agent starts"],[128,"When CPU idle"]];
  const RELATIVE = [[1,"First"],[2,"Second"],[4,"Third"],[8,"Fourth"],[16,"Last"]];
  const RELDAY = [[1,"Sunday"],[2,"Monday"],[3,"Tuesday"],[4,"Wednesday"],[5,"Thursday"],[6,"Friday"],[7,"Saturday"],[8,"Day"],[9,"Weekday"],[10,"Weekend day"]];
  const DOW = [[1,"Sun"],[2,"Mon"],[4,"Tue"],[8,"Wed"],[16,"Thu"],[32,"Fri"],[64,"Sat"]];
  const SUBDAY = [[1,"Occurs once at"],[8,"Occurs every (hours)"],[4,"Occurs every (minutes)"]];

  function el(tag, props, kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    (kids||[]).forEach(k => e.appendChild(typeof k === "string" ? document.createTextNode(k) : k));
    return e;
  }
  function sel(options, value) {
    const s = el("select");
    for (const [v,t] of options) { const o = el("option",{value:String(v),textContent:t}); if (String(v)===String(value)) o.selected=true; s.appendChild(o); }
    return s;
  }
  function strSel(list, value) {
    const s = el("select");
    for (const v of list) { const o = el("option",{value:v,textContent:v}); if (v===value) o.selected=true; s.appendChild(o); }
    return s;
  }
  // int <-> UI converters
  const intToTime = (n) => { n = n||0; const h=Math.floor(n/10000), m=Math.floor((n%10000)/100); return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0"); };
  const timeToInt = (t) => { if(!t) return 0; const [h,m]=t.split(":").map(Number); return h*10000+m*100; };
  const intToDate = (n) => { if(!n||n>99990000) return ""; const s=String(n); return s.slice(0,4)+"-"+s.slice(4,6)+"-"+s.slice(6,8); };
  const dateToInt = (d) => d ? Number(d.replace(/-/g,"")) : 0;

  /* ---------- Steps ---------- */
  function stepCard(st) {
    const card = el("div",{className:"card"});
    const name = el("input",{className:"name",value:st.name});
    const type = strSel(SUBSYSTEMS, st.subsystem);
    const db = strSel(databases.length?databases:["master"], st.database||"master");
    const onS = sel(ACTIONS, st.onSuccess||1);
    const onF = sel(ACTIONS, st.onFail||2);
    const retry = el("input",{type:"number",value:st.retryAttempts||0});
    const interval = el("input",{type:"number",value:st.retryInterval||0});
    const cmd = el("textarea",{value:st.command||""});
    const up = el("button",{className:"icon secondary",textContent:"↑",onclick:()=>{ const p=card.previousElementSibling; if(p) card.parentNode.insertBefore(card,p); }});
    const down = el("button",{className:"icon secondary",textContent:"↓",onclick:()=>{ const nx=card.nextElementSibling; if(nx) card.parentNode.insertBefore(nx,card); }});
    const del = el("button",{className:"icon secondary",textContent:"Delete",onclick:()=>card.remove()});
    card.append(
      el("div",{className:"hd"},[el("label",{className:"inline",textContent:"Step name"}), name, el("span",{className:"spacer"}), up, down, del]),
      el("div",{className:"row"},[el("label",{className:"inline",textContent:"Type"}), type, el("label",{className:"inline",textContent:"Database"}), db]),
      el("div",{className:"row"},[el("label",{className:"inline",textContent:"On success"}), onS, el("label",{className:"inline",textContent:"On failure"}), onF]),
      el("div",{className:"row"},[el("label",{className:"inline",textContent:"Retry attempts"}), retry, el("label",{className:"inline",textContent:"Retry interval (min)"}), interval]),
      el("div",{className:"row"},[el("label",{textContent:"Command"})]),
      el("div",{className:"row"},[cmd])
    );
    card._read = () => ({ stepId: st.stepId||0, name:name.value.trim(), subsystem:type.value, database:db.value,
      command:cmd.value, onSuccess:+onS.value, onFail:+onF.value, retryAttempts:+retry.value||0, retryInterval:+interval.value||0 });
    return card;
  }

  /* ---------- Schedules ---------- */
  function scheduleCard(sc) {
    const card = el("div",{className:"card"});
    const name = el("input",{className:"name",value:sc.name});
    const enabled = el("input",{type:"checkbox"}); enabled.checked = sc.enabled !== false;
    const del = el("button",{className:"icon secondary",textContent:"Delete",onclick:()=>card.remove()});
    const freq = sel(FREQ, sc.freqType||4);

    const everyN = el("input",{type:"number",value:sc.freqRecurrenceFactor||1});
    const dailyN = el("input",{type:"number",value:(sc.freqType===4?sc.freqInterval:1)||1});
    const monthDay = el("input",{type:"number",value:(sc.freqType===16?sc.freqInterval:1)||1});
    const relInt = sel(RELATIVE, sc.freqRelativeInterval||1);
    const relDay = sel(RELDAY, (sc.freqType===32?sc.freqInterval:1)||1);
    const dayBoxes = DOW.map(([v]) => { const c=el("input",{type:"checkbox"}); c.value=String(v); c.checked=(sc.freqType===8)&&((sc.freqInterval&v)!==0); return c; });

    const subType = sel(SUBDAY, sc.freqSubdayType||1);
    const subInt = el("input",{type:"number",value:sc.freqSubdayInterval||1});
    const startTime = el("input",{type:"time",value:intToTime(sc.activeStartTime||0)});
    const endTime = el("input",{type:"time",value:intToTime(sc.activeEndTime||235959)});
    const startDate = el("input",{type:"date",value:intToDate(sc.activeStartDate||0)});
    const endDate = el("input",{type:"date",value:intToDate(sc.activeEndDate||0)});

    const rDaily = el("div",{className:"row"},[el("label",{className:"inline",textContent:"Every"}), dailyN, el("label",{textContent:"day(s)"})]);
    const rWeekly = el("div",{className:"row days"},[el("label",{className:"inline",textContent:"Every"}), everyN, el("label",{textContent:"week(s) on:"}),
      ...DOW.flatMap(([v,t],i)=>[dayBoxes[i], el("label",{textContent:t})])]);
    const rMonthly = el("div",{className:"row"},[el("label",{className:"inline",textContent:"Day"}), monthDay, el("label",{textContent:"of every"}), everyN.cloneNode(), el("label",{textContent:"month(s)"})]);
    const rRelative = el("div",{className:"row"},[el("label",{className:"inline",textContent:"The"}), relInt, relDay, el("label",{textContent:"of every"}), el("input",{type:"number",value:sc.freqRecurrenceFactor||1,id:"relEvery"}), el("label",{textContent:"month(s)"})]);
    const rSubday = el("div",{className:"row"},[el("label",{className:"inline",textContent:"Daily frequency"}), subType, subInt, el("label",{textContent:"between"}), startTime, el("label",{textContent:"and"}), endTime]);
    const rDuration = el("div",{className:"row"},[el("label",{className:"inline",textContent:"Start date"}), startDate, el("label",{textContent:"End date"}), endDate]);

    function refresh() {
      const f = +freq.value;
      rDaily.classList.toggle("hidden", f!==4);
      rWeekly.classList.toggle("hidden", f!==8);
      rMonthly.classList.toggle("hidden", f!==16);
      rRelative.classList.toggle("hidden", f!==32);
      // sub-day only meaningful for recurring frequencies
      rSubday.classList.toggle("hidden", f===1 || f===64 || f===128);
      const once = +subType.value === 1;
      subInt.classList.toggle("hidden", once);
      endTime.previousSibling; // keep
      endTime.classList.toggle("hidden", once);
    }
    freq.addEventListener("change", refresh);
    subType.addEventListener("change", refresh);

    card.append(
      el("div",{className:"hd"},[el("label",{className:"inline",textContent:"Schedule"}), name, enabled, el("label",{textContent:"Enabled"}), el("span",{className:"spacer"}), del]),
      el("div",{className:"row"},[el("label",{className:"inline",textContent:"Frequency"}), freq]),
      rDaily, rWeekly, rMonthly, rRelative, rSubday, rDuration
    );
    refresh();

    card._read = () => {
      const f = +freq.value;
      let interval = 0, relInterval = 0, factor = 0;
      if (f===4) interval = +dailyN.value||1;
      else if (f===8) { interval = dayBoxes.reduce((a,c)=>a+(c.checked?+c.value:0),0); factor = +everyN.value||1; }
      else if (f===16) { interval = +monthDay.value||1; factor = +rMonthly.querySelectorAll("input")[1].value||1; }
      else if (f===32) { interval = +relDay.value; relInterval = +relInt.value; factor = +rRelative.querySelector("#relEvery").value||1; }
      const once = +subType.value === 1;
      return {
        scheduleId: sc.scheduleId||0, name:name.value.trim(), enabled:enabled.checked,
        freqType:f, freqInterval:interval, freqRecurrenceFactor:factor, freqRelativeInterval:relInterval,
        freqSubdayType: once?1:+subType.value, freqSubdayInterval: once?0:(+subInt.value||1),
        activeStartTime: timeToInt(startTime.value), activeEndTime: once?235959:timeToInt(endTime.value),
        activeStartDate: dateToInt(startDate.value)||0, activeEndDate: dateToInt(endDate.value)||0
      };
    };
    return card;
  }

  function model() {
    return {
      general: { name:$("jname").value.trim(), enabled:$("jenabled").checked, owner:$("jowner").value.trim(),
                 category:$("jcategory").value, description:$("jdesc").value },
      steps: [...$("steps").children].map(c => c._read()).filter(s => s.name),
      schedules: [...$("schedules").children].map(c => c._read()).filter(s => s.name)
    };
  }

  $("addStep").addEventListener("click", () => $("steps").appendChild(stepCard(
    { stepId:0, name:"", subsystem:"TSQL", database:"master", command:"", onSuccess:3, onFail:2, retryAttempts:0, retryInterval:0 })));
  $("addSchedule").addEventListener("click", () => $("schedules").appendChild(scheduleCard(
    { scheduleId:0, name:"", enabled:true, freqType:4, freqInterval:1, freqRecurrenceFactor:1, freqRelativeInterval:0,
      freqSubdayType:1, freqSubdayInterval:0, activeStartTime:0, activeEndTime:235959, activeStartDate:0, activeEndDate:0 })));
  $("ok").addEventListener("click", () => vscode.postMessage({ type:"apply", execute:true, model: model() }));
  $("script").addEventListener("click", () => vscode.postMessage({ type:"apply", execute:false, model: model() }));
  $("cancel").addEventListener("click", () => vscode.postMessage({ type:"cancel" }));

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "init") {
      categories = m.categories || []; databases = m.databases || [];
      const cat = $("jcategory");
      for (const c of categories) cat.appendChild(el("option",{value:c,textContent:c}));
      const g = m.model.general;
      $("jname").value = g.name; $("jenabled").checked = g.enabled; $("jowner").value = g.owner;
      cat.value = g.category; $("jdesc").value = g.description;
      m.model.steps.forEach(s => $("steps").appendChild(stepCard(s)));
      m.model.schedules.forEach(s => $("schedules").appendChild(scheduleCard(s)));
    } else if (m.type === "error") {
      $("msg").innerHTML = '<p class="error">' + String(m.message).replace(/</g,"&lt;") + "</p>";
    }
  });

  vscode.postMessage({ type:"ready" });
</script>
</body>
</html>`;
}
