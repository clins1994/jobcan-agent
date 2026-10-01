import { describe, expect, it } from "vitest";
import { planAttendance, workAround, type AttendancePlanContext, type AttendancePlanInput } from "../src/domain/attendance-plan.js";
import { expandRange, isWeekend, monthRange } from "../src/domain/dates.js";
import { nationalHoliday } from "../src/domain/holidays.js";
import type { TimesheetDay } from "../src/domain/types.js";
import { request, TODAY } from "./helpers.js";

/** A month as Jobcan's timesheet shows it for a company closed on weekends and holidays. */
function sheet(month: string, recorded: Record<string, [string?, string?]> = {}, companyHolidays: string[] = []): TimesheetDay[] {
  return expandRange(monthRange(month)).map((date) => {
    const off = isWeekend(date) || nationalHoliday(date) !== undefined || companyHolidays.includes(date);
    const [clockIn, clockOut] = recorded[date] ?? [];
    return {
      date,
      isWorkday: !off,
      ...(off ? { label: nationalHoliday(date) ? "Public National" : "National" } : {}),
      ...(clockIn ? { clockIn } : {}),
      ...(clockOut ? { clockOut } : {}),
    };
  });
}

const context = (overrides: Partial<AttendancePlanContext> = {}): AttendancePlanContext => ({
  today: TODAY,
  timesheet: sheet("2026-09"),
  requests: [],
  spots: [{ id: "1", name: "Head office" }, { id: "3", name: "Remote" }],
  ...overrides,
});

const plan = (input: Partial<AttendancePlanInput> = {}, ctx = context()) =>
  planAttendance({ month: "2026-09", clockIn: "10:00", clockOut: "19:00", note: "手続き", ...input }, ctx);

const decisions = (p: ReturnType<typeof plan>) => p.days.map((d) => `${d.date.slice(8)}:${d.decision === "record" ? "R" : d.decision === "ask" ? "?" : d.skipReason}`);

describe("a month with nothing recorded", () => {
  it("records every past workday with the same hours, and nothing else", () => {
    const p = plan();
    expect(p.status).toBe("ready");
    expect(p.toRecord.map((r) => r.date)).toEqual([
      "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
      "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11",
      "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
      "2026-09-24", "2026-09-25", "2026-09-28",
    ]);
    expect(p.toRecord[0]).toEqual({ date: "2026-09-01", clockIn: "10:00", clockOut: "19:00", note: "手続き", spot: "1" });
    expect(p.spot).toEqual({ id: "1", name: "Head office" });
  });

  it("explains every skipped day", () => {
    const p = plan();
    const skipped = Object.fromEntries(p.days.filter((d) => d.decision === "skip").map((d) => [d.date, d.skipReason]));
    expect(skipped["2026-09-05"]).toBe("weekend");
    expect(skipped["2026-09-21"]).toBe("national_holiday");
    expect(skipped["2026-09-22"]).toBe("national_holiday");
    expect(skipped["2026-09-29"]).toBe("today");
    expect(skipped["2026-09-30"]).toBe("future");
    expect(p.days.find((d) => d.date === "2026-09-21")?.detail).toBe("敬老の日");
  });

  it("shows before and after for each day", () => {
    const p = plan();
    expect(p.days.find((d) => d.date === "2026-09-01")).toMatchObject({ before: {}, after: { clockIn: "10:00", clockOut: "19:00" } });
    expect(p.days.find((d) => d.date === "2026-09-05")).toMatchObject({ before: {}, after: {} });
  });

  it("records today when asked", () => {
    expect(plan({ includeToday: true }).toRecord.map((r) => r.date)).toContain(TODAY);
  });

  it("skips a company holiday from the timesheet", () => {
    const p = plan({}, context({ timesheet: sheet("2026-09", {}, ["2026-09-24"]) }));
    expect(p.days.find((d) => d.date === "2026-09-24")).toMatchObject({ decision: "skip", skipReason: "company_holiday" });
  });

  it("skips a day the timesheet does not have", () => {
    const p = plan({ dates: ["2026-08-31"] }, context({ timesheet: sheet("2026-09") }));
    expect(p.days.find((d) => d.date === "2026-08-31")).toMatchObject({ decision: "skip", skipReason: "no_timesheet" });
  });
});

