import * as vscode from "vscode";
import type { SimpleExecuteResult } from "vscode-mssql";
import * as QS from "../queries/queryStore";
import { qsStyles, openPlanXml, openQueryStoreTopConsumers } from "./queryStore";
import type { QueryRunner } from "./backupHistory";

interface GridData {
  columns: string[];
  rows: (string | null)[][];
}
function serialize(result: SimpleExecuteResult): GridData {
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
function csp(n: string): string {
  return ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${n}'`].join("; ");
}
async function guard(run: QueryRunner, post: (m: unknown) => void): Promise<boolean> {
  const status = await run(QS.QS_STATUS);
  const state = status.rows[0]?.[0]?.displayValue ?? "OFF";
  if (state !== "READ_WRITE" && state !== "READ_ONLY") {
    post({ type: "disabled", state });
    return false;
  }
  return true;
}

interface WaitDefaults {
  agg?: string;
  hours?: number;
  start?: string;
  end?: string;
  tz?: string;
  topCats?: number;
  topQueries?: number;
  interval?: number;
}

async function sendWaitDrill(
  run: QueryRunner,
  post: (m: unknown) => void,
  queryId: number,
  category: string,
  agg: string,
  win: QS.TimeWindow,
  interval: number
): Promise<void> {
  const text = await run(QS.queryTextQuery(queryId));
  const summary = await run(QS.waitPlanSummaryQuery(queryId, category, agg, win, interval));
  const plans = await run(QS.queryPlansQuery(queryId, win));
  post({
    type: "drill",
    queryId,
    metricName: `${QS.aggLabel(agg)} wait time (ms)`,
    text: text.rows[0]?.[0]?.displayValue ?? "",
    summary: serialize(summary),
    plans: serialize(plans),
  });
}

/* ---------- Query Wait Statistics ---------- */

export function openQueryStoreWaits(run: QueryRunner, state: vscode.Memento): void {
  const stateKey = "qs.defaults.waits";
  const defaults = state.get<WaitDefaults>(stateKey, {});
  const panel = vscode.window.createWebviewPanel(
    "ssms.qsWaits",
    "Query Store — Wait Statistics",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = waitsHtml(defaults);
  const post = (m: unknown): void => void panel.webview.postMessage(m);

  panel.webview.onDidReceiveMessage(
    async (msg: {
      type: string;
      agg?: string;
      hours?: number;
      start?: string;
      end?: string;
      tz?: string;
      topCats?: number;
      topQueries?: number;
      interval?: number;
      category?: string;
      queryId?: number;
      planId?: number;
    }) => {
      try {
        const hours = msg.hours ?? 24;
        const agg = msg.agg ?? "total";
        const topCats = msg.topCats ?? 10;
        const topQueries = msg.topQueries ?? 25;
        const interval = msg.interval ?? 60;
        const tz = msg.tz ?? "local";
        const cat = msg.category ?? "";
        const win: QS.TimeWindow = { hours, start: msg.start || undefined, end: msg.end || undefined };
        if (
          msg.agg != null || msg.hours != null || msg.topCats != null ||
          msg.topQueries != null || msg.interval != null || msg.tz != null
        ) {
          await state.update(stateKey, { agg, hours, start: win.start, end: win.end, tz, topCats, topQueries, interval });
        }
        if (msg.type === "ready" && !(await guard(run, post))) {
          return;
        }
        if (msg.type === "ready" || msg.type === "apply") {
          post({ type: "cats", ...serialize(await run(QS.waitsByCategoryQuery(agg, win, topCats))) });
        } else if (msg.type === "selectCategory" && cat) {
          post({
            type: "queries",
            category: cat,
            valueLabel: `${QS.aggLabel(agg)} wait time (ms)`,
            ...serialize(await run(QS.waitCategoryQueriesQuery(cat, agg, win, topQueries))),
          });
        } else if (msg.type === "drill" && msg.queryId != null && cat) {
          await sendWaitDrill(run, post, msg.queryId, cat, agg, win, interval);
        } else if (msg.type === "force" && msg.queryId != null && msg.planId != null && cat) {
          await run(QS.forcePlanStatement(msg.queryId, msg.planId));
          await sendWaitDrill(run, post, msg.queryId, cat, agg, win, interval);
        } else if (msg.type === "unforce" && msg.queryId != null && msg.planId != null && cat) {
          await run(QS.unforcePlanStatement(msg.queryId, msg.planId));
          await sendWaitDrill(run, post, msg.queryId, cat, agg, win, interval);
        } else if (msg.type === "openPlan" && msg.planId != null) {
          await openPlanXml(run, msg.planId);
        }
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}

function waitsHtml(defaults: WaitDefaults): string {
  const n = nonce();
  const sel = (a: string | number, b: string | number): string => (String(a) === String(b) ? " selected" : "");
  const aggOpts = QS.AGG_OPTIONS.map(
    (a) => `<option value="${a.key}"${sel(a.key, defaults.agg ?? "total")}>${a.label}</option>`
  ).join("");
  const windowVals: Array<[string, string]> = [
    ["0.0833333", "Last 5 minutes"], ["0.25", "Last 15 minutes"], ["0.5", "Last 30 minutes"],
    ["1", "Last hour"], ["12", "Last 12 hours"], ["24", "Last day"], ["48", "Last 2 days"],
    ["168", "Last week"], ["336", "Last 2 weeks"], ["720", "Last month"],
    ["2160", "Last 3 months"], ["4320", "Last 6 months"], ["8760", "Last year"],
  ];
  const windowDefault = defaults.hours != null ? String(defaults.hours) : "24";
  const isCustom = !!(defaults.start && defaults.end);
  const windowOpts =
    windowVals.map(([v, l]) => `<option value="${v}"${!isCustom ? sel(v, windowDefault) : ""}>${l}</option>`).join("") +
    `<option value="custom"${isCustom ? " selected" : ""}>Custom…</option>`;
  const intervalDefault = defaults.interval ?? 60;
  const intervalOpts = QS.INTERVAL_OPTIONS.map(
    (o) => `<option value="${o.key}"${sel(o.key, intervalDefault)}>${o.label}</option>`
  ).join("");
  const topCats = defaults.topCats != null ? defaults.topCats : 10;
  const topQueries = defaults.topQueries != null ? defaults.topQueries : 25;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(n)}">
<style>${qsStyles()}</style></head>
<body>
  <h2>Query Wait Statistics</h2>
  <div class="controls">
    <div class="field"><label for="agg">Based on</label><select id="agg">${aggOpts}</select></div>
    <div class="field"><label for="window">Time window</label><select id="window">${windowOpts}</select></div>
    <div class="field" id="fromField" style="display:none;"><label for="from">From</label><input type="datetime-local" id="from"></div>
    <div class="field" id="toField" style="display:none;"><label for="to">To</label><input type="datetime-local" id="to"></div>
    <div class="field"><label for="tz">Time format</label><select id="tz">
      <option value="local"${(defaults.tz ?? "local") === "local" ? " selected" : ""}>Local</option>
      <option value="utc"${defaults.tz === "utc" ? " selected" : ""}>UTC</option>
    </select></div>
    <div class="field"><label for="interval">Interval</label><select id="interval">${intervalOpts}</select></div>
    <div class="field"><label for="topCats">Top wait categories (0 = all)</label><input type="number" id="topCats" min="0" step="1" value="${topCats}"></div>
    <div class="field"><label for="topQueries">Top queries per category (0 = all)</label><input type="number" id="topQueries" min="0" step="1" value="${topQueries}"></div>
    <button id="apply">Refresh</button>
  </div>
  <div id="msg"></div>
  <h3>Wait categories<span class="note">Select a category to see its queries.</span></h3>
  <table><thead id="catHead"></thead><tbody id="catBody"></tbody></table>
  <div id="qpanes" class="panes" style="display:none; margin-top:12px;">
    <div class="pane"><h3 id="barTitle">Queries</h3><div id="barChart"></div></div>
    <div class="pane"><h3 id="bubbleTitle">Plan summary</h3>
      <div class="bubbleRow">
        <div id="bubbleChart"><p class="hint">Select a query to see its plans over time.</p></div>
        <div class="legendBox" id="legendBox" style="display:none;"><div class="legendTitle">Plan Id</div><div class="legend" id="legend"></div></div>
      </div>
      <div class="key" id="key" style="display:none;">
        <span><i class="k-dot"></i>Each bubble = a plan in one interval</span>
        <span><i class="k-forced"></i>Green ring = forced plan</span>
        <span>X = time &nbsp;·&nbsp; Y = <em id="keyMetric">wait time</em></span>
      </div></div>
  </div>
  <div id="drill" style="display:none;">
    <h3 id="drillTitle"></h3>
    <pre id="queryText"></pre>
    <h3>Plans<span class="note">Click a plan to open it in another tab.</span></h3>
    <table><thead id="planHead"></thead><tbody id="planBody"></tbody></table>
  </div>
  <div id="tip"></div>
<script nonce="${n}">
  const SVGNS = "http://www.w3.org/2000/svg";
  const PALETTE = ["#4f8cc9","#d18616","#3fb950","#c586c0","#e2c08d","#4ec9b0","#f14c4c","#9cdcfe","#b180d7","#d7ba7d"];
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let catCols = [], catRows = [], sortCol = -1, sortDir = 1, selectedCat = null;
  let qCols = [], qRows = [], barLabel = "Queries", selectedQuery = null, curQuery = null, metricName = "wait time";
  let sumCols = [], sumRows = [], planCols = [], planRows = [];
  const DEF = ${JSON.stringify({ start: defaults.start ?? "", end: defaults.end ?? "" })};
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function isNum(v){ return v !== null && v !== "" && !isNaN(Number(v)); }
  function pad(n){ return String(n).padStart(2, "0"); }
  function tzMode(){ return $("tz").value; }
  function toUtc(v){ if (!v) return ""; if (tzMode() === "utc") return (v.length === 16 ? v + ":00" : v.slice(0, 19));
    const d = new Date(v); return isNaN(d) ? "" : d.toISOString().slice(0, 19); }
  function utcToInput(u){ if (!u) return ""; const d = new Date(u + "Z"); if (isNaN(d)) return "";
    if (tzMode() === "utc") return u.slice(0, 16);
    return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function fmtTime(isoNoZ, opts){ const d = new Date(isoNoZ + "Z"); if (isNaN(d)) return isoNoZ;
    return d.toLocaleString(undefined, Object.assign({ timeZone: tzMode() === "utc" ? "UTC" : undefined }, opts)); }
  function curWindow(){ const v = $("window").value;
    if (v === "custom") return { hours: 0, start: toUtc($("from").value), end: toUtc($("to").value) };
    return { hours: Number(v), start: "", end: "" }; }
  function params(){ const w = curWindow();
    return { agg: $("agg").value, hours: w.hours, start: w.start, end: w.end, tz: tzMode(), topCats: Number($("topCats").value), topQueries: Number($("topQueries").value), interval: Number($("interval").value) }; }
  function customReady(){ return $("window").value !== "custom" || ($("from").value && $("to").value); }
  function toggleCustom(){ const c = $("window").value === "custom"; $("fromField").style.display = c ? "flex" : "none"; $("toField").style.display = c ? "flex" : "none"; }
  function el(tag, attrs, txt){ const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (txt != null) e.textContent = txt; return e; }
  function planColor(id){ return PALETTE[Math.abs(Number(id)) % PALETTE.length]; }
  function fmt(v){ if (v >= 1e6) return (v/1e6).toFixed(1)+"M"; if (v >= 1e3) return (v/1e3).toFixed(1)+"k"; return (Math.round(v*100)/100).toString(); }

  /* ---- wait categories grid ---- */
  function sortedCats() {
    if (sortCol < 0) return catRows;
    return [...catRows].sort((a, b) => {
      const x = a[sortCol], y = b[sortCol];
      if (x === null || x === "") return 1; if (y === null || y === "") return -1;
      const c = (isNum(x) && isNum(y)) ? (Number(x) - Number(y)) : String(x).localeCompare(String(y));
      return c * sortDir;
    });
  }
  function renderCats() {
    $("catHead").innerHTML = "<tr>" + catCols.map((c, i) =>
      '<th data-i="' + i + '">' + esc(c) + (i === sortCol ? '<span class="arrow"> ' + (sortDir>0?"▲":"▼") + "</span>" : "") + "</th>").join("") + "</tr>";
    const ci = catCols.indexOf("Category");
    $("catBody").innerHTML = sortedCats().map(r => {
      const s = r[ci] === selectedCat ? ' class="sel"' : "";
      return "<tr" + s + ' data-c="' + esc(r[ci]) + '">' + r.map(v =>
        v === null ? "<td></td>" : "<td" + (isNum(v) ? ' class="num"' : "") + ">" + esc(v) + "</td>").join("") + "</tr>";
    }).join("");
    [...$("catHead").querySelectorAll("th")].forEach(th => th.addEventListener("click", () => {
      const i = +th.dataset.i; if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; } renderCats();
    }));
    [...$("catBody").querySelectorAll("tr")].forEach(tr => tr.addEventListener("click", () => selectCategory(tr.dataset.c)));
  }
  function selectCategory(category) {
    selectedCat = category; selectedQuery = null; curQuery = null;
    renderCats();
    $("drill").style.display = "none";
    vscode.postMessage({ type: "selectCategory", category, ...params() });
  }

  /* ---- query bar chart (for the selected category) ---- */
  function drawBars() {
    $("barTitle").textContent = barLabel + (selectedCat ? " — " + selectedCat : "");
    const W = 460, H = 260, padL = 50, padB = 34, padT = 8, padR = 8;
    const qi = qCols.indexOf("QueryId"), vi = qCols.indexOf("WaitTimeMs");
    const data = qRows.slice(0, 50);
    const max = Math.max(1, ...data.map(r => Math.abs(Number(r[vi])) || 0));
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H });
    for (let g = 0; g <= 4; g++) {
      const y = padT + (H - padT - padB) * g / 4;
      svg.appendChild(el("line", { class: "grid", x1: padL, y1: y, x2: W - padR, y2: y }));
      svg.appendChild(el("text", { class: "tick", x: padL - 4, y: y + 3, "text-anchor": "end" }, fmt(max * (1 - g / 4))));
    }
    svg.appendChild(el("line", { class: "axis", x1: padL, y1: padT, x2: padL, y2: H - padB }));
    svg.appendChild(el("line", { class: "axis", x1: padL, y1: H - padB, x2: W - padR, y2: H - padB }));
    const bw = (W - padL - padR) / Math.max(1, data.length);
    data.forEach((r, i) => {
      const val = Math.abs(Number(r[vi])) || 0, qid = r[qi];
      const h = (val / max) * (H - padT - padB);
      const x = padL + i * bw + bw * 0.15, w = bw * 0.7, y = H - padB - h;
      const rect = el("rect", { class: "bar" + (qid === selectedQuery ? " sel" : ""), x, y, width: w, height: h,
        fill: qid === selectedQuery ? "var(--vscode-charts-orange, #d18616)" : "var(--vscode-charts-blue, #4f8cc9)" });
      rect.addEventListener("click", () => selectQuery(qid));
      rect.appendChild(el("title", {}, "Q" + qid + ": " + r[vi]));
      svg.appendChild(rect);
      if (bw > 14) svg.appendChild(el("text", { class: "tick", x: x + w / 2, y: H - padB + 11, "text-anchor": "middle", transform: "rotate(45 " + (x + w / 2) + " " + (H - padB + 11) + ")" }, String(qid)));
    });
    $("barChart").replaceChildren(svg);
  }
  function selectQuery(qid) {
    selectedQuery = qid; curQuery = qid; drawBars();
    vscode.postMessage({ type: "drill", queryId: Number(qid), category: selectedCat, ...params() });
  }

  /* ---- plan-summary bubble chart ---- */
  function drawBubbles() {
    const cols = sumCols, srows = sumRows;
    const pi = cols.indexOf("PlanId"), ti = cols.indexOf("IntervalStart"), vi = cols.indexOf("Value"), fi = cols.indexOf("Forced");
    if (!srows.length) { $("bubbleChart").innerHTML = '<p class="hint">No interval data for this query in the window.</p>'; $("legendBox").style.display = "none"; return; }
    const pts = srows.map((r, idx) => ({ row: idx, plan: r[pi], t: Date.parse(r[ti] + "Z") || Date.parse(r[ti]), v: Number(r[vi]) || 0, forced: String(r[fi]) === "1" }));
    const W = 520, H = 260, padL = 50, padB = 28, padT = 8, padR = 10;
    const tMin = Math.min(...pts.map(p => p.t)), tMax = Math.max(...pts.map(p => p.t));
    const vMax = Math.max(1, ...pts.map(p => p.v));
    const tSpan = Math.max(1, tMax - tMin);
    const x = t => padL + (t - tMin) / tSpan * (W - padL - padR);
    const y = v => padT + (1 - v / vMax) * (H - padT - padB);
    const rOf = v => 4 + Math.sqrt(v / vMax) * 5;
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H });
    for (let g = 0; g <= 4; g++) {
      const yy = padT + (H - padT - padB) * g / 4;
      svg.appendChild(el("line", { class: "grid", x1: padL, y1: yy, x2: W - padR, y2: yy }));
      svg.appendChild(el("text", { class: "tick", x: padL - 4, y: yy + 3, "text-anchor": "end" }, fmt(vMax * (1 - g / 4))));
    }
    svg.appendChild(el("line", { class: "axis", x1: padL, y1: padT, x2: padL, y2: H - padB }));
    svg.appendChild(el("line", { class: "axis", x1: padL, y1: H - padB, x2: W - padR, y2: H - padB }));
    const tzOpt = { timeZone: tzMode() === "utc" ? "UTC" : undefined, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" };
    [0, 0.5, 1].forEach(f => { const t = tMin + tSpan * f; svg.appendChild(el("text", { class: "tick", x: x(t), y: H - padB + 11, "text-anchor": f === 1 ? "end" : (f === 0 ? "start" : "middle") }, new Date(t).toLocaleString(undefined, tzOpt))); });
    pts.forEach(p => {
      const c = el("circle", { cx: x(p.t), cy: y(p.v), r: rOf(p.v), fill: planColor(p.plan), "fill-opacity": 0.85,
        stroke: p.forced ? "var(--vscode-charts-green, #3fb950)" : "rgba(0,0,0,0.55)", "stroke-width": p.forced ? 2 : 0.75 });
      c.style.cursor = "pointer";
      c.addEventListener("mouseenter", (ev) => showTip(p.row, ev));
      c.addEventListener("mousemove", moveTip);
      c.addEventListener("mouseleave", hideTip);
      c.addEventListener("click", () => { hideTip(); vscode.postMessage({ type: "openPlan", planId: Number(p.plan) }); });
      svg.appendChild(c);
    });
    $("bubbleChart").replaceChildren(svg);
    $("key").style.display = "flex"; $("keyMetric").textContent = metricName;
    const plans = [...new Set(pts.map(p => p.plan))];
    $("legendBox").style.display = "block";
    $("legend").innerHTML = plans.map(p => { const forced = pts.some(q => q.plan === p && q.forced); return '<span data-plan="' + esc(p) + '"><i style="background:' + planColor(p) + '"></i>' + esc(p) + (forced ? " ★" : "") + "</span>"; }).join("");
    [...$("legend").querySelectorAll("[data-plan]")].forEach(s => s.addEventListener("click", () => vscode.postMessage({ type: "openPlan", planId: Number(s.dataset.plan) })));
  }
  function showTip(rowIdx, ev) {
    const r = sumRows[rowIdx]; if (!r) return;
    const get = name => { const i = sumCols.indexOf(name); return i < 0 ? "" : (r[i] === null ? "" : r[i]); };
    const forced = String(get("Forced")) === "1";
    const fields = [
      ["Plan Id", get("PlanId")],
      ["Wait Category", get("WaitCategory")],
      ["Plan Forced", forced ? "Yes" : "No"],
      ["Interval Start", fmtTime(get("IntervalStart"), { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })],
      ["Interval End", fmtTime(get("IntervalEnd"), { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })],
      ["Total wait (ms)", get("Total")],
      ["Avg wait (ms)", get("Avg")],
      ["Min wait (ms)", get("Min")],
      ["Max wait (ms)", get("Max")],
      ["Std Dev wait (ms)", get("StdDev")],
      ["Executions", get("Executions")],
    ];
    $("tip").innerHTML = "<table><tbody>" + fields.map(f => "<tr><td>" + esc(f[0]) + "</td><td>" + esc(f[1]) + "</td></tr>").join("") + "</tbody></table>";
    $("tip").style.display = "block"; moveTip(ev);
  }
  function moveTip(ev) {
    const tip = $("tip"); if (tip.style.display !== "block") return;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let left = ev.clientX + pad, top = ev.clientY + pad;
    if (left + w > window.innerWidth) left = ev.clientX - pad - w;
    if (top + h > window.innerHeight) top = ev.clientY - pad - h;
    tip.style.left = Math.max(4, left) + "px"; tip.style.top = Math.max(4, top) + "px";
  }
  function hideTip() { $("tip").style.display = "none"; }

  /* ---- plans grid ---- */
  function renderPlans() {
    $("planHead").innerHTML = "<tr>" + planCols.map(c => "<th>" + esc(c) + "</th>").join("") + "<th>Action</th></tr>";
    const fIdx = planCols.indexOf("Forced"), pIdx = planCols.indexOf("PlanId");
    $("planBody").innerHTML = planRows.map(r => {
      const forced = String(r[fIdx]) === "1", planId = r[pIdx];
      const cells = r.map((v, i) => i === fIdx ? (forced ? '<td class="forced">Yes</td>' : "<td>No</td>")
        : (v === null ? "<td></td>" : "<td" + (isNum(v) ? ' class="num"' : "") + ">" + esc(v) + "</td>")).join("");
      const force = forced
        ? '<button class="small secondary" data-unforce="' + esc(planId) + '">Unforce</button>'
        : '<button class="small" data-force="' + esc(planId) + '">Force</button>';
      const open = '<button class="small secondary" data-open="' + esc(planId) + '">Open Plan</button>';
      return '<tr data-plan="' + esc(planId) + '">' + cells + "<td>" + force + " " + open + "</td></tr>";
    }).join("");
    const send = (type, planId) => vscode.postMessage({ type, queryId: Number(curQuery), planId: Number(planId), category: selectedCat, ...params() });
    [...$("planBody").querySelectorAll("[data-force]")].forEach(b => b.addEventListener("click", (ev) => { ev.stopPropagation(); send("force", b.dataset.force); }));
    [...$("planBody").querySelectorAll("[data-unforce]")].forEach(b => b.addEventListener("click", (ev) => { ev.stopPropagation(); send("unforce", b.dataset.unforce); }));
    [...$("planBody").querySelectorAll("[data-open]")].forEach(b => b.addEventListener("click", (ev) => { ev.stopPropagation(); vscode.postMessage({ type: "openPlan", planId: Number(b.dataset.open) }); }));
    [...$("planBody").querySelectorAll("tr")].forEach(tr => tr.addEventListener("click", () => vscode.postMessage({ type: "openPlan", planId: Number(tr.dataset.plan) })));
  }

  const applyIfReady = () => { if (customReady()) vscode.postMessage({ type: "apply", ...params() }); };
  $("apply").addEventListener("click", applyIfReady);
  ["agg","topCats","topQueries"].forEach(id => $(id).addEventListener("change", applyIfReady));
  $("window").addEventListener("change", () => { toggleCustom(); applyIfReady(); });
  $("from").addEventListener("change", applyIfReady);
  $("to").addEventListener("change", applyIfReady);
  $("tz").addEventListener("change", () => {
    applyIfReady();
    if (selectedQuery != null) vscode.postMessage({ type: "drill", queryId: Number(selectedQuery), category: selectedCat, ...params() });
  });
  $("interval").addEventListener("change", () => {
    if (!customReady()) return;
    if (selectedQuery != null) vscode.postMessage({ type: "drill", queryId: Number(selectedQuery), category: selectedCat, ...params() });
    else vscode.postMessage({ type: "apply", ...params() });
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "cats") {
      catCols = m.columns; catRows = m.rows; $("msg").innerHTML = "";
      selectedCat = null; selectedQuery = null; renderCats();
      $("qpanes").style.display = "none"; $("drill").style.display = "none";
    }
    else if (m.type === "queries") {
      qCols = m.columns; qRows = m.rows; barLabel = m.valueLabel || "Queries"; selectedQuery = null;
      drawBars(); $("qpanes").style.display = "flex";
      $("bubbleChart").innerHTML = '<p class="hint">Select a query to see its plans over time.</p>';
      $("legendBox").style.display = "none"; $("key").style.display = "none"; $("drill").style.display = "none";
    }
    else if (m.type === "drill") {
      $("drillTitle").innerHTML = "Query " + esc(m.queryId) + '<span class="note">Query text is retrieved from the stored showplan and may be truncated.</span>';
      $("queryText").textContent = m.text;
      $("bubbleTitle").textContent = "Plan summary for query " + m.queryId;
      metricName = m.metricName || "wait time"; sumCols = m.summary.columns; sumRows = m.summary.rows; drawBubbles();
      planCols = m.plans.columns; planRows = m.plans.rows; renderPlans(); $("drill").style.display = "block";
    }
    else if (m.type === "disabled") { $("msg").innerHTML = '<p class="hint">Query Store is not enabled for read (state: ' + esc(m.state) + ').</p>'; }
    else if (m.type === "error") { $("msg").innerHTML = '<p class="error">' + esc(m.message) + "</p>"; }
  });
  if (DEF.start && DEF.end) { $("from").value = utcToInput(DEF.start); $("to").value = utcToInput(DEF.end); }
  toggleCustom();
  vscode.postMessage({ type: "ready", ...params() });
</script>
</body></html>`;
}

/* ---------- Queries With Forced Plans ---------- */

interface ForcedDefaults {
  metric?: string;
  agg?: string;
  hours?: number;
  start?: string;
  end?: string;
  tz?: string;
  interval?: number;
  topN?: number;
  minPlans?: number;
}

export function openQueryStoreForcedPlans(run: QueryRunner, state: vscode.Memento): void {
  const stateKey = "qs.defaults.forced";
  const defaults = state.get<ForcedDefaults>(stateKey, {});
  const panel = vscode.window.createWebviewPanel(
    "ssms.qsForcedPlans",
    "Query Store — Forced Plans",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = forcedHtml(defaults);
  const post = (m: unknown): void => void panel.webview.postMessage(m);

  panel.webview.onDidReceiveMessage(
    async (msg: {
      type: string;
      metric?: string; agg?: string; hours?: number; start?: string; end?: string;
      tz?: string; interval?: number; topN?: number; minPlans?: number;
      queryId?: number; planId?: number;
    }) => {
      try {
        const metric = msg.metric ?? defaults.metric ?? "duration";
        const agg = msg.agg ?? defaults.agg ?? "avg";
        const hours = msg.hours ?? defaults.hours ?? 720;
        const tz = msg.tz ?? defaults.tz ?? "local";
        const interval = msg.interval ?? defaults.interval ?? 60;
        const topN = msg.topN ?? defaults.topN ?? 0;
        const minPlans = msg.minPlans ?? defaults.minPlans ?? 1;
        const win: QS.TimeWindow = { hours, start: msg.start || defaults.start, end: msg.end || defaults.end };

        if (msg.type === "ready" && !(await guard(run, post))) return;

        if (msg.type === "configure") {
          await state.update(stateKey, { metric, agg, hours, start: win.start, end: win.end, tz, interval, topN, minPlans });
        }
        if (msg.type === "ready" || msg.type === "refresh" || msg.type === "configure") {
          post({ type: "rows", ...serialize(await run(QS.forcedPlansQuery(topN, minPlans))) });
        } else if (msg.type === "drill" && msg.queryId != null) {
          const [text, summary, plans] = await Promise.all([
            run(QS.queryTextQuery(msg.queryId)),
            run(QS.planSummaryQuery(msg.queryId, metric, agg, win, interval)),
            run(QS.queryPlansQuery(msg.queryId, win)),
          ]);
          post({
            type: "drill",
            queryId: msg.queryId,
            metricName: QS.metricLabel(metric),
            text: text.rows[0]?.[0]?.displayValue ?? "",
            summary: serialize(summary),
            plans: serialize(plans),
          });
        } else if ((msg.type === "force" || msg.type === "unforce") && msg.queryId != null && msg.planId != null) {
          await run(msg.type === "force"
            ? QS.forcePlanStatement(msg.queryId, msg.planId)
            : QS.unforcePlanStatement(msg.queryId, msg.planId));
          // Refresh both the forced-plans list and the drilled query's plans table.
          post({ type: "rows", ...serialize(await run(QS.forcedPlansQuery(topN, minPlans))) });
          const [text, summary, plans] = await Promise.all([
            run(QS.queryTextQuery(msg.queryId)),
            run(QS.planSummaryQuery(msg.queryId, metric, agg, win, interval)),
            run(QS.queryPlansQuery(msg.queryId, win)),
          ]);
          post({ type: "drill", queryId: msg.queryId, metricName: QS.metricLabel(metric),
            text: text.rows[0]?.[0]?.displayValue ?? "", summary: serialize(summary), plans: serialize(plans) });
        } else if (msg.type === "openPlan" && msg.planId != null) {
          await openPlanXml(run, msg.planId);
        }
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}

function forcedHtml(defaults: ForcedDefaults): string {
  const n = nonce();
  const sel = (a: string | number, b: string | number): string => String(a) === String(b) ? " selected" : "";
  const metricOpts = QS.METRIC_OPTIONS.map(m => `<option value="${m.key}"${sel(m.key, defaults.metric ?? "duration")}>${m.label}</option>`).join("");
  const aggOpts = QS.AGG_OPTIONS.map(a => `<option value="${a.key}"${sel(a.key, defaults.agg ?? "avg")}>${a.label}</option>`).join("");
  const windowVals: Array<[string, string]> = [
    ["0.0833333","Last 5 minutes"],["0.25","Last 15 minutes"],["0.5","Last 30 minutes"],
    ["1","Last hour"],["12","Last 12 hours"],["24","Last day"],["48","Last 2 days"],
    ["168","Last week"],["336","Last 2 weeks"],["720","Last month"],
    ["2160","Last 3 months"],["4320","Last 6 months"],["8760","Last year"],
  ];
  const windowDefault = defaults.hours != null ? String(defaults.hours) : "720";
  const isCustom = !!(defaults.start && defaults.end);
  const windowOpts = windowVals.map(([v,l]) => `<option value="${v}"${!isCustom ? sel(v, windowDefault) : ""}>${l}</option>`).join("") +
    `<option value="custom"${isCustom ? " selected" : ""}>Custom…</option>`;
  const intervalOpts = QS.INTERVAL_OPTIONS.map(o => `<option value="${o.key}"${sel(o.key, defaults.interval ?? 60)}>${o.label}</option>`).join("");
  const topN = defaults.topN ?? 0;
  const minPlans = defaults.minPlans ?? 1;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(n)}">
<style>${qsStyles()}
/* Let long query text wrap inside the left list pane instead of forcing the table wide. */
#tbody td { white-space: normal; word-break: break-word; }
#tbody td:nth-child(2) { max-width: 0; width: 60%; }
.overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:200; align-items:center; justify-content:center; }
.overlay.open { display:flex; }
.dlg { background:var(--vscode-editorWidget-background); color:var(--vscode-foreground);
       border:1px solid var(--vscode-panel-border); border-radius:6px; padding:0; min-width:420px; max-width:600px; }
.dlg-header { padding:12px 16px 8px; font-weight:600; font-size:1em; border-bottom:1px solid var(--vscode-panel-border); }
.dlg-body { padding:12px 16px; display:flex; flex-direction:column; gap:14px; }
.dlg-section { font-size:0.78em; font-weight:600; color:var(--vscode-descriptionForeground);
               text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; }
.dlg-row { display:flex; gap:16px; flex-wrap:wrap; align-items:flex-end; }
.dlg-footer { padding:10px 16px; border-top:1px solid var(--vscode-panel-border); display:flex; gap:8px; justify-content:flex-end; }
</style></head>
<body>
  <h2>Queries with forced plans</h2>
  <div class="controls">
    <div style="flex:1 1 auto"></div>
    <button id="btnRefresh">Refresh</button>
    <button id="btnConfigure" class="secondary">Configure</button>
  </div>
  <div id="msg"></div>
  <div class="panes">
    <div class="pane"><h3 id="listTitle">Forced plans</h3>
      <div id="tableMsg"><p class="hint">Loading…</p></div>
      <table><thead id="thead"></thead><tbody id="tbody"></tbody></table>
    </div>
    <div class="pane"><h3 id="bubbleTitle">Plan summary</h3>
      <div class="bubbleRow">
        <div id="bubbleChart"><p class="hint">Select a query to see its plans over time.</p></div>
        <div class="legendBox" id="legendBox" style="display:none;"><div class="legendTitle">Plan Id</div><div class="legend" id="legend"></div></div>
      </div>
      <div class="key" id="key" style="display:none;">
        <span><i class="k-dot"></i>Each bubble = a plan in one interval</span>
        <span><i class="k-size"></i>Size = execution count</span>
        <span><i class="k-forced"></i>Green ring = forced plan</span>
        <span>X = time &nbsp;·&nbsp; Y = <em id="keyMetric">metric</em></span>
      </div>
    </div>
  </div>
  <div id="drill" style="display:none;">
    <h3 id="drillTitle"></h3>
    <pre id="queryText"></pre>
    <h3 id="planAreaTitle">Plans<span class="note">Click a plan to open it in another tab.</span></h3>
    <table><thead id="planHead"></thead><tbody id="planBody"></tbody></table>
  </div>

<div id="dlgOverlay" class="overlay">
<div class="dlg">
  <div class="dlg-header">Configure Queries with forced plans</div>
  <div class="dlg-body">
    <div>
      <div class="dlg-section">Regression Criteria (plan summary panel)</div>
      <div class="dlg-row">
        <div class="field"><label>Metric</label><select id="dlgMetric">${metricOpts}</select></div>
        <div class="field"><label>Based on</label><select id="dlgAgg">${aggOpts}</select></div>
      </div>
    </div>
    <div>
      <div class="dlg-section">Time Interval (plan summary panel)</div>
      <div class="dlg-row">
        <div class="field"><label>Window</label><select id="dlgWindow">${windowOpts}</select></div>
        <div class="field" id="dlgFromField" style="display:none;"><label>From</label><input type="datetime-local" id="dlgFrom" value="${defaults.start ? defaults.start.slice(0,16) : ""}"></div>
        <div class="field" id="dlgToField" style="display:none;"><label>To</label><input type="datetime-local" id="dlgTo" value="${defaults.end ? defaults.end.slice(0,16) : ""}"></div>
        <div class="field"><label>Time format</label><select id="dlgTz">
          <option value="local"${(defaults.tz ?? "local") === "local" ? " selected" : ""}>Local</option>
          <option value="utc"${defaults.tz === "utc" ? " selected" : ""}>UTC</option>
        </select></div>
        <div class="field"><label>Interval</label><select id="dlgInterval">${intervalOpts}</select></div>
      </div>
    </div>
    <div>
      <div class="dlg-section">Return</div>
      <div class="dlg-row">
        <label><input type="radio" name="retAll" id="dlgRetAll" value="all"${topN === 0 ? " checked" : ""}> All</label>
        <label><input type="radio" name="retAll" id="dlgRetTop" value="top"${topN > 0 ? " checked" : ""}> Top</label>
        <input type="number" id="dlgTopN" min="1" step="1" value="${topN > 0 ? topN : 25}" style="width:60px;" ${topN === 0 ? "disabled" : ""}>
      </div>
    </div>
    <div>
      <div class="dlg-section">Filters</div>
      <div class="dlg-row">
        <div class="field"><label>Minimum number of query plans</label><input type="number" id="dlgMinPlans" min="1" step="1" value="${minPlans}" style="width:70px;"></div>
      </div>
    </div>
  </div>
  <div class="dlg-footer">
    <button id="dlgOk">Ok</button>
    <button id="dlgCancel" class="secondary">Cancel</button>
    <button id="dlgApply" class="secondary">Apply</button>
  </div>
</div></div>

<div id="tip"></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const PALETTE = ["#4f8cc9","#d18616","#3fb950","#c586c0","#e2c08d","#4ec9b0","#f14c4c","#9cdcfe","#b180d7","#d7ba7d"];
  let columns = [], rows = [], sortCol = 3, sortDir = -1, selected = null;
  let sumCols = [], sumRows = [], planCols = [], planRows = [], curQuery = null, metricName = "metric";
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function isNum(v){ return v !== null && v !== "" && !isNaN(Number(v)); }
  function tzMode(){ return $("dlgTz").value; }
  function fmtTime(isoNoZ, opts){ const d = new Date(isoNoZ+"Z"); if(isNaN(d)) return isoNoZ;
    return d.toLocaleString(undefined, Object.assign({ timeZone: tzMode()==="utc"?"UTC":undefined }, opts)); }
  function fmt(v){ if(v>=1e6) return (v/1e6).toFixed(1)+"M"; if(v>=1e3) return (v/1e3).toFixed(1)+"k"; return (Math.round(v*100)/100).toString(); }
  function el(tag,attrs,txt){ const e=document.createElementNS(SVGNS,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); if(txt!=null) e.textContent=txt; return e; }
  function planColor(id){ return PALETTE[Math.abs(Number(id))%PALETTE.length]; }

  function params(){
    const w=$("dlgWindow").value;
    const hours=w==="custom"?0:Number(w);
    const start=w==="custom"?$("dlgFrom").value:""; const end=w==="custom"?$("dlgTo").value:"";
    const topN=$("dlgRetAll").checked?0:Math.max(1,Number($("dlgTopN").value)||25);
    return { metric:$("dlgMetric").value, agg:$("dlgAgg").value, hours, start, end,
      tz:$("dlgTz").value, interval:Number($("dlgInterval").value),
      topN, minPlans:Number($("dlgMinPlans").value)||1 };
  }

  function sorted(){
    if(sortCol<0) return rows;
    return [...rows].sort((a,b)=>{
      const x=a[sortCol],y=b[sortCol];
      if(x===null||x==="") return 1; if(y===null||y==="") return -1;
      const c=(isNum(x)&&isNum(y))?(Number(x)-Number(y)):String(x).localeCompare(String(y));
      return c*sortDir;
    });
  }

  /* ---- query table (left pane) ---- */
  function renderTable(){
    $("thead").innerHTML="<tr>"+columns.map((c,i)=>
      '<th data-i="'+i+'">'+esc(c)+(i===sortCol?'<span class="arrow"> '+(sortDir>0?"▲":"▼")+"</span>":"")+"</th>").join("")+"</tr>";
    const qi=columns.indexOf("QueryId");
    $("tbody").innerHTML=sorted().map(r=>{
      const sel=r[qi]===selected?' class="sel"':"";
      return "<tr"+sel+' data-q="'+esc(r[qi])+'">'+r.map(v=>
        v===null?"<td></td>":"<td"+(isNum(v)?' class="num"':"")+">"+esc(v)+"</td>").join("")+"</tr>";
    }).join("");
    if(rows.length===0) $("tbody").innerHTML='<tr><td colspan="'+columns.length+'">No queries have a forced plan.</td></tr>';
    [...$("thead").querySelectorAll("th[data-i]")].forEach(th=>th.addEventListener("click",()=>{
      const i=+th.dataset.i; if(sortCol===i) sortDir=-sortDir; else{sortCol=i;sortDir=1;} renderTable();
    }));
    [...$("tbody").querySelectorAll("tr[data-q]")].forEach(tr=>tr.addEventListener("click",()=>drill(tr.dataset.q)));
  }
  function drill(queryId){
    selected=queryId; curQuery=queryId; renderTable();
    vscode.postMessage({type:"drill",queryId:Number(queryId),...params()});
  }

  /* ---- plan-summary bubble chart (mirrors ranked report) ---- */
  function drawBubbles(){
    const cols=sumCols, srows=sumRows;
    const pi=cols.indexOf("PlanId"), ti=cols.indexOf("IntervalStart"), vi=cols.indexOf("Value"),
          ei=cols.indexOf("Executions"), fi=cols.indexOf("Forced");
    if(!srows.length){ $("bubbleChart").innerHTML='<p class="hint">No interval data for this query in the window.</p>'; $("legendBox").style.display="none"; $("key").style.display="none"; return; }
    const pts=srows.map((r,idx)=>({row:idx,plan:r[pi],t:Date.parse(r[ti]+"Z")||Date.parse(r[ti]),v:Number(r[vi])||0,e:Number(r[ei])||1,forced:String(r[fi])==="1"}));
    const W=520,H=260,padL=50,padB=28,padT=8,padR=10;
    const tMin=Math.min(...pts.map(p=>p.t)), tMax=Math.max(...pts.map(p=>p.t));
    const vMax=Math.max(1,...pts.map(p=>p.v)), eMax=Math.max(1,...pts.map(p=>p.e));
    const tSpan=Math.max(1,tMax-tMin);
    const x=t=>padL+(t-tMin)/tSpan*(W-padL-padR);
    const y=v=>padT+(1-v/vMax)*(H-padT-padB);
    const rOf=e=>3+Math.sqrt(e/eMax)*6;
    const svg=el("svg",{viewBox:"0 0 "+W+" "+H});
    for(let g=0;g<=4;g++){
      const yy=padT+(H-padT-padB)*g/4;
      svg.appendChild(el("line",{class:"grid",x1:padL,y1:yy,x2:W-padR,y2:yy}));
      svg.appendChild(el("text",{class:"tick",x:padL-4,y:yy+3,"text-anchor":"end"},fmt(vMax*(1-g/4))));
    }
    svg.appendChild(el("line",{class:"axis",x1:padL,y1:padT,x2:padL,y2:H-padB}));
    svg.appendChild(el("line",{class:"axis",x1:padL,y1:H-padB,x2:W-padR,y2:H-padB}));
    const tzOpt={timeZone:tzMode()==="utc"?"UTC":undefined,month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"};
    [0,0.5,1].forEach(f=>{ const t=tMin+tSpan*f; svg.appendChild(el("text",{class:"tick",x:x(t),y:H-padB+11,"text-anchor":f===1?"end":(f===0?"start":"middle")},new Date(t).toLocaleString(undefined,tzOpt))); });
    pts.forEach(p=>{
      const c=el("circle",{cx:x(p.t),cy:y(p.v),r:rOf(p.e),fill:planColor(p.plan),"fill-opacity":0.85,
        stroke:p.forced?"var(--vscode-charts-green, #3fb950)":"rgba(0,0,0,0.55)","stroke-width":p.forced?2:0.75});
      c.style.cursor="pointer";
      c.addEventListener("mouseenter",ev=>showTip(p.row,ev));
      c.addEventListener("mousemove",moveTip);
      c.addEventListener("mouseleave",hideTip);
      c.addEventListener("click",()=>{ hideTip(); vscode.postMessage({type:"openPlan",planId:Number(p.plan)}); });
      svg.appendChild(c);
    });
    $("bubbleChart").replaceChildren(svg);
    $("key").style.display="flex"; $("keyMetric").textContent=metricName;
    const plans=[...new Set(pts.map(p=>p.plan))];
    $("legendBox").style.display="block";
    $("legend").innerHTML=plans.map(p=>{ const forced=pts.some(q=>q.plan===p&&q.forced); return '<span data-plan="'+esc(p)+'"><i style="background:'+planColor(p)+'"></i>'+esc(p)+(forced?" ★":"")+"</span>"; }).join("");
    [...$("legend").querySelectorAll("[data-plan]")].forEach(s=>s.addEventListener("click",()=>vscode.postMessage({type:"openPlan",planId:Number(s.dataset.plan)})));
  }
  function showTip(rowIdx, ev){
    const r=sumRows[rowIdx]; if(!r) return;
    const get=name=>{ const i=sumCols.indexOf(name); return i<0?"":(r[i]===null?"":r[i]); };
    const forced=String(get("Forced"))==="1";
    const fields=[
      ["Plan Id",get("PlanId")],
      ["Execution Type",get("ExecutionType")],
      ["Plan Forced",forced?"Yes":"No"],
      ["Interval Start",fmtTime(get("IntervalStart"),{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})],
      ["Interval End",fmtTime(get("IntervalEnd"),{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})],
      ["Execution Count",get("Executions")],
      ["Total "+metricName,get("Total")],
      ["Avg "+metricName,get("Avg")],
      ["Min "+metricName,get("Min")],
      ["Max "+metricName,get("Max")],
      ["Std Dev "+metricName,get("StdDev")],
    ];
    $("tip").innerHTML="<table><tbody>"+fields.map(f=>"<tr><td>"+esc(f[0])+"</td><td>"+esc(f[1])+"</td></tr>").join("")+"</tbody></table>";
    $("tip").style.display="block"; moveTip(ev);
  }
  function moveTip(ev){
    const tip=$("tip"); if(tip.style.display!=="block") return;
    const pad=14, w=tip.offsetWidth, h=tip.offsetHeight;
    let left=ev.clientX+pad, top=ev.clientY+pad;
    if(left+w>window.innerWidth) left=ev.clientX-pad-w;
    if(top+h>window.innerHeight) top=ev.clientY-pad-h;
    tip.style.left=Math.max(4,left)+"px"; tip.style.top=Math.max(4,top)+"px";
  }
  function hideTip(){ $("tip").style.display="none"; }

  function renderPlans(){
    $("planHead").innerHTML="<tr>"+planCols.map(c=>"<th>"+esc(c)+"</th>").join("")+"<th>Action</th></tr>";
    const fIdx=planCols.indexOf("Forced"), pIdx=planCols.indexOf("PlanId");
    $("planBody").innerHTML=planRows.map(r=>{
      const forced=String(r[fIdx])==="1", planId=r[pIdx];
      const cells=r.map((v,i)=>i===fIdx?(forced?'<td class="forced">Yes</td>':"<td>No</td>")
        :(v===null?"<td></td>":"<td"+(isNum(v)?' class="num"':"")+">"+esc(v)+"</td>")).join("");
      const force=forced
        ? '<button class="small secondary" data-unforce="'+esc(planId)+'">Unforce</button>'
        : '<button class="small" data-force="'+esc(planId)+'">Force</button>';
      const open='<button class="small secondary" data-open="'+esc(planId)+'">Open Plan</button>';
      return '<tr data-plan="'+esc(planId)+'">'+cells+"<td>"+force+" "+open+"</td></tr>";
    }).join("");
    const stop=(b,type,key)=>b.addEventListener("click",ev=>{ ev.stopPropagation();
      vscode.postMessage({type,queryId:Number(curQuery),planId:Number(b.dataset[key]),...params()}); });
    [...$("planBody").querySelectorAll("[data-force]")].forEach(b=>stop(b,"force","force"));
    [...$("planBody").querySelectorAll("[data-unforce]")].forEach(b=>stop(b,"unforce","unforce"));
    [...$("planBody").querySelectorAll("[data-open]")].forEach(b=>b.addEventListener("click",ev=>{
      ev.stopPropagation(); vscode.postMessage({type:"openPlan",planId:Number(b.dataset.open)}); }));
    [...$("planBody").querySelectorAll("tr")].forEach(tr=>tr.addEventListener("click",()=>
      vscode.postMessage({type:"openPlan",planId:Number(tr.dataset.plan)})));
  }

  /* ---- Configure dialog ---- */
  function openDlg(){ toggleCustomDlg(); $("dlgOverlay").classList.add("open"); }
  function closeDlg(){ $("dlgOverlay").classList.remove("open"); }
  function toggleCustomDlg(){
    const c=$("dlgWindow").value==="custom";
    $("dlgFromField").style.display=c?"flex":"none"; $("dlgToField").style.display=c?"flex":"none";
  }
  function applyConfig(){ vscode.postMessage({type:"configure",...params()}); }

  try {
    $("btnConfigure").addEventListener("click", openDlg);
    $("btnRefresh").addEventListener("click",()=>vscode.postMessage({type:"refresh",...params()}));
    $("dlgCancel").addEventListener("click", closeDlg);
    $("dlgOk").addEventListener("click",()=>{ applyConfig(); closeDlg(); });
    $("dlgApply").addEventListener("click", applyConfig);
    $("dlgWindow").addEventListener("change", toggleCustomDlg);
    $("dlgRetAll").addEventListener("change",()=>{ $("dlgTopN").disabled=true; });
    $("dlgRetTop").addEventListener("change",()=>{ $("dlgTopN").disabled=false; });
    $("dlgOverlay").addEventListener("click",e=>{ if(e.target===$("dlgOverlay")) closeDlg(); });
  } catch(setupErr) {
    $("msg").innerHTML='<p class="error">Setup error: '+esc(String(setupErr))+"</p>";
  }

  window.addEventListener("message",e=>{
    const m=e.data;
    if(m.type==="rows"){ columns=m.columns; rows=m.rows; $("tableMsg").innerHTML=""; $("msg").innerHTML=""; renderTable(); }
    else if(m.type==="drill"){
      $("drillTitle").innerHTML="Query "+esc(m.queryId)+'<span class="note">Query text is retrieved from the stored showplan and may be truncated.</span>';
      $("queryText").textContent=m.text;
      $("bubbleTitle").textContent="Plan summary — Query "+m.queryId;
      metricName=m.metricName||"metric";
      sumCols=m.summary.columns; sumRows=m.summary.rows; drawBubbles();
      planCols=m.plans.columns; planRows=m.plans.rows; renderPlans();
      $("drill").style.display="block";
    }
    else if(m.type==="disabled"){ $("tableMsg").innerHTML='<p class="hint">Query Store is not enabled for read (state: '+esc(m.state)+').</p>'; }
    else if(m.type==="error"){ $("msg").innerHTML='<p class="error">'+esc(m.message)+"</p>"; }
  });
  toggleCustomDlg();
  vscode.postMessage({type:"ready",...params()});
</script>
</body></html>`;
}

