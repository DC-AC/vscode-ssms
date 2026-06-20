import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import type { SimpleExecuteResult } from "vscode-mssql";
import * as QS from "../queries/queryStore";
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

interface RankedConfig {
  /** Stable key for persisting this report's default settings. */
  key: string;
  title: string;
  metrics: Array<{ key: string; label: string }>;
  /** Show the SSMS "Based on" statistic dropdown. */
  hasAggregate: boolean;
  /** Statistic options for the "Based on" dropdown (defaults to QS.AGG_OPTIONS). */
  aggOptions?: Array<{ key: string; label: string }>;
  /** Default statistic key when none is persisted (defaults to "avg"). */
  aggDefault?: string;
  /** Show the "Minimum Execution Count (Recent)" filter. */
  hasMinExec: boolean;
  /** Column in the bar query whose value drives the bars (e.g. "Value", "Regression"). */
  valueCol: string;
  loadQuery: (metric: string, agg: string, win: QS.TimeWindow, minExec: number) => string;
  valueLabel: (metric: string, agg: string) => string;
}

interface ReportDefaults {
  metric?: string;
  agg?: string;
  hours?: number;
  start?: string;
  end?: string;
  tz?: string;
  interval?: number;
  minExec?: number;
}

/** Top Resource Consuming Queries: ranked by a metric + statistic over a window.
 *  `initial` opens the report seeded to a specific window (e.g. drilled from the
 *  Overall Resource Consumption report) without overwriting the user's saved defaults. */
export function openQueryStoreTopConsumers(
  run: QueryRunner,
  state: vscode.Memento,
  initial?: ReportDefaults
): void {
  openRankedReport(run, state, {
    key: "top",
    title: "Top Resource Consuming Queries",
    metrics: QS.METRIC_OPTIONS,
    hasAggregate: true,
    hasMinExec: false,
    valueCol: "Value",
    loadQuery: (metric, agg, win) => QS.topConsumersQuery(metric, agg, win),
    valueLabel: (metric, agg) => `${QS.aggLabel(agg)} ${QS.metricLabel(metric)}`,
  }, initial);
}

/** Regressed Queries: recent window worse than the preceding baseline. */
export function openQueryStoreRegressed(run: QueryRunner, state: vscode.Memento): void {
  openRankedReport(run, state, {
    key: "regressed",
    title: "Regressed Queries",
    metrics: QS.METRIC_OPTIONS,
    hasAggregate: true,
    hasMinExec: true,
    valueCol: "Regression",
    loadQuery: (metric, agg, win, minExec) => QS.regressedQueriesQuery(metric, agg, win, minExec),
    valueLabel: (metric, agg) => `${QS.aggLabel(agg)} ${QS.metricLabel(metric)} regression`,
  });
}

/** Queries With High Variation: ranked by how much a metric varies over the window. */
export function openQueryStoreHighVariation(run: QueryRunner, state: vscode.Memento): void {
  openRankedReport(run, state, {
    key: "highvar",
    title: "Queries With High Variation",
    metrics: QS.METRIC_OPTIONS,
    hasAggregate: true,
    aggOptions: QS.VARIATION_AGG_OPTIONS,
    aggDefault: "variation",
    hasMinExec: true,
    valueCol: "Variation",
    loadQuery: (metric, agg, win, minExec) => QS.highVariationQuery(metric, agg, win, minExec),
    valueLabel: (metric, agg) => `${QS.variationAggLabel(agg)} ${QS.metricLabel(metric)}`,
  });
}