describe("days already recorded", () => {
  it("leaves a day with any clock time alone", () => {
    const ctx = context({ timesheet: sheet("2026-09", { "2026-09-01": ["10:00", "19:00"], "2026-09-02": ["10:03"], "2026-09-03": [undefined, "18:30"] }) });
    const p = plan({}, ctx);
    expect(p.days.find((d) => d.date === "2026-09-01")).toMatchObject({ skipReason: "already_recorded", detail: "10:00 to 19:00", after: { clockIn: "10:00", clockOut: "19:00" } });
    expect(p.days.find((d) => d.date === "2026-09-02")).toMatchObject({ skipReason: "already_recorded", detail: "10:03 to --:--" });
    expect(p.days.find((d) => d.date === "2026-09-03")).toMatchObject({ skipReason: "already_recorded" });
    expect(p.toRecord.map((r) => r.date)).not.toContain("2026-09-02");
  });

  it("leaves a day whose manual records still wait for approval alone, even though it shows no times", () => {
    const timesheet = sheet("2026-09").map((d) => (d.date === "2026-09-01" ? { ...d, pendingApproval: true } : d));
    const p = plan({}, context({ timesheet }));
    expect(p.days.find((d) => d.date === "2026-09-01")).toMatchObject({ decision: "skip", skipReason: "pending_approval" });
    expect(p.toRecord.map((r) => r.date)).not.toContain("2026-09-01");
  });

  it("has nothing to record when the month is complete", () => {
    const recorded = Object.fromEntries(expandRange(monthRange("2026-09")).map((d) => [d, ["10:00", "19:00"] as [string, string]]));
    expect(plan({}, context({ timesheet: sheet("2026-09", recorded) })).status).toBe("nothing_to_record");
  });
});

