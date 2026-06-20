import * as vscode from "vscode";
import type { QueryRunner } from "./backupHistory";

export type FieldType =
  | "text"
  | "number"
  | "checkbox"
  | "textarea"
  | "select"
  | "checklist";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Options for a select field. An empty-string option renders as "(all)". */
  options?: string[];
  /** Choices for a checklist field (multi-select); value stored as string[]. */
  choices?: Array<{ value: string; label: string }>;
}

export type FormValues = Record<string, string | boolean | string[]>;

export interface EntityFormConfig {
  title: string;
  fields: FieldDef[];
  initial: FormValues;
  /** Build the msdb proc batch from the edited values. */
  makeBatch: (values: FormValues) => string;
  onApplied: () => void;
}

/**
 * Generic property-form webview for simple Agent objects (Operators, Proxies,
 * Alerts). Renders fields from a schema; OK executes the built batch, Script
 * opens it in a SQL editor.
 */
export function openEntityForm(run: QueryRunner, cfg: EntityFormConfig): void {
  const panel = vscode.window.createWebviewPanel(
    "ssms.entityForm",
    cfg.title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderHtml(cfg.title, cfg.fields);

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; execute?: boolean; values?: FormValues }) => {
      try {
        if (msg.type === "ready") {
          panel.webview.postMessage({ type: "init", values: cfg.initial });
        } else if (msg.type === "cancel") {
          panel.dispose();
        } else if (msg.type === "apply" && msg.values) {
          const batch = cfg.makeBatch(msg.values);
          if (msg.execute) {
            await run(batch);
            vscode.window.showInformationMessage(`${cfg.title}: applied.`);
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHtml(title: string, fields: FieldDef[]): string {
  const nc = nonce();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nc}'`,
  ].join("; ");

  const rows = fields
    .map((f) => {
      if (f.type === "checkbox") {
        return `<div class="row"><input type="checkbox" data-key="${f.key}" id="f_${f.key}"><label for="f_${f.key}">${esc(f.label)}</label></div>`;
      }
      if (f.type === "textarea") {
        return `<div class="row col"><label for="f_${f.key}">${esc(f.label)}</label><textarea data-key="${f.key}" id="f_${f.key}"></textarea></div>`;
      }
      if (f.type === "select") {
        const opts = (f.options ?? [])
          .map((o) => `<option value="${esc(o)}">${o === "" ? "(all)" : esc(o)}</option>`)
          .join("");
        return `<div class="row"><label class="inline" for="f_${f.key}">${esc(f.label)}</label><select data-key="${f.key}" id="f_${f.key}">${opts}</select></div>`;
      }
      if (f.type === "checklist") {
        const items = (f.choices ?? [])
          .map(
            (c) =>
              `<label class="chk"><input type="checkbox" value="${esc(c.value)}"> ${esc(c.label)}</label>`
          )
          .join("");
        return `<div class="row col"><label>${esc(f.label)}</label><div class="checklist" data-key="${f.key}" data-multi="1">${items}</div></div>`;
      }
      const inputType = f.type === "number" ? "number" : "text";
      return `<div class="row"><label class="inline" for="f_${f.key}">${esc(f.label)}</label><input type="${inputType}" data-key="${f.key}" id="f_${f.key}"></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 14px 64px; font-size: 13px; }
  h3 { font-weight: 600; margin: 0 0 12px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .row.col { flex-direction: column; align-items: stretch; }
  label { color: var(--vscode-descriptionForeground); }
  label.inline { min-width: 130px; }
  input, textarea, select { font-family: inherit; font-size: 13px; padding: 3px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  input[type=text], input[type=number], select { width: 272px; }
  textarea { width: 100%; min-height: 60px; }
  .checklist { border: 1px solid var(--vscode-panel-border); border-radius: 2px; padding: 6px 8px; max-width: 420px; }
  .checklist .chk { display: block; color: var(--vscode-foreground); margin: 2px 0; }
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
  <h3>${esc(title)}</h3>
  ${rows}
  <div id="msg"></div>
  <div class="footer">
    <button id="ok">OK</button>
    <button id="script" class="secondary">Script</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>
<script nonce="${nc}">
  const vscode = acquireVsCodeApi();
  const fields = [...document.querySelectorAll("[data-key]")];
  function values() {
    const v = {};
    for (const el of fields) {
      if (el.dataset.multi) v[el.dataset.key] = [...el.querySelectorAll("input:checked")].map(i => i.value);
      else v[el.dataset.key] = el.type === "checkbox" ? el.checked : el.value;
    }
    return v;
  }
  document.getElementById("ok").addEventListener("click", () => vscode.postMessage({ type:"apply", execute:true, values: values() }));
  document.getElementById("script").addEventListener("click", () => vscode.postMessage({ type:"apply", execute:false, values: values() }));
  document.getElementById("cancel").addEventListener("click", () => vscode.postMessage({ type:"cancel" }));
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "init") {
      for (const el of fields) {
        const val = m.values[el.dataset.key];
        if (el.dataset.multi) {
          const set = new Set(val || []);
          el.querySelectorAll("input").forEach(i => { i.checked = set.has(i.value); });
        } else if (el.type === "checkbox") el.checked = !!val;
        else el.value = val == null ? "" : val;
      }
    } else if (m.type === "error") {
      document.getElementById("msg").innerHTML = '<p class="error">' + String(m.message).replace(/</g,"&lt;") + "</p>";
    }
  });
  vscode.postMessage({ type:"ready" });
</script>
</body>
</html>`;
}
