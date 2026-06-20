/** Operator editor model + msdb-proc batch (General + pager schedule +
 * alert notifications). */

export interface OperatorNotification {
  alertName: string;
  email: boolean;
  pager: boolean;
}

export interface OperatorModel {
  name: string;
  enabled: boolean;
  email: string;
  pager: string;
  /** Pager-on-duty day bitmask: Sun=1,Mon=2,Tue=4,Wed=8,Thu=16,Fri=32,Sat=64. */
  pagerDays: number;
  weekdayStart: number; // HHMMSS
  weekdayEnd: number;
  saturdayStart: number;
  saturdayEnd: number;
  sundayStart: number;
  sundayEnd: number;
  notifications: OperatorNotification[];
}

const s = (v: unknown): string => "N'" + String(v ?? "").replace(/'/g, "''") + "'";
const b = (v: unknown): string => (v ? "1" : "0");

function call(proc: string, args: Array<[string, string]>): string {
  const body = args.map(([k, v]) => `    @${k} = ${v}`).join(",\n");
  return `EXEC msdb.dbo.${proc}\n${body};`;
}

function operatorParams(m: OperatorModel): Array<[string, string]> {
  return [
    ["enabled", b(m.enabled)],
    ["email_address", s(m.email)],
    ["pager_address", s(m.pager)],
    ["weekday_pager_start_time", String(m.weekdayStart)],
    ["weekday_pager_end_time", String(m.weekdayEnd)],
    ["saturday_pager_start_time", String(m.saturdayStart)],
    ["saturday_pager_end_time", String(m.saturdayEnd)],
    ["sunday_pager_start_time", String(m.sundayStart)],
    ["sunday_pager_end_time", String(m.sundayEnd)],
    ["pager_days", String(m.pagerDays)],
  ];
}

const methodOf = (n: OperatorNotification): number =>
  (n.email ? 1 : 0) + (n.pager ? 2 : 0);

export function buildOperatorBatch(
  original: OperatorModel | undefined,
  edited: OperatorModel,
  isNew: boolean
): string {
  const stmts: string[] = [];
  const op = s(edited.name);

  if (isNew) {
    stmts.push(call("sp_add_operator", [["name", op], ...operatorParams(edited)]));
  } else {
    const origName = original?.name ?? edited.name;
    const args: Array<[string, string]> = [["name", s(origName)]];
    // Only rename when the name actually changed — passing @new_name equal to
    // the current name fails with "@name already exists".
    if (origName !== edited.name) {
      args.push(["new_name", op]);
    }
    args.push(...operatorParams(edited));
    stmts.push(call("sp_update_operator", args));
  }

  const origByAlert = new Map(
    (original?.notifications ?? []).map((n) => [n.alertName, methodOf(n)])
  );
  for (const n of edited.notifications) {
    const desired = methodOf(n);
    const prev = isNew ? 0 : origByAlert.get(n.alertName) ?? 0;
    const args: Array<[string, string]> = [
      ["alert_name", s(n.alertName)],
      ["operator_name", op],
      ["notification_method", String(desired)],
    ];
    if (desired > 0 && prev === 0) {
      stmts.push(call("sp_add_notification", args));
    } else if (desired > 0 && prev > 0 && desired !== prev) {
      stmts.push(call("sp_update_notification", args));
    } else if (desired === 0 && prev > 0) {
      stmts.push(
        call("sp_delete_notification", [
          ["alert_name", s(n.alertName)],
          ["operator_name", op],
        ])
      );
    }
  }

  return stmts.join("\n\n");
}

export function deleteOperatorStatement(name: string): string {
  return `EXEC msdb.dbo.sp_delete_operator @name = ${s(name)};`;
}