/* ---------- Tracked Queries ---------- */

interface TrackedDefaults {
  queryId?: number;
  metric?: string;
  agg?: string;
  hours?: number;
  start?: string;
  end?: string;
  tz?: string;
  interval?: number;
}

export function openQueryStoreTracked(run: QueryRunner, state: vscode.Memento): void {
  const stateKey = "qs.defaults.tracked";
  const defaults = state.get<TrackedDefaults>(stateKey, {});
  const panel = vscode.window.createWebviewPanel(
    "ssms.qsTracked",
    "Query Store — Tracked Queries",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = trackedHtml(defaults);
  const post = (m: unknown): void => void panel.webview.postMessage(m);

  panel.webview.onDidReceiveMessage(
    async (msg: {
      type: string;
      queryId?: number; metric?: string; agg?: string; hours?: number; start?: string; end?: string;
      tz?: string; interval?: number; planId?: number;
    }) => {
      try {
        const metric = msg.metric ?? defaults.metric ?? "duration";
        const agg = msg.agg ?? defaults.agg ?? "avg";
        const hours = msg.hours ?? defaults.hours ?? 24;
        const interval = msg.interval ?? defaults.interval ?? 60;
        const win: QS.TimeWindow = { hours, start: msg.start || undefined, end: msg.end || undefined };

        if (msg.type === "ready" && !(await guard(run, post))) return;

        const drill = async (queryId: number): Promise<void> => {
          const [text, summary, plans] = await Promise.all([
            run(QS.queryTextQuery(queryId)),
            run(QS.planSummaryQuery(queryId, metric, agg, win, interval)),
            run(QS.queryPlansQuery(queryId, win)),
          ]);
          const found = (text.rows[0]?.[0]?.displayValue ?? "") !== "" || summary.rows.length > 0 || plans.rows.length > 0;
          if (!found) { post({ type: "notfound", queryId }); return; }
          post({
            type: "drill",
            queryId,
            metricName: QS.metricLabel(metric),
            text: text.rows[0]?.[0]?.displayValue ?? "",
            summary: serialize(summary),
            plans: serialize(plans),
          });
        };

        if (msg.type === "track" || (msg.type === "ready" && msg.queryId != null) ||
            ((msg.type === "force" || msg.type === "unforce") && msg.queryId != null && msg.planId != null)) {
          if ((msg.type === "force" || msg.type === "unforce") && msg.planId != null && msg.queryId != null) {
            await run(msg.type === "force"
              ? QS.forcePlanStatement(msg.queryId, msg.planId)
              : QS.unforcePlanStatement(msg.queryId, msg.planId));
          }
          if (msg.queryId != null) {
            await state.update(stateKey, { queryId: msg.queryId, metric, agg, hours, start: win.start, end: win.end, tz: msg.tz ?? defaults.tz ?? "local", interval });
            await drill(msg.queryId);
          }
        } else if (msg.type === "openPlan" && msg.planId != null) {
          await openPlanXml(run, msg.planId);
        }
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}

function windowOptionsHtml(defaults: { hours?: number; start?: string; end?: string }, fallback: string): string {
  const sel = (a: string, b: string): string => a === b ? " selected" : "";
  const vals: Array<[string, string]> = [
    ["0.0833333","Last 5 minutes"],["0.25","Last 15 minutes"],["0.5","Last 30 minutes"],
    ["1","Last hour"],["12","Last 12 hours"],["24","Last day"],["48","Last 2 days"],
    ["168","Last week"],["336","Last 2 weeks"],["720","Last month"],
    ["2160","Last 3 months"],["4320","Last 6 months"],["8760","Last year"],
  ];
  const isCustom = !!(defaults.start && defaults.end);
  const def = defaults.hours != null ? String(defaults.hours) : fallback;
  return vals.map(([v, l]) => `<option value="${v}"${!isCustom ? sel(v, def) : ""}>${l}</option>`).join("") +
    `<option value="custom"${isCustom ? " selected" : ""}>Custom…</option>`;
}

function trackedHtml(defaults: TrackedDefaults): string {
  const n = nonce();
  const sel = (a: string | number, b: string | number): string => String(a) === String(b) ? " selected" : "";
  const windowOpts = windowOptionsHtml(defaults, "24");
  const intervalOpts = QS.INTERVAL_OPTIONS.map(o => `<option value="${o.key}"${sel(o.key, defaults.interval ?? 60)}>${o.label}</option>`).join("");
  const qid = defaults.queryId != null ? String(defaults.queryId) : "";
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(n)}">
<style>${qsStyles()}</style></head>
<body>
  <h2>Tracked Queries</h2>
  <div class="controls">
    <div class="field"><label for="qid">Query Id</label><input type="number" id="qid" min="1" step="1" style="width:90px" value="${qid}"></div>
    <div class="field"><label for="window">Time window</label><select id="window">${windowOpts}</select></div>
    <div class="field" id="fromField" style="display:none;"><label for="from">From</label><input type="datetime-local" id="from"></div>
    <div class="field" id="toField" style="display:none;"><label for="to">To</label><input type="datetime-local" id="to"></div>
    <div class="field"><label for="tz">Time format</label><select id="tz">
      <option value="local"${(defaults.tz ?? "local") === "local" ? " selected" : ""}>Local</option>
      <option value="utc"${defaults.tz === "utc" ? " selected" : ""}>UTC</option>
    </select></div>
    <div class="field"><label for="interval">Interval</label><select id="interval">${intervalOpts}</select></div>
    <button id="track">Track</button>
  </div>
  <div id="msg"></div>
  <div class="panes">
    <div class="pane" style="flex:1 1 100%"><h3 id="bubbleTitle">Plan summary</h3>
      <div class="bubbleRow">
        <div id="bubbleChart"><p class="hint">Enter a Query Id and click Track.</p></div>
        <div class="legendBox" id="legendBox" style="display:none;"><div class="legendTitle">Plan Id</div><div class="legend" id="legend"></div></div>
      </div>
      <div class="key" id="key" style="display:none;">
        <span><i class="k-dot"></i>Each bubble = a plan in one interval</span>
        <span><i class="k-size"></i>Size = execution count</span>
        <span><i class="k-forced"></i>Green ring = forced plan</span>
        <span>X = time &nbsp;·&nbsp; Y = <em id="keyMetric">metric</em></span>
      </div>
    </div>
  </div>
  <div id="drill" style="display:none;">
    <h3 id="drillTitle"></h3>
    <pre id="queryText"></pre>
    <h3 id="planAreaTitle">Plans<span class="note">Click a plan to open it in another tab.</span></h3>
    <table><thead id="planHead"></thead><tbody id="planBody"></tbody></table>
  </div>
  <div id="tip"></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const PALETTE = ["#4f8cc9","#d18616","#3fb950","#c586c0","#e2c08d","#4ec9b0","#f14c4c","#9cdcfe","#b180d7","#d7ba7d"];
  const DEF = ${JSON.stringify({ start: defaults.start ?? "", end: defaults.end ?? "" })};
  let sumCols = [], sumRows = [], planCols = [], planRows = [], curQuery = null, metricName = "metric";
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function isNum(v){ return v !== null && v !== "" && !isNaN(Number(v)); }
  function pad(n){ return String(n).padStart(2,"0"); }
  function tzMode(){ return $("tz").value; }
  function toUtc(v){ if(!v) return ""; if(tzMode()==="utc") return (v.length===16?v+":00":v.slice(0,19));
    const d=new Date(v); return isNaN(d)?"":d.toISOString().slice(0,19); }
  function utcToInput(u){ if(!u) return ""; const d=new Date(u+"Z"); if(isNaN(d)) return "";
    if(tzMode()==="utc") return u.slice(0,16);
    return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes()); }
  function fmtTime(isoNoZ, opts){ const d=new Date(isoNoZ+"Z"); if(isNaN(d)) return isoNoZ;
    return d.toLocaleString(undefined, Object.assign({ timeZone: tzMode()==="utc"?"UTC":undefined }, opts)); }
  function fmt(v){ if(v>=1e6) return (v/1e6).toFixed(1)+"M"; if(v>=1e3) return (v/1e3).toFixed(1)+"k"; return (Math.round(v*100)/100).toString(); }
  function el(tag,attrs,txt){ const e=document.createElementNS(SVGNS,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); if(txt!=null) e.textContent=txt; return e; }
  function planColor(id){ return PALETTE[Math.abs(Number(id))%PALETTE.length]; }
  function curWindow(){ const v=$("window").value;
    if(v==="custom") return { hours:0, start:toUtc($("from").value), end:toUtc($("to").value) };
    return { hours:Number(v), start:"", end:"" }; }
  function toggleCustom(){ const c=$("window").value==="custom"; $("fromField").style.display=c?"flex":"none"; $("toField").style.display=c?"flex":"none"; }
  function params(){ const w=curWindow();
    return { metric:"duration", agg:"avg", hours:w.hours, start:w.start, end:w.end,
      tz:tzMode(), interval:Number($("interval").value) }; }

  function drawBubbles(){
    const cols=sumCols, srows=sumRows;
    const pi=cols.indexOf("PlanId"), ti=cols.indexOf("IntervalStart"), vi=cols.indexOf("Value"),
          ei=cols.indexOf("Executions"), fi=cols.indexOf("Forced");
    if(!srows.length){ $("bubbleChart").innerHTML='<p class="hint">No interval data for this query in the window.</p>'; $("legendBox").style.display="none"; $("key").style.display="none"; return; }
    const pts=srows.map((r,idx)=>({row:idx,plan:r[pi],t:Date.parse(r[ti]+"Z")||Date.parse(r[ti]),v:Number(r[vi])||0,e:Number(r[ei])||1,forced:String(r[fi])==="1"}));
    const W=760,H=300,padL=54,padB=28,padT=8,padR=10;
    const tMin=Math.min(...pts.map(p=>p.t)), tMax=Math.max(...pts.map(p=>p.t));
    const vMax=Math.max(1,...pts.map(p=>p.v)), eMax=Math.max(1,...pts.map(p=>p.e));
    const tSpan=Math.max(1,tMax-tMin);
    const x=t=>padL+(t-tMin)/tSpan*(W-padL-padR);
    const y=v=>padT+(1-v/vMax)*(H-padT-padB);
    const rOf=e=>3+Math.sqrt(e/eMax)*7;
    const svg=el("svg",{viewBox:"0 0 "+W+" "+H});
    for(let g=0;g<=4;g++){
      const yy=padT+(H-padT-padB)*g/4;
      svg.appendChild(el("line",{class:"grid",x1:padL,y1:yy,x2:W-padR,y2:yy}));
      svg.appendChild(el("text",{class:"tick",x:padL-4,y:yy+3,"text-anchor":"end"},fmt(vMax*(1-g/4))));
    }
    svg.appendChild(el("line",{class:"axis",x1:padL,y1:padT,x2:padL,y2:H-padB}));
    svg.appendChild(el("line",{class:"axis",x1:padL,y1:H-padB,x2:W-padR,y2:H-padB}));
    const tzOpt={timeZone:tzMode()==="utc"?"UTC":undefined,month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"};
    [0,0.25,0.5,0.75,1].forEach(f=>{ const t=tMin+tSpan*f; svg.appendChild(el("text",{class:"tick",x:x(t),y:H-padB+11,"text-anchor":f===1?"end":(f===0?"start":"middle")},new Date(t).toLocaleString(undefined,tzOpt))); });
    pts.forEach(p=>{
      const c=el("circle",{cx:x(p.t),cy:y(p.v),r:rOf(p.e),fill:planColor(p.plan),"fill-opacity":0.85,
        stroke:p.forced?"var(--vscode-charts-green, #3fb950)":"rgba(0,0,0,0.55)","stroke-width":p.forced?2:0.75});
      c.style.cursor="pointer";
      c.addEventListener("mouseenter",ev=>showTip(p.row,ev));
      c.addEventListener("mousemove",moveTip);
      c.addEventListener("mouseleave",hideTip);
      c.addEventListener("click",()=>{ hideTip(); vscode.postMessage({type:"openPlan",planId:Number(p.plan)}); });
      svg.appendChild(c);
    });
    $("bubbleChart").replaceChildren(svg);
    $("key").style.display="flex"; $("keyMetric").textContent=metricName;
    const plans=[...new Set(pts.map(p=>p.plan))];
    $("legendBox").style.display="block";
    $("legend").innerHTML=plans.map(p=>{ const forced=pts.some(q=>q.plan===p&&q.forced); return '<span data-plan="'+esc(p)+'"><i style="background:'+planColor(p)+'"></i>'+esc(p)+(forced?" ★":"")+"</span>"; }).join("");
    [...$("legend").querySelectorAll("[data-plan]")].forEach(s=>s.addEventListener("click",()=>vscode.postMessage({type:"openPlan",planId:Number(s.dataset.plan)})));
  }
  function showTip(rowIdx, ev){
    const r=sumRows[rowIdx]; if(!r) return;
    const get=name=>{ const i=sumCols.indexOf(name); return i<0?"":(r[i]===null?"":r[i]); };
    const forced=String(get("Forced"))==="1";
    const fields=[
      ["Plan Id",get("PlanId")],
      ["Execution Type",get("ExecutionType")],
      ["Plan Forced",forced?"Yes":"No"],
      ["Interval Start",fmtTime(get("IntervalStart"),{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})],
      ["Interval End",fmtTime(get("IntervalEnd"),{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})],
      ["Execution Count",get("Executions")],
      ["Total "+metricName,get("Total")],
      ["Avg "+metricName,get("Avg")],
      ["Min "+metricName,get("Min")],
      ["Max "+metricName,get("Max")],
      ["Std Dev "+metricName,get("StdDev")],
    ];
    $("tip").innerHTML="<table><tbody>"+fields.map(f=>"<tr><td>"+esc(f[0])+"</td><td>"+esc(f[1])+"</td></tr>").join("")+"</tbody></table>";
    $("tip").style.display="block"; moveTip(ev);
  }
  function moveTip(ev){
    const tip=$("tip"); if(tip.style.display!=="block") return;
    const pad=14, w=tip.offsetWidth, h=tip.offsetHeight;
    let left=ev.clientX+pad, top=ev.clientY+pad;
    if(left+w>window.innerWidth) left=ev.clientX-pad-w;
    if(top+h>window.innerHeight) top=ev.clientY-pad-h;
    tip.style.left=Math.max(4,left)+"px"; tip.style.top=Math.max(4,top)+"px";
  }
  function hideTip(){ $("tip").style.display="none"; }
  function renderPlans(){
    $("planHead").innerHTML="<tr>"+planCols.map(c=>"<th>"+esc(c)+"</th>").join("")+"<th>Action</th></tr>";
    const fIdx=planCols.indexOf("Forced"), pIdx=planCols.indexOf("PlanId");
    $("planBody").innerHTML=planRows.map(r=>{
      const forced=String(r[fIdx])==="1", planId=r[pIdx];
      const cells=r.map((v,i)=>i===fIdx?(forced?'<td class="forced">Yes</td>':"<td>No</td>")
        :(v===null?"<td></td>":"<td"+(isNum(v)?' class="num"':"")+">"+esc(v)+"</td>")).join("");
      const force=forced
        ? '<button class="small secondary" data-unforce="'+esc(planId)+'">Unforce</button>'
        : '<button class="small" data-force="'+esc(planId)+'">Force</button>';
      const open='<button class="small secondary" data-open="'+esc(planId)+'">Open Plan</button>';
      return '<tr data-plan="'+esc(planId)+'">'+cells+"<td>"+force+" "+open+"</td></tr>";
    }).join("");
    const stop=(b,type,key)=>b.addEventListener("click",ev=>{ ev.stopPropagation();
      vscode.postMessage({type,queryId:Number(curQuery),planId:Number(b.dataset[key]),...params()}); });
    [...$("planBody").querySelectorAll("[data-force]")].forEach(b=>stop(b,"force","force"));
    [...$("planBody").querySelectorAll("[data-unforce]")].forEach(b=>stop(b,"unforce","unforce"));
    [...$("planBody").querySelectorAll("[data-open]")].forEach(b=>b.addEventListener("click",ev=>{
      ev.stopPropagation(); vscode.postMessage({type:"openPlan",planId:Number(b.dataset.open)}); }));
    [...$("planBody").querySelectorAll("tr")].forEach(tr=>tr.addEventListener("click",()=>
      vscode.postMessage({type:"openPlan",planId:Number(tr.dataset.plan)})));
  }
  function track(){
    const q=Number($("qid").value);
    if(!q){ $("msg").innerHTML='<p class="hint">Enter a Query Id to track.</p>'; return; }
    curQuery=q; $("msg").innerHTML="";
    vscode.postMessage({type:"track",queryId:q,...params()});
  }
  $("track").addEventListener("click", track);
  $("qid").addEventListener("keydown", e=>{ if(e.key==="Enter") track(); });
  $("window").addEventListener("change", ()=>{ toggleCustom(); });
  ["interval","tz"].forEach(id=>$(id).addEventListener("change",()=>{ if(curQuery!=null) track(); }));
  window.addEventListener("message", e=>{
    const m=e.data;
    if(m.type==="drill"){
      $("drillTitle").innerHTML="Query "+esc(m.queryId)+'<span class="note">Query text is retrieved from the stored query text.</span>';
      $("queryText").textContent=m.text;
      $("bubbleTitle").textContent="Plan summary — Query "+m.queryId;
      metricName=m.metricName||"metric";
      sumCols=m.summary.columns; sumRows=m.summary.rows; drawBubbles();
      planCols=m.plans.columns; planRows=m.plans.rows; renderPlans();
      $("drill").style.display="block";
    }
    else if(m.type==="notfound"){ $("msg").innerHTML='<p class="hint">No data found for query '+esc(m.queryId)+' in this window.</p>';
      $("bubbleChart").innerHTML='<p class="hint">No data.</p>'; $("legendBox").style.display="none"; $("key").style.display="none"; $("drill").style.display="none"; }
    else if(m.type==="disabled"){ $("msg").innerHTML='<p class="hint">Query Store is not enabled for read (state: '+esc(m.state)+').</p>'; }
    else if(m.type==="error"){ $("msg").innerHTML='<p class="error">'+esc(m.message)+"</p>"; }
  });
  if(DEF.start && DEF.end){ $("from").value=utcToInput(DEF.start); $("to").value=utcToInput(DEF.end); }
  toggleCustom();
  vscode.postMessage({type:"ready"${defaults.queryId != null ? `,queryId:${defaults.queryId}` : ""}});
  ${defaults.queryId != null ? `curQuery=${defaults.queryId};` : ""}
</script>
</body></html>`;
}

/* ---------- Overall Resource Consumption ---------- */

interface OverallDefaults {
  hours?: number;
  start?: string;
  end?: string;
  tz?: string;
  interval?: number;
}

export function openQueryStoreOverall(run: QueryRunner, state: vscode.Memento): void {
  const stateKey = "qs.defaults.overall";
  const defaults = state.get<OverallDefaults>(stateKey, {});
  const panel = vscode.window.createWebviewPanel(
    "ssms.qsOverall",
    "Query Store — Overall Resource Consumption",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = overallHtml(defaults);
  const post = (m: unknown): void => void panel.webview.postMessage(m);

  // Map an Overall chart metric to the Top Consumers ranked-metric key for drill-through.
  const drillMetric: Record<string, string> = {
    Duration: "duration",
    Cpu: "cpu",
    LogicalReads: "logical_reads",
    Executions: "duration",
  };

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; hours?: number; start?: string; end?: string; tz?: string; interval?: number; metricKey?: string }) => {
      try {
        const hours = msg.hours ?? defaults.hours ?? 720;
        const interval = msg.interval ?? defaults.interval ?? 1440;
        const tz = msg.tz ?? defaults.tz ?? "local";
        const win: QS.TimeWindow = { hours, start: msg.start || undefined, end: msg.end || undefined };

        if (msg.type === "ready" && !(await guard(run, post))) return;
        if (msg.type === "drill" && msg.start && msg.end) {
          // Open Top Resource Consuming Queries scoped to the clicked bucket's window.
          openQueryStoreTopConsumers(run, state, {
            metric: drillMetric[msg.metricKey ?? "Duration"] ?? "duration",
            agg: "total",
            hours: 0,
            start: msg.start,
            end: msg.end,
            tz,
            interval,
          });
          return;
        }
        if (msg.type === "apply" || msg.type === "ready") {
          await state.update(stateKey, { hours, start: win.start, end: win.end, tz, interval });
          post({
            type: "rows",
            metrics: QS.OVERALL_METRICS,
            ...serialize(await run(QS.overallConsumptionQuery(win, interval))),
          });
        }
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}

function overallHtml(defaults: OverallDefaults): string {
  const n = nonce();
  const sel = (a: string | number, b: string | number): string => String(a) === String(b) ? " selected" : "";
  const windowOpts = windowOptionsHtml(defaults, "720");
  const intervalOpts = QS.INTERVAL_OPTIONS.map(o => `<option value="${o.key}"${sel(o.key, defaults.interval ?? 1440)}>${o.label}</option>`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(n)}">
<style>${qsStyles()}
.grid4 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
@media (max-width: 760px){ .grid4 { grid-template-columns:1fr; } }
.chartPane { border:1px solid var(--vscode-panel-border); border-radius:4px; background:var(--vscode-editorWidget-background); padding:6px 8px; }
.chartPane h3 { margin:2px 0 4px; font-size:0.9em; font-weight:600; }
</style></head>
<body>
  <h2>Overall Resource Consumption<span class="note">Click a bar to see the top queries for that time bucket.</span></h2>
  <div class="controls">
    <div class="field"><label for="window">Time window</label><select id="window">${windowOpts}</select></div>
    <div class="field" id="fromField" style="display:none;"><label for="from">From</label><input type="datetime-local" id="from"></div>
    <div class="field" id="toField" style="display:none;"><label for="to">To</label><input type="datetime-local" id="to"></div>
    <div class="field"><label for="tz">Time format</label><select id="tz">
      <option value="local"${(defaults.tz ?? "local") === "local" ? " selected" : ""}>Local</option>
      <option value="utc"${defaults.tz === "utc" ? " selected" : ""}>UTC</option>
    </select></div>
    <div class="field"><label for="interval">Bucket</label><select id="interval">${intervalOpts}</select></div>
    <button id="apply">Refresh</button>
  </div>
  <div id="msg"></div>
  <div class="grid4" id="charts"></div>
  <div id="tip"></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const DEF = ${JSON.stringify({ start: defaults.start ?? "", end: defaults.end ?? "" })};
  let columns = [], rows = [], metrics = [];
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function pad(n){ return String(n).padStart(2,"0"); }
  function tzMode(){ return $("tz").value; }
  function toUtc(v){ if(!v) return ""; if(tzMode()==="utc") return (v.length===16?v+":00":v.slice(0,19));
    const d=new Date(v); return isNaN(d)?"":d.toISOString().slice(0,19); }
  function utcToInput(u){ if(!u) return ""; const d=new Date(u+"Z"); if(isNaN(d)) return "";
    if(tzMode()==="utc") return u.slice(0,16);
    return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes()); }
  function fmt(v){ if(v>=1e9) return (v/1e9).toFixed(1)+"B"; if(v>=1e6) return (v/1e6).toFixed(1)+"M"; if(v>=1e3) return (v/1e3).toFixed(1)+"k"; return (Math.round(v*100)/100).toString(); }
  function el(tag,attrs,txt){ const e=document.createElementNS(SVGNS,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); if(txt!=null) e.textContent=txt; return e; }
  function curWindow(){ const v=$("window").value;
    if(v==="custom") return { hours:0, start:toUtc($("from").value), end:toUtc($("to").value) };
    return { hours:Number(v), start:"", end:"" }; }
  function toggleCustom(){ const c=$("window").value==="custom"; $("fromField").style.display=c?"flex":"none"; $("toField").style.display=c?"flex":"none"; }
  function params(){ const w=curWindow(); return { hours:w.hours, start:w.start, end:w.end, tz:tzMode(), interval:Number($("interval").value) }; }

  function tipFor(bucketStart, label, val){
    const d=new Date(bucketStart+"Z");
    const ts=isNaN(d)?bucketStart:d.toLocaleString(undefined,{timeZone:tzMode()==="utc"?"UTC":undefined,year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
    return "<table><tbody><tr><td>Bucket</td><td>"+esc(ts)+"</td></tr><tr><td>"+esc(label)+"</td><td>"+esc(val)+"</td></tr></tbody></table>";
  }
  function moveTip(ev){
    const tip=$("tip"); if(tip.style.display!=="block") return;
    const pad=14, w=tip.offsetWidth, h=tip.offsetHeight;
    let left=ev.clientX+pad, top=ev.clientY+pad;
    if(left+w>window.innerWidth) left=ev.clientX-pad-w;
    if(top+h>window.innerHeight) top=ev.clientY-pad-h;
    tip.style.left=Math.max(4,left)+"px"; tip.style.top=Math.max(4,top)+"px";
  }
  function drawChart(metric){
    const bi=columns.indexOf("BucketStart"), mi=columns.indexOf(metric.key);
    const data=rows.map(r=>({b:r[bi], v:Number(r[mi])||0}));
    const W=440,H=200,padL=46,padB=30,padT=8,padR=8;
    const max=Math.max(1,...data.map(d=>d.v));
    const svg=el("svg",{viewBox:"0 0 "+W+" "+H});
    for(let g=0;g<=4;g++){
      const y=padT+(H-padT-padB)*g/4;
      svg.appendChild(el("line",{class:"grid",x1:padL,y1:y,x2:W-padR,y2:y}));
      svg.appendChild(el("text",{class:"tick",x:padL-4,y:y+3,"text-anchor":"end"},fmt(max*(1-g/4))));
    }
    svg.appendChild(el("line",{class:"axis",x1:padL,y1:padT,x2:padL,y2:H-padB}));
    svg.appendChild(el("line",{class:"axis",x1:padL,y1:H-padB,x2:W-padR,y2:H-padB}));
    const bw=(W-padL-padR)/Math.max(1,data.length);
    const labelEvery=Math.ceil(data.length/6);
    data.forEach((d,i)=>{
      const h=(d.v/max)*(H-padT-padB);
      const x=padL+i*bw+bw*0.12, w=bw*0.76, y=H-padB-h;
      const rect=el("rect",{x,y,width:w,height:h,fill:"var(--vscode-charts-blue, #4f8cc9)",style:"cursor:pointer"});
      // Pad the hit area down to the axis so thin bars are still easy to click.
      const hit=el("rect",{x,y:padT,width:w,height:H-padT-padB,fill:"transparent",style:"cursor:pointer"});
      const enter=ev=>{ $("tip").innerHTML=tipFor(d.b,metric.label,fmt(d.v)); $("tip").style.display="block"; moveTip(ev); };
      const leave=()=>{$("tip").style.display="none";};
      const click=()=>{ $("tip").style.display="none";
        const endUtc=new Date((Date.parse(d.b+"Z"))+Number($("interval").value)*60000).toISOString().slice(0,19);
        vscode.postMessage({type:"drill",metricKey:metric.key,start:d.b,end:endUtc}); };
      [rect,hit].forEach(node=>{ node.addEventListener("mouseenter",enter); node.addEventListener("mousemove",moveTip); node.addEventListener("mouseleave",leave); node.addEventListener("click",click); });
      svg.appendChild(hit);
      svg.appendChild(rect);
      if(i%labelEvery===0){ const dt=new Date(d.b+"Z");
        const lbl=tzMode()==="utc"?(dt.getUTCMonth()+1)+"/"+dt.getUTCDate():(dt.getMonth()+1)+"/"+dt.getDate();
        svg.appendChild(el("text",{class:"tick",x:x+w/2,y:H-padB+11,"text-anchor":"middle"},lbl)); }
    });
    return svg;
  }
  function render(){
    const host=$("charts"); host.replaceChildren();
    if(rows.length===0){ host.innerHTML='<p class="hint">No Query Store activity in the selected window.</p>'; return; }
    metrics.forEach(metric=>{
      const pane=document.createElement("div"); pane.className="chartPane";
      const h=document.createElement("h3"); h.textContent=metric.label; pane.appendChild(h);
      pane.appendChild(drawChart(metric));
      host.appendChild(pane);
    });
  }
  const applyIfReady=()=>{ const v=$("window").value; if(v!=="custom" || ($("from").value && $("to").value)) vscode.postMessage({type:"apply",...params()}); };
  $("apply").addEventListener("click", applyIfReady);
  $("window").addEventListener("change", ()=>{ toggleCustom(); applyIfReady(); });
  ["from","to","tz","interval"].forEach(id=>$(id).addEventListener("change", applyIfReady));
  window.addEventListener("message", e=>{
    const m=e.data;
    if(m.type==="rows"){ columns=m.columns; rows=m.rows; metrics=m.metrics; $("msg").innerHTML=""; render(); }
    else if(m.type==="disabled"){ $("msg").innerHTML='<p class="hint">Query Store is not enabled for read (state: '+esc(m.state)+').</p>'; }
    else if(m.type==="error"){ $("msg").innerHTML='<p class="error">'+esc(m.message)+"</p>"; }
  });
  if(DEF.start && DEF.end){ $("from").value=utcToInput(DEF.start); $("to").value=utcToInput(DEF.end); }
  toggleCustom();
  vscode.postMessage({type:"ready",...params()});
</script>
</body></html>`;
}