function openRankedReport(run: QueryRunner, state: vscode.Memento, config: RankedConfig, initial?: ReportDefaults): void {
  const stateKey = `qs.defaults.${config.key}`;
  // When opened as a drill-through (initial set), seed from `initial` and don't
  // persist — so the user's normal saved defaults for this report stay intact.
  const persist = !initial;
  const defaults = initial ?? state.get<ReportDefaults>(stateKey, {});
  const panel = vscode.window.createWebviewPanel(
    "ssms.qsRanked",
    `Query Store — ${config.title}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  // In drill mode the window/metric come fixed from the parent report, so hide
  // the filter bar (the seeded inputs stay in the DOM for params()).
  panel.webview.html = rankedHtml(config, defaults, !persist);
  const post = (m: unknown): void => void panel.webview.postMessage(m);

  panel.webview.onDidReceiveMessage(
    async (msg: {
      type: string;
      metric?: string;
      agg?: string;
      hours?: number;
      start?: string;
      end?: string;
      tz?: string;
      interval?: number;
      minExec?: number;
      queryId?: number;
      planId?: number;
    }) => {
      try {
        const hours = msg.hours ?? 24;
        const interval = msg.interval ?? 60;
        const minExec = msg.minExec ?? 1;
        const tz = msg.tz ?? "local";
        const metric = msg.metric ?? config.metrics[0]?.key ?? "duration";
        const agg = config.hasAggregate ? msg.agg ?? config.aggDefault ?? "avg" : "avg";
        const win: QS.TimeWindow = { hours, start: msg.start || undefined, end: msg.end || undefined };
        // Remember this report's settings as the defaults for next time.
        if (persist && (msg.metric != null || msg.hours != null || msg.interval != null || msg.minExec != null || msg.tz != null)) {
          await state.update(stateKey, { metric, agg, hours, start: win.start, end: win.end, tz, interval, minExec });
        }
        if (msg.type === "ready") {
          const status = await run(QS.QS_STATUS);
          const qsState = status.rows[0]?.[0]?.displayValue ?? "OFF";
          if (qsState !== "READ_WRITE" && qsState !== "READ_ONLY") {
            post({ type: "disabled", state: qsState });
            return;
          }
        }
        if (msg.type === "ready" || msg.type === "apply") {
          const result = await run(config.loadQuery(metric, agg, win, minExec));
          post({ type: "rows", valueLabel: config.valueLabel(metric, agg), ...serialize(result) });
        } else if (msg.type === "drill" && msg.queryId != null) {
          await sendQueryDrill(run, post, msg.queryId, metric, agg, win, interval);
        } else if (msg.type === "force" && msg.queryId != null && msg.planId != null) {
          await run(QS.forcePlanStatement(msg.queryId, msg.planId));
          await sendQueryDrill(run, post, msg.queryId, metric, agg, win, interval);
        } else if (msg.type === "unforce" && msg.queryId != null && msg.planId != null) {
          await run(QS.unforcePlanStatement(msg.queryId, msg.planId));
          await sendQueryDrill(run, post, msg.queryId, metric, agg, win, interval);
        } else if (msg.type === "openPlan" && msg.planId != null) {
          await openPlanXml(run, msg.planId);
        }
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}

async function sendQueryDrill(
  run: QueryRunner,
  post: (m: unknown) => void,
  queryId: number,
  metric: string,
  agg: string,
  win: QS.TimeWindow,
  interval: number
): Promise<void> {
  const text = await run(QS.queryTextQuery(queryId));
  const summary = await run(QS.planSummaryQuery(queryId, metric, agg, win, interval));
  const plans = await run(QS.queryPlansQuery(queryId, win));
  post({
    type: "drill",
    queryId,
    metricName: QS.metricLabel(metric),
    text: text.rows[0]?.[0]?.displayValue ?? "",
    summary: serialize(summary),
    plans: serialize(plans),
  });
}

/** Fetch the showplan XML and open it in the mssql graphical plan viewer. */
export async function openPlanXml(run: QueryRunner, planId: number): Promise<void> {
  const result = await run(QS.planXmlQuery(planId));
  // Chunks p1..p4 are concatenated to work around the 65 536-char per-column limit.
  const row = result.rows[0];
  const xml = [0, 1, 2, 3].map(i => row?.[i]?.displayValue ?? "").join("").trimEnd() || null;
  if (!xml) {
    vscode.window.showWarningMessage(`No stored plan XML for plan ${planId}.`);
    return;
  }
  const file = path.join(os.tmpdir(), `qs_plan_${planId}.sqlplan`);
  await fs.writeFile(file, xml, "utf8");
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
}

function nonce(): string {
  return Array.from({ length: 16 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
      Math.floor(Math.random() * 62)
    )
  ).join("");
}

/** Shared chart + sortable table + drill styles for QS reports. */
export function qsStyles(): string {
  return `
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px 24px; }
  h2 { font-weight: 600; margin: 12px 0 6px; }
  h3 { font-weight: 600; margin: 14px 0 6px; font-size: 0.95em; }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: end;
              padding: 10px; margin-bottom: 10px;
              background: var(--vscode-editorWidget-background);
              border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .field { display: flex; flex-direction: column; gap: 3px; }
  .field label { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  select, button, input { font-family: inherit; font-size: 13px; padding: 3px 6px;
           color: var(--vscode-input-foreground); background: var(--vscode-input-background);
           border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  input[type=number] { width: 70px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; padding: 4px 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.small { padding: 1px 8px; font-size: 0.85em; }
  .panes { display: flex; flex-wrap: wrap; gap: 12px; align-items: stretch; }
  .pane { flex: 1; min-width: 340px; border: 1px solid var(--vscode-panel-border);
          border-radius: 4px; background: var(--vscode-editorWidget-background); padding: 6px 8px; }
  .pane h3 { margin: 2px 0 4px; }
  svg { width: 100%; height: auto; display: block; }
  .axis { stroke: var(--vscode-panel-border); stroke-width: 1; }
  .grid { stroke: var(--vscode-panel-border); stroke-width: 0.5; opacity: 0.5; }
  .tick { fill: var(--vscode-descriptionForeground); font-size: 9px; }
  .bar { cursor: pointer; }
  .bar.sel { stroke: var(--vscode-focusBorder); stroke-width: 1.5; }
  .bubbleRow { display: flex; gap: 8px; align-items: flex-start; }
  .bubbleRow #bubbleChart { flex: 1; min-width: 0; }
  .legendBox { flex: 0 0 auto; min-width: 88px; border: 1px solid var(--vscode-panel-border);
               border-radius: 3px; padding: 5px 8px; align-self: center; }
  .legendTitle { font-size: 11px; font-weight: 600; margin-bottom: 4px; }
  .legend { display: flex; flex-direction: column; gap: 5px; font-size: 11px; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  .legend i { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  #tip { position: fixed; display: none; z-index: 100; pointer-events: none;
         background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
         color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
         border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
         border-radius: 4px; padding: 6px 8px; font-size: 11px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); max-width: 280px; }
  #tip table { width: auto; }
  #tip td { border-bottom: none; padding: 1px 6px; white-space: nowrap; }
  #tip td:first-child { color: var(--vscode-descriptionForeground); }
  #tip td:last-child { text-align: right; }
  .key { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; padding-top: 6px;
         border-top: 1px solid var(--vscode-panel-border); font-size: 11px; color: var(--vscode-descriptionForeground); }
  .key span { display: inline-flex; align-items: center; gap: 5px; }
  .key i { display: inline-block; }
  .key i.k-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-charts-blue, #4f8cc9); opacity: 0.65; }
  .key i.k-size { width: 14px; height: 14px; border-radius: 50%; background: var(--vscode-charts-blue, #4f8cc9); opacity: 0.4; }
  .key i.k-forced { width: 10px; height: 10px; border-radius: 50%; background: transparent;
                    border: 2px solid var(--vscode-charts-green, #3fb950); }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 2px solid var(--vscode-panel-border); cursor: pointer; user-select: none; }
  th .arrow { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  tbody tr { cursor: pointer; }
  tbody tr.sel td, tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.num { text-align: right; }
  pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 3px;
        font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.4;
        max-height: 6em; overflow: auto; margin: 4px 0; }
  .note { color: var(--vscode-descriptionForeground); font-size: 0.82em; font-weight: 400; margin-left: 8px; }
  .forced { color: var(--vscode-charts-green, #3fb950); font-weight: 600; }
  .error { color: var(--vscode-errorForeground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }`;
}

function rankedHtml(config: RankedConfig, defaults: ReportDefaults, hideControls = false): string {
  const n = nonce();
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${n}'`].join("; ");
  const sel = (a: string | number, b: string | number): string => (String(a) === String(b) ? " selected" : "");
  const metricOpts = config.metrics
    .map((m) => `<option value="${m.key}"${sel(m.key, defaults.metric ?? "")}>${m.label}</option>`)
    .join("");
  const aggDefault = defaults.agg ?? config.aggDefault ?? "avg";
  const aggOpts = (config.aggOptions ?? QS.AGG_OPTIONS).map(
    (a) => `<option value="${a.key}"${sel(a.key, aggDefault)}>${a.label}</option>`
  ).join("");
  const aggField = config.hasAggregate
    ? `<div class="field"><label for="agg">Based on</label><select id="agg">${aggOpts}</select></div>`
    : "";
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
  const minExecDefault = defaults.minExec != null ? defaults.minExec : 1;
  const minExecField = config.hasMinExec
    ? `<div class="field"><label for="minExec">Min exec count (recent)</label><input type="number" id="minExec" min="0" step="1" value="${minExecDefault}"></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${qsStyles()}</style>
</head>
<body>
  <h2>${config.title}</h2>
  <div class="controls"${hideControls ? ' style="display:none"' : ""}>
    <div class="field"><label for="metric">Metric</label><select id="metric">${metricOpts}</select></div>
    ${aggField}
    <div class="field"><label for="window">Time window</label><select id="window">${windowOpts}</select></div>
    <div class="field" id="fromField" style="display:none;"><label for="from">From</label><input type="datetime-local" id="from"></div>
    <div class="field" id="toField" style="display:none;"><label for="to">To</label><input type="datetime-local" id="to"></div>
    <div class="field"><label for="tz">Time format</label><select id="tz">
      <option value="local"${(defaults.tz ?? "local") === "local" ? " selected" : ""}>Local</option>
      <option value="utc"${defaults.tz === "utc" ? " selected" : ""}>UTC</option>
    </select></div>
    <div class="field"><label for="interval">Interval</label><select id="interval">${intervalOpts}</select></div>
    ${minExecField}
    <button id="apply">Refresh</button>
  </div>
  <div id="msg"></div>
  <div class="panes">
    <div class="pane"><h3 id="barTitle">Queries</h3><div id="barChart"></div></div>
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
      </div></div>
  </div>
  <div style="margin:10px 0 4px;"><button id="toggleList" class="secondary small">Show query list</button></div>
  <div id="listWrap" style="display:none;"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
  <div id="drill" style="display:none;">
    <h3 id="drillTitle"></h3>
    <pre id="queryText"></pre>
    <h3 id="planAreaTitle">Plans<span class="note">Click a plan to open it in another tab.</span></h3>
    <table><thead id="planHead"></thead><tbody id="planBody"></tbody></table>
  </div>
  <div id="tip"></div>
<script nonce="${n}">
  const VALUE_COL = ${JSON.stringify(config.valueCol)};
  const HAS_AGG = ${config.hasAggregate ? "true" : "false"};
  const HAS_MINEXEC = ${config.hasMinExec ? "true" : "false"};
  const DEF = ${JSON.stringify({ start: defaults.start ?? "", end: defaults.end ?? "" })};
  const SVGNS = "http://www.w3.org/2000/svg";
  const PALETTE = ["#4f8cc9","#d18616","#3fb950","#c586c0","#e2c08d","#4ec9b0","#f14c4c","#9cdcfe","#b180d7","#d7ba7d"];
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let columns = [], rows = [], valueLabel = "", sortCol = -1, sortDir = 1, selected = null;
  let planCols = [], planRows = [], curQuery = null, metricName = "metric";
  let sumCols = [], sumRows = [];
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function isNum(v){ return v !== null && v !== "" && !isNaN(Number(v)); }
  function pad(n){ return String(n).padStart(2, "0"); }
  function tzMode(){ return $("tz").value; }
  // datetime-local input (wall clock in the chosen tz) -> UTC ISO (no Z).
  function toUtc(v){ if (!v) return ""; if (tzMode() === "utc") return (v.length === 16 ? v + ":00" : v.slice(0, 19));
    const d = new Date(v); return isNaN(d) ? "" : d.toISOString().slice(0, 19); }
  // UTC ISO -> datetime-local input value in the chosen tz.
  function utcToInput(u){ if (!u) return ""; const d = new Date(u + "Z"); if (isNaN(d)) return "";
    if (tzMode() === "utc") return u.slice(0, 16);
    return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  // UTC ISO (from SQL, no Z) -> display string in the chosen tz.
  function fmtTime(isoNoZ, opts){ const d = new Date(isoNoZ + "Z"); if (isNaN(d)) return isoNoZ;
    return d.toLocaleString(undefined, Object.assign({ timeZone: tzMode() === "utc" ? "UTC" : undefined }, opts)); }
  function curWindow(){ const v = $("window").value;
    if (v === "custom") return { hours: 0, start: toUtc($("from").value), end: toUtc($("to").value) };
    return { hours: Number(v), start: "", end: "" }; }
  function params(){ const w = curWindow();
    return { metric: $("metric").value, agg: HAS_AGG ? $("agg").value : "avg", hours: w.hours, start: w.start, end: w.end, tz: tzMode(),
      interval: Number($("interval").value), minExec: HAS_MINEXEC ? Number($("minExec").value) : 1 }; }
  function customReady(){ return $("window").value !== "custom" || ($("from").value && $("to").value); }
  function toggleCustom(){ const c = $("window").value === "custom"; $("fromField").style.display = c ? "flex" : "none"; $("toField").style.display = c ? "flex" : "none"; }
  const idIdx = () => columns.indexOf("QueryId");
  const valIdx = () => columns.indexOf(VALUE_COL);
  function el(tag, attrs, txt){ const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (txt != null) e.textContent = txt; return e; }
  function planColor(id){ return PALETTE[Math.abs(Number(id)) % PALETTE.length]; }

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

  /* ---- vertical bar chart ---- */
  function drawBars() {
    $("barTitle").textContent = valueLabel || "Queries";
    const W = 460, H = 260, padL = 48, padB = 34, padT = 8, padR = 8;
    const mi = valIdx(), qi = idIdx();
    const data = rows.slice(0, 25);
    const max = Math.max(1, ...data.map(r => Math.abs(Number(r[mi])) || 0));
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H });
    // y grid + ticks
    for (let g = 0; g <= 4; g++) {
      const y = padT + (H - padT - padB) * g / 4;
      svg.appendChild(el("line", { class: "grid", x1: padL, y1: y, x2: W - padR, y2: y }));
      svg.appendChild(el("text", { class: "tick", x: padL - 4, y: y + 3, "text-anchor": "end" }, fmt(max * (1 - g / 4))));
    }
    svg.appendChild(el("line", { class: "axis", x1: padL, y1: padT, x2: padL, y2: H - padB }));
    svg.appendChild(el("line", { class: "axis", x1: padL, y1: H - padB, x2: W - padR, y2: H - padB }));
    const bw = (W - padL - padR) / Math.max(1, data.length);
    data.forEach((r, i) => {
      const val = Math.abs(Number(r[mi])) || 0, qid = r[qi];
      const h = (val / max) * (H - padT - padB);
      const x = padL + i * bw + bw * 0.15, w = bw * 0.7, y = H - padB - h;
      const rect = el("rect", { class: "bar" + (qid === selected ? " sel" : ""), x, y, width: w, height: h,
        fill: qid === selected ? "var(--vscode-charts-orange, #d18616)" : "var(--vscode-charts-blue, #4f8cc9)" });
      rect.addEventListener("click", () => drill(qid));
      const t = el("title", {}, "Q" + qid + ": " + r[mi]); rect.appendChild(t);
      svg.appendChild(rect);
      if (bw > 14) svg.appendChild(el("text", { class: "tick", x: x + w / 2, y: H - padB + 11, "text-anchor": "middle", transform: "rotate(45 " + (x + w / 2) + " " + (H - padB + 11) + ")" }, String(qid)));
    });
    $("barChart").replaceChildren(svg);
  }
  function fmt(v){ if (v >= 1e6) return (v/1e6).toFixed(1)+"M"; if (v >= 1e3) return (v/1e3).toFixed(1)+"k"; return (Math.round(v*100)/100).toString(); }

  /* ---- plan-summary bubble chart ---- */
  function drawBubbles() {
    const cols = sumCols, srows = sumRows;
    const pi = cols.indexOf("PlanId"), ti = cols.indexOf("IntervalStart"), vi = cols.indexOf("Value"),
          ei = cols.indexOf("Executions"), fi = cols.indexOf("Forced");
    if (!srows.length) { $("bubbleChart").innerHTML = '<p class="hint">No interval data for this query in the window.</p>'; $("legendBox").style.display = "none"; return; }
    const pts = srows.map((r, idx) => ({ row: idx, plan: r[pi], t: Date.parse(r[ti] + "Z") || Date.parse(r[ti]), v: Number(r[vi]) || 0, e: Number(r[ei]) || 1, forced: String(r[fi]) === "1" }));
    const W = 520, H = 260, padL = 50, padB = 28, padT = 8, padR = 10;
    const tMin = Math.min(...pts.map(p => p.t)), tMax = Math.max(...pts.map(p => p.t));
    const vMax = Math.max(1, ...pts.map(p => p.v)), eMax = Math.max(1, ...pts.map(p => p.e));
    const tSpan = Math.max(1, tMax - tMin);
    const x = t => padL + (t - tMin) / tSpan * (W - padL - padR);
    const y = v => padT + (1 - v / vMax) * (H - padT - padB);
    const rOf = e => 3 + Math.sqrt(e / eMax) * 6;
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
      const c = el("circle", { cx: x(p.t), cy: y(p.v), r: rOf(p.e), fill: planColor(p.plan), "fill-opacity": 0.85,
        stroke: p.forced ? "var(--vscode-charts-green, #3fb950)" : "rgba(0,0,0,0.55)", "stroke-width": p.forced ? 2 : 0.75 });
      c.style.cursor = "pointer";
      c.addEventListener("mouseenter", (ev) => showTip(p.row, ev));
      c.addEventListener("mousemove", moveTip);
      c.addEventListener("mouseleave", hideTip);
      c.addEventListener("click", () => { hideTip(); vscode.postMessage({ type: "openPlan", planId: Number(p.plan) }); });
      svg.appendChild(c);
    });
    $("bubbleChart").replaceChildren(svg);
    $("key").style.display = "flex";
    $("keyMetric").textContent = valueLabel || "metric";
    const plans = [...new Set(pts.map(p => p.plan))];
    $("legendBox").style.display = "block";
    $("legend").innerHTML = plans.map(p => { const forced = pts.some(q => q.plan === p && q.forced); return '<span data-plan="' + esc(p) + '"><i style="background:' + planColor(p) + '"></i>' + esc(p) + (forced ? " ★" : "") + "</span>"; }).join("");
    [...$("legend").querySelectorAll("[data-plan]")].forEach(s => s.addEventListener("click", () => vscode.postMessage({ type: "openPlan", planId: Number(s.dataset.plan) })));
  }
  /* ---- data-point hover tooltip ---- */
  function showTip(rowIdx, ev) {
    const r = sumRows[rowIdx]; if (!r) return;
    const get = name => { const i = sumCols.indexOf(name); return i < 0 ? "" : (r[i] === null ? "" : r[i]); };
    const forced = String(get("Forced")) === "1";
    const fields = [
      ["Plan Id", get("PlanId")],
      ["Execution Type", get("ExecutionType")],
      ["Plan Forced", forced ? "Yes" : "No"],
      ["Interval Start", fmtTime(get("IntervalStart"), { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })],
      ["Interval End", fmtTime(get("IntervalEnd"), { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })],
      ["Execution Count", get("Executions")],
      ["Total " + metricName, get("Total")],
      ["Avg " + metricName, get("Avg")],
      ["Min " + metricName, get("Min")],
      ["Max " + metricName, get("Max")],
      ["Std Dev " + metricName, get("StdDev")],
    ];
    $("tip").innerHTML = "<table><tbody>" + fields.map(f => "<tr><td>" + esc(f[0]) + "</td><td>" + esc(f[1]) + "</td></tr>").join("") + "</tbody></table>";
    $("tip").style.display = "block";
    moveTip(ev);
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

  /* ---- query table ---- */
  function renderTable() {
    $("thead").innerHTML = "<tr>" + columns.map((c, i) =>
      '<th data-i="' + i + '">' + esc(c === VALUE_COL && valueLabel ? valueLabel : c) + (i === sortCol ? '<span class="arrow"> ' + (sortDir>0?"▲":"▼") + "</span>" : "") + "</th>"
    ).join("") + "</tr>";
    const qi = idIdx();
    $("tbody").innerHTML = sorted().map(r => {
      const sel = r[qi] === selected ? ' class="sel"' : "";
      return "<tr" + sel + ' data-q="' + esc(r[qi]) + '">' + r.map(v =>
        v === null ? "<td></td>" : "<td" + (isNum(v) ? ' class="num"' : "") + ">" + esc(v) + "</td>"
      ).join("") + "</tr>";
    }).join("");
    [...$("thead").querySelectorAll("th")].forEach(th => th.addEventListener("click", () => {
      const i = +th.dataset.i;
      if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; }
      renderTable();
    }));
    [...$("tbody").querySelectorAll("tr")].forEach(tr => tr.addEventListener("click", () => drill(tr.dataset.q)));
  }
  function drill(queryId) {
    selected = queryId; curQuery = queryId; drawBars(); renderTable();
    vscode.postMessage({ type: "drill", queryId: Number(queryId), ...params() });
  }
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
    const stop = (b, type, key) => b.addEventListener("click", (ev) => { ev.stopPropagation();
      vscode.postMessage({ type, queryId: Number(curQuery), planId: Number(b.dataset[key]), ...params() }); });
    [...$("planBody").querySelectorAll("[data-force]")].forEach(b => stop(b, "force", "force"));
    [...$("planBody").querySelectorAll("[data-unforce]")].forEach(b => stop(b, "unforce", "unforce"));
    [...$("planBody").querySelectorAll("[data-open]")].forEach(b => b.addEventListener("click", (ev) => {
      ev.stopPropagation(); vscode.postMessage({ type: "openPlan", planId: Number(b.dataset.open) }); }));
    [...$("planBody").querySelectorAll("tr")].forEach(tr => tr.addEventListener("click", () =>
      vscode.postMessage({ type: "openPlan", planId: Number(tr.dataset.plan) })));
  }
  $("toggleList").addEventListener("click", () => {
    const w = $("listWrap"); const show = w.style.display === "none";
    w.style.display = show ? "block" : "none"; $("toggleList").textContent = show ? "Hide query list" : "Show query list";
  });
  const applyIfReady = () => { if (customReady()) vscode.postMessage({ type: "apply", ...params() }); };
  $("apply").addEventListener("click", applyIfReady);
  $("metric").addEventListener("change", applyIfReady);
  if (HAS_AGG) $("agg").addEventListener("change", applyIfReady);
  $("window").addEventListener("change", () => { toggleCustom(); applyIfReady(); });
  $("from").addEventListener("change", applyIfReady);
  $("to").addEventListener("change", applyIfReady);
  $("tz").addEventListener("change", () => {
    // Reinterpret the custom pickers under the new tz, then refresh.
    if ($("window").value === "custom") { /* pickers keep their wall-clock values */ }
    applyIfReady();
    if (curQuery != null) vscode.postMessage({ type: "drill", queryId: Number(curQuery), ...params() });
  });
  if (HAS_MINEXEC) $("minExec").addEventListener("change", applyIfReady);
  // Interval only affects the plan-summary chart; re-drill the selected query if any.
  $("interval").addEventListener("change", () => {
    vscode.postMessage({ type: "saveInterval", ...params() });
    if (curQuery != null) vscode.postMessage({ type: "drill", queryId: Number(curQuery), ...params() });
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "rows") { columns = m.columns; rows = m.rows; valueLabel = m.valueLabel; $("msg").innerHTML = ""; drawBars(); renderTable(); }
    else if (m.type === "drill") {
      $("drillTitle").innerHTML = "Query " + esc(m.queryId) + '<span class="note">Query text is retrieved from the stored showplan and may be truncated.</span>'; $("queryText").textContent = m.text;
      $("bubbleTitle").textContent = "Plan summary — Query " + m.queryId;
      metricName = m.metricName || "metric";
      sumCols = m.summary.columns; sumRows = m.summary.rows; drawBubbles();
      planCols = m.plans.columns; planRows = m.plans.rows; renderPlans();
      $("drill").style.display = "block";
    }
    else if (m.type === "disabled") { $("msg").innerHTML = '<p class="hint">Query Store is not enabled for read on this database (state: ' + esc(m.state) + ').</p>'; }
    else if (m.type === "error") { $("msg").innerHTML = '<p class="error">' + esc(m.message) + "</p>"; }
  });
  if (DEF.start && DEF.end) { $("from").value = utcToInput(DEF.start); $("to").value = utcToInput(DEF.end); }
  toggleCustom();
  vscode.postMessage({ type: "ready", ...params() });
</script>
</body></html>`;
}
