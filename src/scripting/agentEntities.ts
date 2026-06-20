import type { SimpleExecuteResult } from "vscode-mssql";
import type { FieldDef, FormValues } from "../webviews/entityForm";
import { DATABASE_NAMES } from "../queries/agent";

type Runner = (sql: string) => Promise<SimpleExecuteResult>;

/** Configuration that drives the generic editor + msdb-proc generation for a
 * simple Agent object type (Operator, Proxy, Alert). */
export interface EntityConfig {
  /** Singular display name, e.g. "Operator". */
  title: string;
  fields: FieldDef[];
  defaults: FormValues;
  /** Query returning one row whose columns match the field keys. */
  detail: (name: string) => string;
  add: (v: FormValues) => string;
  update: (originalName: string, v: FormValues) => string;
  del: (name: string) => string;
  /** Resolve runtime select options (keyed by field key), e.g. a database list. */
  dynamicOptions?: (run: Runner) => Promise<Record<string, string[]>>;
  /** Resolve runtime checklist choices (keyed by field key), e.g. principals. */
  dynamicChoices?: (
    run: Runner
  ) => Promise<Record<string, Array<{ value: string; label: string }>>>;
  /** Load multi-valued fields (e.g. proxy subsystems) into initial values. */
  loadExtra?: (run: Runner, name: string) => Promise<Partial<FormValues>>;
  /** Extra statements appended after add/update (e.g. grant/revoke diffs). */
  extra?: (original: FormValues, edited: FormValues, isNew: boolean) => string;
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** Proxy subsystems (sp_grant_proxy_to_subsystem names) with SSMS labels. */
const PROXY_SUBSYSTEMS: Array<{ value: string; label: string }> = [
  { value: "CmdExec", label: "Operating system (CmdExec)" },
  { value: "Snapshot", label: "Replication Snapshot" },
  { value: "LogReader", label: "Replication Transaction-Log Reader" },
  { value: "Distribution", label: "Replication Distributor" },
  { value: "Merge", label: "Replication Merge" },
  { value: "QueueReader", label: "Replication Queue Reader" },
  { value: "ANALYSISQUERY", label: "SQL Server Analysis Services Query" },
  { value: "ANALYSISCOMMAND", label: "SQL Server Analysis Services Command" },
  { value: "PowerShell", label: "PowerShell" },
];

const s = (v: unknown): string => "N'" + String(v ?? "").replace(/'/g, "''") + "'";
const b = (v: unknown): string => (v ? "1" : "0");
const intOr0 = (v: unknown): string => String(Number(v) || 0);

/** Only emit a rename arg when the name actually changed — passing @new_name
 * equal to the current name fails with "@name already exists". */
function renameArg(orig: string, edited: unknown): Array<[string, string]> {
  return String(edited ?? "") !== orig ? [["new_name", s(edited)]] : [];
}

function call(proc: string, args: Array<[string, string]>): string {
  const body = args.map(([k, v]) => `    @${k} = ${v}`).join(",\n");
  return `EXEC msdb.dbo.${proc}\n${body};`;
}

function nameLiteral(name: string): string {
  return s(name);
}

export const OPERATOR: EntityConfig = {
  title: "Operator",
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "enabled", label: "Enabled", type: "checkbox" },
    { key: "email_address", label: "Email address", type: "text" },
    { key: "pager_address", label: "Pager / net send", type: "text" },
  ],
  defaults: { name: "", enabled: true, email_address: "", pager_address: "" },
  detail: (name) =>
    `SELECT name, enabled, email_address, pager_address FROM msdb.dbo.sysoperators WHERE name = ${nameLiteral(name)};`,
  add: (v) =>
    call("sp_add_operator", [
      ["name", s(v.name)],
      ["enabled", b(v.enabled)],
      ["email_address", s(v.email_address)],
      ["pager_address", s(v.pager_address)],
    ]),
  update: (orig, v) =>
    call("sp_update_operator", [
      ["name", s(orig)],
      ...renameArg(orig, v.name),
      ["enabled", b(v.enabled)],
      ["email_address", s(v.email_address)],
      ["pager_address", s(v.pager_address)],
    ]),
  del: (name) => `EXEC msdb.dbo.sp_delete_operator @name = ${nameLiteral(name)};`,
};