describe("leave", () => {
  it("skips a full day of leave, pending or approved, but not a rejected one", () => {
    const requests = [
      request("2026-09-17", { id: "1" }),
      request("2026-09-18", { id: "2", status: "approved" }),
      request("2026-09-16", { id: "3", status: "rejected" }),
    ];
    const p = plan({}, context({ requests }));
    expect(p.days.find((d) => d.date === "2026-09-17")).toMatchObject({ skipReason: "full_day_leave", detail: "1" });
    expect(p.days.find((d) => d.date === "2026-09-18")).toMatchObject({ skipReason: "full_day_leave", detail: "2" });
    expect(p.days.find((d) => d.date === "2026-09-16")?.decision).toBe("record");
  });

  it("works the rest of the day around hourly leave at the start", () => {
    const requests = [request("2026-09-04", { id: "9", unit: "hourly", days: 0.5, time: { start: "10:00", end: "14:00" } })];
    const day = plan({}, context({ requests })).days.find((d) => d.date === "2026-09-04");
    expect(day).toMatchObject({ decision: "record", after: { clockIn: "14:00", clockOut: "19:00" }, detail: "around leave 10:00-14:00 (request 9)" });
  });

  it("works the rest of the day around hourly leave at the end", () => {
    const requests = [request("2026-09-11", { id: "9", unit: "hourly", days: 0.5, time: { start: "15:00", end: "19:00" } })];
    expect(plan({}, context({ requests })).days.find((d) => d.date === "2026-09-11")?.after).toEqual({ clockIn: "10:00", clockOut: "15:00" });
  });

  it("treats hourly leave that covers the whole day as a day off", () => {
    const requests = [request("2026-09-11", { id: "9", unit: "hourly", days: 1, time: { start: "09:00", end: "19:00" } })];
    expect(plan({}, context({ requests })).days.find((d) => d.date === "2026-09-11")).toMatchObject({ skipReason: "full_day_leave" });
  });

  it("asks about leave in the middle of the day instead of guessing", () => {
    const requests = [request("2026-09-11", { id: "9", unit: "hourly", days: 0.25, time: { start: "12:00", end: "14:00" } })];
    const p = plan({}, context({ requests }));
    expect(p.status).toBe("needs_input");
    expect(p.days.find((d) => d.date === "2026-09-11")).toMatchObject({
      decision: "ask",
      question: { kind: "leave_in_the_middle", leave: { start: "12:00", end: "14:00" }, requestId: "9" },
    });
    expect(p.toRecord.map((r) => r.date)).not.toContain("2026-09-11");
  });

  it("asks about a half day whose hours Jobcan does not give", () => {
    const requests = [request("2026-09-11", { id: "9", unit: "half_day_pm", days: 0.5 })];
    expect(plan({}, context({ requests })).days.find((d) => d.date === "2026-09-11")?.question).toEqual({ kind: "half_day_without_hours", unit: "half_day_pm", requestId: "9" });
  });

  it("asks when several hourly leaves fall on one day", () => {
    const requests = [
      request("2026-09-11", { id: "9", unit: "hourly", days: 0.25, time: { start: "10:00", end: "12:00" } }),
      request("2026-09-11", { id: "10", unit: "hourly", days: 0.25, time: { start: "17:00", end: "19:00" } }),
    ];
    expect(plan({}, context({ requests })).days.find((d) => d.date === "2026-09-11")?.question).toEqual({ kind: "several_hourly_leaves", requestIds: ["9", "10"] });
  });

  it("workAround", () => {
    const hours = { start: 600, end: 1140 };
    expect(workAround(hours, { start: 600, end: 840 })).toEqual({ start: 840, end: 1140 });
    expect(workAround(hours, { start: 540, end: 840 })).toEqual({ start: 840, end: 1140 });
    expect(workAround(hours, { start: 900, end: 1140 })).toEqual({ start: 600, end: 900 });
    expect(workAround(hours, { start: 900, end: 1200 })).toEqual({ start: 600, end: 900 });
    expect(workAround(hours, { start: 600, end: 1140 })).toBe("covered");
    expect(workAround(hours, { start: 720, end: 840 })).toBe("middle");
    expect(workAround(hours, { start: 1140, end: 1200 })).toEqual(hours);
  });
});

describe("input", () => {
  it("accepts dates and ranges as well as a month", () => {
    expect(plan({ month: undefined, dates: ["2026-09-01", "2026-09-05"] }).toRecord.map((r) => r.date)).toEqual(["2026-09-01"]);
    expect(plan({ month: undefined, range: { from: "2026-09-01", to: "2026-09-03" } }).toRecord).toHaveLength(3);
  });

  it("resolves a spot by name and refuses an unknown one", () => {
    expect(plan({ spot: "Remote" }).toRecord[0]?.spot).toBe("3");
    expect(plan({ spot: "Moon" })).toMatchObject({ status: "invalid", problems: [expect.stringMatching(/Unknown spot "Moon"/)] });
  });

  it.each([
    [{ clockIn: "19:00", clockOut: "10:00" }, /end after they start/],
    [{ clockIn: "10", clockOut: "19:00" }, /HH:MM/],
    [{ note: "  " }, /note/],
    [{ month: undefined }, /No dates/],
    [{ month: undefined, dates: ["2026-02-30"] }, /2026-02-30/],
  ])("refuses %j", (input, problem) => {
    const p = plan(input);
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(problem);
  });

  it("decisions at a glance", () => {
    expect(decisions(plan()).slice(0, 7)).toEqual(["01:R", "02:R", "03:R", "04:R", "05:weekend", "06:weekend", "07:R"]);
  });
});
