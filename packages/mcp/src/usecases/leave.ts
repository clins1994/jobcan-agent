import { JobcanRejection, type JobcanClient } from "../client/client.js";
import { availableBalances, type AvailableBalance } from "../domain/balance.js";
import { planAttendance, type AttendancePlan, type AttendancePlanInput } from "../domain/attendance-plan.js";
import {
  addDays,
  assertPlainDate,
  expandRange,
  isPlainDate,
  monthOf,
  monthRange,
  rangeContains,
  type DateRange,
  type PlainDate,
  type PlainMonth,
} from "../domain/dates.js";
import { classifyDate, type DayClassification } from "../domain/holidays.js";
import { planLeaveRequest, type LeavePlan, type LeavePlanInput } from "../domain/leave-plan.js";
import type { LeaveRequest, TimesheetDay } from "../domain/types.js";

function monthsBetween(from: PlainDate, to: PlainDate): PlainMonth[] {
  const months: PlainMonth[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = monthOf(addDays(monthRange(m).to, 1))) months.push(m);
  return months;
}

/**
 * What the tools do, written against the client interface. Reads happen freely; a
 * write method is only reached when `confirm` is true and the plan is ready.
 */

export interface DateCheck extends DayClassification {
  isPast: boolean;
  alreadyRequested: boolean;
  /** Pending or approved requests covering the date. */
  requests: LeaveRequest[];
}

export async function checkDate(client: JobcanClient, date: PlainDate): Promise<DateCheck> {
  assertPlainDate(date);
  const range = { from: date, to: date };
  const [today, calendar, requests] = await Promise.all([
    client.getToday(),
    client.getCalendar(range),
    client.listLeaveRequests(range),
  ]);
  const active = requests.filter(
    (r) => (r.status === "pending" || r.status === "approved") && rangeContains(r, date),
  );
  return {
    ...classifyDate(date, calendar.find((d) => d.date === date)),
    isPast: date < today,
    alreadyRequested: active.length > 0,
    requests: active,
  };
}

export async function getLeaveBalance(client: JobcanClient): Promise<AvailableBalance[]> {
  const [balances, requests] = await Promise.all([client.getLeaveBalances(), client.listLeaveRequests()]);
  return availableBalances(balances, requests);
}

/** The span of dates the input touches, or undefined when the input is unusable. */
function requestedSpan(input: LeavePlanInput): DateRange | undefined {
  try {
    const all = [...(input.dates ?? []).map(assertPlainDate), ...(input.range ? expandRange(input.range) : [])].sort();
    return all.length > 0 ? { from: all[0]!, to: all[all.length - 1]! } : undefined;
  } catch {
    return undefined;
  }
}

export async function planLeave(client: JobcanClient, input: LeavePlanInput): Promise<LeavePlan> {
  const span = requestedSpan(input);
  const [today, leaveTypes, balances, requests, calendar, form] = await Promise.all([
    client.getToday(),
    client.listLeaveTypes(),
    client.getLeaveBalances(),
    client.listLeaveRequests(),
    span ? client.getCalendar(span) : Promise.resolve([]),
    client.discoverForm("leave"),
  ]);
  return planLeaveRequest(input, { today, leaveTypes, balances, requests, calendar, form });
}

export type RequestLeaveOutcome =
  /** Nothing was sent. This is the result whenever `confirm` is not true. */
  | { mode: "dry_run"; plan: LeavePlan }
  /** Confirmed, but the plan cannot be filed as it stands. Nothing was sent. */
  | { mode: "blocked"; plan: LeavePlan }
  | {
      mode: "submitted";
      plan: LeavePlan;
      filed: LeaveRequest[];
      /** Set when Jobcan refused a date. Filing stops there. */
      failed?: { date: PlainDate; messages: string[] };
      notAttempted: PlainDate[];
    };

export async function requestLeave(
  client: JobcanClient,
  input: LeavePlanInput & { confirm?: boolean },
): Promise<RequestLeaveOutcome> {
  const { confirm, ...planInput } = input;
  const plan = await planLeave(client, planInput);
  if (confirm !== true) return { mode: "dry_run", plan };
  if (plan.status !== "ready") return { mode: "blocked", plan };

  const filed: LeaveRequest[] = [];
  for (const [index, date] of plan.toFile.entries()) {
    try {
      filed.push(
        await client.submitLeaveRequest({
          leaveTypeId: plan.leaveType!.id,
          date,
          time: plan.time,
          reason: plan.reason,
          fields: plan.fields,
        }),
      );
    } catch (err) {
      if (!(err instanceof JobcanRejection)) throw err;
      return {
        mode: "submitted",
        plan,
        filed,
        failed: { date, messages: err.messages },
        notAttempted: plan.toFile.slice(index + 1),
      };
    }
  }
  return { mode: "submitted", plan, filed, notAttempted: [] };
}

export type CancelLeaveOutcome =
  | { mode: "not_found"; id: string }
  /** Approved requests can only be withdrawn by an administrator. */
  | { mode: "contact_admin"; request: LeaveRequest }
  | { mode: "not_cancellable"; request: LeaveRequest }
  | { mode: "dry_run"; request: LeaveRequest }
  | { mode: "cancelled"; request: LeaveRequest };

export async function cancelLeave(
  client: JobcanClient,
  input: { id: string; confirm?: boolean },
): Promise<CancelLeaveOutcome> {
  const request = await client.getLeaveRequest(input.id);
  if (!request) return { mode: "not_found", id: input.id };
  if (request.status === "approved") return { mode: "contact_admin", request };
  if (request.status !== "pending") return { mode: "not_cancellable", request };
  if (input.confirm !== true) return { mode: "dry_run", request };
  return { mode: "cancelled", request: await client.cancelLeaveRequest(input.id) };
}