export const PROXY: EntityConfig = {
  title: "Proxy",
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "enabled", label: "Enabled", type: "checkbox" },
    { key: "credential_name", label: "Credential", type: "select" },
    { key: "description", label: "Description", type: "textarea" },
    { key: "subsystems", label: "Active to the following subsystems", type: "checklist", choices: PROXY_SUBSYSTEMS },
    { key: "principals", label: "Proxy account principals (logins / roles)", type: "checklist" },
  ],
  defaults: { name: "", enabled: true, credential_name: "", description: "", subsystems: [], principals: [] },
  detail: (name) =>
    `SELECT p.name, p.enabled, c.name AS credential_name, p.description
     FROM msdb.dbo.sysproxies p LEFT JOIN sys.credentials c ON p.credential_id = c.credential_id
     WHERE p.name = ${nameLiteral(name)};`,
  dynamicOptions: async (run) => {
    const res = await run(`SELECT name FROM sys.credentials ORDER BY name;`);
    return { credential_name: res.rows.map((r) => r[0]?.displayValue ?? "") };
  },
  dynamicChoices: async (run) => {
    const res = await run(
      `SELECT ptype, name FROM (
         SELECT 'login' AS ptype, name FROM sys.server_principals
           WHERE type IN ('S','U','G') AND name NOT LIKE '##%'
             AND ISNULL(IS_SRVROLEMEMBER('sysadmin', name), 0) = 0
         UNION ALL SELECT 'srole', name FROM sys.server_principals WHERE type = 'R' AND name <> 'sysadmin'
         UNION ALL SELECT 'mrole', name FROM msdb.sys.database_principals WHERE type = 'R' AND name <> 'public'
       ) x ORDER BY ptype, name;`
    );
    const TYPE_LABEL: Record<string, string> = {
      login: "SQL Login",
      srole: "Server Role",
      mrole: "MSDB Role",
    };
    const principals = res.rows.map((r) => {
      const ptype = r[0]?.displayValue ?? "login";
      const name = r[1]?.displayValue ?? "";
      return { value: `${ptype}|${name}`, label: `${name}  (${TYPE_LABEL[ptype] ?? ptype})` };
    });
    return { principals };
  },
  loadExtra: async (run, name) => {
    const subs = await run(
      `SELECT s.subsystem
       FROM msdb.dbo.sysproxysubsystem ps
       JOIN msdb.dbo.syssubsystems s ON ps.subsystem_id = s.subsystem_id
       JOIN msdb.dbo.sysproxies p ON ps.proxy_id = p.proxy_id
       WHERE p.name = ${nameLiteral(name)};`
    );
    // flags: 0 = Windows/SQL login, 1 = fixed server role, 2 = msdb role.
    // Resolve the name via SUSER_SNAME so logins covered by a Windows group
    // (not a direct server principal) still resolve.
    const prin = await run(
      `SELECT
         CASE pl.flags WHEN 1 THEN 'srole' WHEN 2 THEN 'mrole' ELSE 'login' END AS ptype,
         CASE pl.flags
              WHEN 1 THEN sp.name
              WHEN 2 THEN dp.name
              ELSE COALESCE(sp.name, SUSER_SNAME(pl.sid)) END AS name
       FROM msdb.dbo.sysproxylogin pl
       JOIN msdb.dbo.sysproxies p ON pl.proxy_id = p.proxy_id
       LEFT JOIN sys.server_principals sp ON sp.sid = pl.sid
       LEFT JOIN msdb.sys.database_principals dp ON dp.sid = pl.sid
       WHERE p.name = ${nameLiteral(name)};`
    );
    return {
      subsystems: subs.rows.map((r) => r[0]?.displayValue ?? ""),
      principals: prin.rows
        .filter((r) => r[1] && !r[1].isNull && r[1].displayValue)
        .map((r) => `${r[0]?.displayValue ?? "login"}|${r[1]?.displayValue ?? ""}`),
    };
  },
  add: (v) =>
    call("sp_add_proxy", [
      ["proxy_name", s(v.name)],
      ["credential_name", s(v.credential_name)],
      ["enabled", b(v.enabled)],
      ["description", s(v.description)],
    ]),
  update: (orig, v) =>
    call("sp_update_proxy", [
      ["proxy_name", s(orig)],
      ...renameArg(orig, v.name),
      ["credential_name", s(v.credential_name)],
      ["enabled", b(v.enabled)],
      ["description", s(v.description)],
    ]),
  del: (name) => `EXEC msdb.dbo.sp_delete_proxy @proxy_name = ${nameLiteral(name)};`,
  extra: (original, edited, isNew) => {
    const proxy = s(edited.name);
    const stmts: string[] = [];

    // Subsystems.
    const wantSub = new Set(asArray(edited.subsystems));
    const haveSub = new Set(asArray(original.subsystems));
    for (const { value } of PROXY_SUBSYSTEMS) {
      if (wantSub.has(value) && !haveSub.has(value)) {
        stmts.push(
          `EXEC msdb.dbo.sp_grant_proxy_to_subsystem @proxy_name = ${proxy}, @subsystem_name = N'${value}';`
        );
      } else if (!isNew && haveSub.has(value) && !wantSub.has(value)) {
        stmts.push(
          `EXEC msdb.dbo.sp_revoke_proxy_from_subsystem @proxy_name = ${proxy}, @subsystem_name = N'${value}';`
        );
      }
    }

    // Principals (encoded "ptype|name"): grant added, revoke removed.
    const wantP = new Set(asArray(edited.principals));
    const haveP = new Set(asArray(original.principals));
    const parse = (v: string): [string, string] => {
      const i = v.indexOf("|");
      return [v.slice(0, i), v.slice(i + 1)];
    };
    const grantParam = (ptype: string, pname: string): string =>
      ptype === "srole"
        ? `@fixed_server_role = ${s(pname)}`
        : ptype === "mrole"
          ? `@msdb_role = ${s(pname)}`
          : `@login_name = ${s(pname)}`;
    for (const v of wantP) {
      if (!haveP.has(v)) {
        const [ptype, pname] = parse(v);
        stmts.push(
          `EXEC msdb.dbo.sp_grant_login_to_proxy @proxy_name = ${proxy}, ${grantParam(ptype, pname)};`
        );
      }
    }
    if (!isNew) {
      for (const v of haveP) {
        if (!wantP.has(v)) {
          const [, pname] = parse(v);
          stmts.push(
            `EXEC msdb.dbo.sp_revoke_login_from_proxy @proxy_name = ${proxy}, @name = ${s(pname)};`
          );
        }
      }
    }

    return stmts.join("\n");
  },
};

