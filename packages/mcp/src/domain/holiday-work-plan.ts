import { assertPlainDate, type PlainDate } from "./dates.js";
import { classifyDate, indexCalendar, type CalendarDay, type DayClassification } from "./holidays.js";
import type { HolidayCompensation, HolidayWorkRequest, LeaveRequest } from "./types.js";

export interface HolidayWorkPlanInput {
  workDate: PlainDate;
  compensation?: HolidayCompensation;
  holidayDate?: PlainDate;
  reason: string;
}

export interface HolidayWorkPlanContext {
  calendar: CalendarDay[];
  leaveRequests: LeaveRequest[];
  holidayWork: HolidayWorkRequest[];
}

export interface HolidayWorkPlan {
  workDate: DayClassification;
  compensation: HolidayCompensation;
  holidayDate?: DayClassification;
  reason: string;
  status: "ready" | "blocked";
  /** Why the plan cannot be filed as it stands. Empty when `ready`. */
  problems: string[];
}

const isActive = (r: { status: string }) => r.status === "pending" || r.status === "approved";

/** Pure: what would be filed, and what stops it. Jobcan still has the last word at its review step. */
export function planHolidayWork(input: HolidayWorkPlanInput, context: HolidayWorkPlanContext): HolidayWorkPlan {
  const calendar = indexCalendar(context.calendar);
  const compensation = input.compensation ?? "substitute";
  const reason = input.reason.trim();
  const workDate = classifyDate(assertPlainDate(input.workDate), calendar.get(input.workDate));
  const holidayDate = input.holidayDate ? classifyDate(assertPlainDate(input.holidayDate), calendar.get(input.holidayDate)) : undefined;
  const problems: string[] = [];

  if (workDate.isWorkday) problems.push(`${workDate.date} is a workday, so it needs no holiday work request`);
  if (!reason) problems.push("A reason is required");
  if (context.holidayWork.some((r) => r.workDate === workDate.date && isActive(r))) {
    problems.push(`${workDate.date} already has a holiday work request`);
  }
  if (holidayDate) {
    if (compensation !== "substitute") problems.push("Only a substitute day off can name a date");
    if (holidayDate.date === workDate.date) problems.push("The day off and the day worked are the same day");
    if (!holidayDate.isWorkday) problems.push(`${holidayDate.date} is not a workday, so it cannot be the day off`);
    const taken = context.leaveRequests.find((r) => isActive(r) && r.from <= holidayDate.date && r.to >= holidayDate.date);
    if (taken) problems.push(`${holidayDate.date} already has leave request ${taken.id}`);
  }

  return {
    workDate,
    compensation,
    ...(holidayDate ? { holidayDate } : {}),
    reason,
    status: problems.length === 0 ? "ready" : "blocked",
    problems,
  };
}
