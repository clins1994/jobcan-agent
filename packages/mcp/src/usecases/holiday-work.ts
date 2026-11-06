import { JobcanRejection, type JobcanClient } from "../client/client.js";
import type { PlainDate } from "../domain/dates.js";
import { planHolidayWork, type HolidayWorkPlan, type HolidayWorkPlanInput } from "../domain/holiday-work-plan.js";
import type { HolidayWorkRequest } from "../domain/types.js";

export type RequestHolidayWorkOutcome =
  /** Nothing was sent. This is the result whenever `confirm` is not true. */
  | { mode: "dry_run"; plan: HolidayWorkPlan }
  /** Confirmed, but the plan cannot be filed as it stands. Nothing was sent. */
  | { mode: "blocked"; plan: HolidayWorkPlan }
  | { mode: "submitted"; plan: HolidayWorkPlan; filed: HolidayWorkRequest }
  | { mode: "refused"; plan: HolidayWorkPlan; messages: string[] };

export async function planHolidayWorkRequest(client: JobcanClient, input: HolidayWorkPlanInput): Promise<HolidayWorkPlan> {
  const dates: PlainDate[] = [input.workDate, ...(input.holidayDate ? [input.holidayDate] : [])].sort();
  const span = { from: dates[0]!, to: dates.at(-1)! };
  const [calendar, leaveRequests, holidayWork] = await Promise.all([
    client.getCalendar(span),
    client.listLeaveRequests(span),
    client.listHolidayWorkRequests({ from: input.workDate, to: input.workDate }),
  ]);
  return planHolidayWork(input, { calendar, leaveRequests, holidayWork });
}

export async function requestHolidayWork(
  client: JobcanClient,
  input: HolidayWorkPlanInput & { confirm?: boolean },
): Promise<RequestHolidayWorkOutcome> {
  const { confirm, ...planInput } = input;
  const plan = await planHolidayWorkRequest(client, planInput);
  if (confirm !== true) return { mode: "dry_run", plan };
  if (plan.status !== "ready") return { mode: "blocked", plan };

  try {
    const filed = await client.submitHolidayWorkRequest({
      workDate: plan.workDate.date,
      compensation: plan.compensation,
      ...(plan.holidayDate ? { holidayDate: plan.holidayDate.date } : {}),
      reason: plan.reason,
    });
    return { mode: "submitted", plan, filed };
  } catch (err) {
    if (err instanceof JobcanRejection) return { mode: "refused", plan, messages: err.messages };
    throw err;
  }
}