export const ALERT: EntityConfig = {
  title: "Alert",
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "enabled", label: "Enabled", type: "checkbox" },
    { key: "severity", label: "Severity (0-25)", type: "number" },
    { key: "message_id", label: "Message ID", type: "number" },
    { key: "database_name", label: "Database (blank = all)", type: "select" },
  ],
  defaults: { name: "", enabled: true, severity: "0", message_id: "0", database_name: "" },
  dynamicOptions: async (run) => {
    const res = await run(DATABASE_NAMES);
    return { database_name: ["", ...res.rows.map((r) => r[0]?.displayValue ?? "")] };
  },
  detail: (name) =>
    `SELECT name, enabled, severity, message_id, database_name FROM msdb.dbo.sysalerts WHERE name = ${nameLiteral(name)};`,
  add: (v) =>
    call("sp_add_alert", [
      ["name", s(v.name)],
      ["enabled", b(v.enabled)],
      ["severity", intOr0(v.severity)],
      ["message_id", intOr0(v.message_id)],
      ["database_name", v.database_name ? s(v.database_name) : "NULL"],
    ]),
  update: (orig, v) =>
    call("sp_update_alert", [
      ["name", s(orig)],
      ...renameArg(orig, v.name),
      ["enabled", b(v.enabled)],
      ["severity", intOr0(v.severity)],
      ["message_id", intOr0(v.message_id)],
      ["database_name", v.database_name ? s(v.database_name) : "NULL"],
    ]),
  del: (name) => `EXEC msdb.dbo.sp_delete_alert @name = ${nameLiteral(name)};`,
};