export type ReplaceLeaveOutcome =
  | { mode: "not_found"; id: string }
  /** The old request is approved: only an administrator can change it. */
  | { mode: "contact_admin"; request: LeaveRequest }
  | { mode: "not_replaceable"; request: LeaveRequest }
  /** Nothing was sent. The plan shows what would replace the old request. */
  | { mode: "dry_run"; withdraw: LeaveRequest; plan: LeavePlan }
  /** Confirmed, but the new request cannot be filed as planned, so the old one was left alone. */
  | { mode: "blocked"; withdraw: LeaveRequest; plan: LeavePlan }
  /** The old request was withdrawn. `filed` is the new one; when it is missing, `failed` says why and the day is now uncovered. */
  | {
      mode: "replaced";
      withdrawn: LeaveRequest;
      plan: LeavePlan;
      filed: LeaveRequest[];
      failed?: { date: PlainDate; messages: string[] };
    };

/**
 * Withdraws a pending request and files another in its place, e.g. turning four hours
 * into a full day. The plan is made as if the old request were already gone, so its
 * date is free and its balance is back. The old request is only withdrawn once the
 * new one is ready to file.
 */
export async function replaceLeave(
  client: JobcanClient,
  input: { id: string; replacement: LeavePlanInput; confirm?: boolean },
): Promise<ReplaceLeaveOutcome> {
  const old = await client.getLeaveRequest(input.id);
  if (!old) return { mode: "not_found", id: input.id };
  if (old.status === "approved") return { mode: "contact_admin", request: old };
  if (old.status !== "pending") return { mode: "not_replaceable", request: old };

  const replacement = { ...input.replacement, dates: input.replacement.dates ?? (input.replacement.range ? undefined : [old.from]) };
  const span = requestedSpan(replacement);
  const [today, leaveTypes, balances, requests, calendar, form] = await Promise.all([
    client.getToday(),
    client.listLeaveTypes(),
    client.getLeaveBalances(),
    client.listLeaveRequests(),
    span ? client.getCalendar(span) : Promise.resolve([]),
    client.discoverForm("leave"),
  ]);
  const without = requests.filter((r) => r.id !== old.id);
  // the old request's own reason is the natural default for its replacement
  const reason = replacement.reason ?? old.reason;
  const plan = planLeaveRequest(
    { allowPast: old.from < today, ...replacement, reason },
    { today, leaveTypes, balances, requests: without, calendar, form },
  );
  if (replacement.reason === undefined && plan.reason === old.reason && plan.reasonSource === "given") plan.reasonSource = "history";

  if (input.confirm !== true) return { mode: "dry_run", withdraw: old, plan };
  if (plan.status !== "ready") return { mode: "blocked", withdraw: old, plan };

  const withdrawn = await client.cancelLeaveRequest(old.id);
  const filed: LeaveRequest[] = [];
  for (const date of plan.toFile) {
    try {
      filed.push(
        await client.submitLeaveRequest({ leaveTypeId: plan.leaveType!.id, date, time: plan.time, reason: plan.reason, fields: plan.fields }),
      );
    } catch (err) {
      if (!(err instanceof JobcanRejection)) throw err;
      return { mode: "replaced", withdrawn, plan, filed, failed: { date, messages: err.messages } };
    }
  }
  return { mode: "replaced", withdrawn, plan, filed };
}

// --- attendance ------------------------------------------------------------------

export type RecordAttendanceOutcome =
  /** Nothing was sent. This is the result whenever `confirm` is not true. */
  | { mode: "dry_run"; plan: AttendancePlan }
  /** Confirmed, but the plan has questions or problems. Nothing was sent. */
  | { mode: "blocked"; plan: AttendancePlan }
  | {
      mode: "recorded";
      plan: AttendancePlan;
      recorded: TimesheetDay[];
      /** Set when Jobcan refused a day. Recording stops there. */
      failed?: { date: PlainDate; messages: string[] };
      notAttempted: PlainDate[];
    };

export async function planAttendanceFor(client: JobcanClient, input: AttendancePlanInput): Promise<AttendancePlan> {
  const dates = [
    ...(input.month ? [monthRange(input.month).from, monthRange(input.month).to] : []),
    ...(input.dates ?? []),
    ...(input.range ? [input.range.from, input.range.to] : []),
  ].filter((d) => isPlainDate(d)).sort();
  const months = dates.length > 0 ? monthsBetween(dates[0]!, dates.at(-1)!) : [];
  const [today, requests, spots, ...sheets] = await Promise.all([
    client.getToday(),
    client.listLeaveRequests(),
    client.listAttendanceSpots(),
    ...months.map((m) => client.getTimesheet(m)),
  ]);
  return planAttendance(input, { today, timesheet: sheets.flat(), requests, spots });
}

export async function recordAttendance(
  client: JobcanClient,
  input: AttendancePlanInput & { confirm?: boolean },
): Promise<RecordAttendanceOutcome> {
  const { confirm, ...planInput } = input;
  const plan = await planAttendanceFor(client, planInput);
  if (confirm !== true) return { mode: "dry_run", plan };
  if (plan.status !== "ready") return { mode: "blocked", plan };

  const recorded: TimesheetDay[] = [];
  for (const [index, record] of plan.toRecord.entries()) {
    try {
      recorded.push(await client.recordAttendance(record));
    } catch (err) {
      if (!(err instanceof JobcanRejection)) throw err;
      return {
        mode: "recorded",
        plan,
        recorded,
        failed: { date: record.date, messages: err.messages },
        notAttempted: plan.toRecord.slice(index + 1).map((r) => r.date),
      };
    }
  }
  return { mode: "recorded", plan, recorded, notAttempted: [] };
}
