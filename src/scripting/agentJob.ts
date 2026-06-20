/**
 * Builds the msdb stored-procedure batch that applies edits made in the Job
 * Properties dialog (General + Steps + Schedules), diffing edited vs original.
 * Shared by the dialog's OK (execute) and Script (open in editor) actions.
 */

export interface JobGeneral {
  name: string;
  enabled: boolean;
  owner: string;
  category: string;
  description: string;
}

export interface JobStep {
  stepId: number;
  name: string;
  subsystem: string;
  database: string;
  command: string;
  onSuccess: number; // 1 quit success, 2 quit failure, 3 go to next step
  onFail: number;
  retryAttempts: number;
  retryInterval: number;
}

export interface JobSchedule {
  scheduleId: number; // 0 = new
  name: string;
  enabled: boolean;
  freqType: number;
  freqInterval: number;
  freqRecurrenceFactor: number;
  freqRelativeInterval: number;
  freqSubdayType: number;
  freqSubdayInterval: number;
  activeStartTime: number;
  activeEndTime: number;
  activeStartDate: number;
  activeEndDate: number;
}

export interface JobModel {
  jobId: string;
  general: JobGeneral;
  steps: JobStep[];
  schedules: JobSchedule[];
}

const s = (v: string): string => "N'" + (v ?? "").replace(/'/g, "''") + "'";
const b = (v: boolean): string => (v ? "1" : "0");

function guid(id: string): string {
  return /^[0-9A-Fa-f-]{36}$/.test(id)
    ? `N'${id}'`
    : `N'00000000-0000-0000-0000-000000000000'`;
}

function call(proc: string, args: Array<[string, string]>): string {
  const body = args.map(([k, v]) => `    @${k} = ${v}`).join(",\n");
  return `EXEC msdb.dbo.${proc}\n${body};`;
}

/** Schedule parameters shared by sp_add_jobschedule and sp_update_schedule. */
function scheduleParams(sc: JobSchedule): Array<[string, string]> {
  return [
    ["enabled", b(sc.enabled)],
    ["freq_type", String(sc.freqType)],
    ["freq_interval", String(sc.freqInterval)],
    ["freq_subday_type", String(sc.freqSubdayType)],
    ["freq_subday_interval", String(sc.freqSubdayInterval)],
    ["freq_relative_interval", String(sc.freqRelativeInterval)],
    ["freq_recurrence_factor", String(sc.freqRecurrenceFactor)],
    ["active_start_date", String(sc.activeStartDate)],
    ["active_end_date", String(sc.activeEndDate || 99991231)],
    ["active_start_time", String(sc.activeStartTime)],
    ["active_end_time", String(sc.activeEndTime || 235959)],
  ];
}

function stepParams(step: JobStep): Array<[string, string]> {
  return [
    ["step_name", s(step.name)],
    ["subsystem", s(step.subsystem)],
    ["command", s(step.command)],
    ["database_name", s(step.database || "master")],
    ["on_success_action", String(step.onSuccess)],
    ["on_fail_action", String(step.onFail)],
    ["retry_attempts", String(step.retryAttempts)],
    ["retry_interval", String(step.retryInterval)],
  ];
}

export function buildJobBatch(original: JobModel, edited: JobModel): string {
  const stmts: string[] = [];
  const jid = guid(original.jobId);

  // ---- General ----
  if (JSON.stringify(original.general) !== JSON.stringify(edited.general)) {
    const g = edited.general;
    stmts.push(
      call("sp_update_job", [
        ["job_id", jid],
        ["new_name", s(g.name)],
        ["enabled", b(g.enabled)],
        ["description", s(g.description)],
        ["owner_login_name", s(g.owner)],
        ["category_name", s(g.category)],
      ])
    );
  }

  // ---- Steps: rebuild in order when anything changed (avoids fragile
  // step_id renumbering math; SSMS effectively rewrites steps on OK too). ----
  if (JSON.stringify(original.steps) !== JSON.stringify(edited.steps)) {
    for (const st of [...original.steps].sort((a, c) => c.stepId - a.stepId)) {
      stmts.push(
        call("sp_delete_jobstep", [
          ["job_id", jid],
          ["step_id", String(st.stepId)],
        ])
      );
    }
    edited.steps.forEach((st) => {
      stmts.push(call("sp_add_jobstep", [["job_id", jid], ...stepParams(st)]));
    });
  }

  // ---- Schedules ----
  const origSchedById = new Map(original.schedules.map((x) => [x.scheduleId, x]));
  const editedIds = new Set(edited.schedules.map((x) => x.scheduleId).filter((id) => id > 0));

  for (const sc of edited.schedules) {
    if (sc.scheduleId === 0) {
      stmts.push(
        call("sp_add_jobschedule", [
          ["job_id", jid],
          ["name", s(sc.name)],
          ...scheduleParams(sc),
        ])
      );
    } else {
      const prev = origSchedById.get(sc.scheduleId);
      if (prev && JSON.stringify(prev) !== JSON.stringify(sc)) {
        stmts.push(
          call("sp_update_schedule", [
            ["schedule_id", String(sc.scheduleId)],
            ["new_name", s(sc.name)],
            ...scheduleParams(sc),
          ])
        );
      }
    }
  }
  for (const sc of original.schedules) {
    if (!editedIds.has(sc.scheduleId)) {
      stmts.push(
        call("sp_detach_schedule", [
          ["job_id", jid],
          ["schedule_id", String(sc.scheduleId)],
          ["delete_unused_schedule", "1"],
        ])
      );
    }
  }

  return stmts.join("\n\n");
}

/** Build the batch that creates a brand-new job (sp_add_job + steps +
 * schedules + sp_add_jobserver to target the local server). */
export function buildNewJobBatch(m: {
  general: JobGeneral;
  steps: JobStep[];
  schedules: JobSchedule[];
}): string {
  const jn = s(m.general.name);
  const stmts: string[] = [];

  const jobArgs: Array<[string, string]> = [
    ["job_name", jn],
    ["enabled", b(m.general.enabled)],
    ["description", s(m.general.description)],
  ];
  if (m.general.owner) jobArgs.push(["owner_login_name", s(m.general.owner)]);
  if (m.general.category) jobArgs.push(["category_name", s(m.general.category)]);
  stmts.push(call("sp_add_job", jobArgs));

  m.steps.forEach((st) =>
    stmts.push(call("sp_add_jobstep", [["job_name", jn], ...stepParams(st)]))
  );
  m.schedules.forEach((sc) =>
    stmts.push(
      call("sp_add_jobschedule", [
        ["job_name", jn],
        ["name", s(sc.name)],
        ...scheduleParams(sc),
      ])
    )
  );
  stmts.push(
    call("sp_add_jobserver", [["job_name", jn], ["server_name", "N'(LOCAL)'"]])
  );
  return stmts.join("\n\n");
}

/** Statement that deletes a job by id. */
export function deleteJobStatement(jobId: string): string {
  return `EXEC msdb.dbo.sp_delete_job @job_id = ${guid(jobId)};`;
}
