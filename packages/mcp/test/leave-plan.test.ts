import { describe, expect, it } from "vitest";
import {
  customSelectForm,
  hourlyForm,
  minimalForm,
  noHalfDaysForm,
  reasonRequiredForm,
  standardCalendar,
  ymdSelectsForm,
  type FormFixture,
} from "../src/client/fixtures.js";
import {
  DEFAULT_REASON,
  findConflict,
  planLeaveRequest,
  suggestReason,
  unitsConflict,
  type LeavePlanContext,
  type LeavePlanInput,
} from "../src/domain/leave-plan.js";
import { defineForm } from "../src/domain/forms.js";
import type { LeaveBalance, LeaveCategory } from "../src/domain/types.js";
import { request, TODAY } from "./helpers.js";

const FULL_DAY = "1";
const MORNING = "2";
const AFTERNOON = "3";
const COMPENSATORY = "4";
const SPECIAL = "6";

const balanceOf = (category: LeaveCategory, remainingDays: number, pendingAlreadyDeducted = false): LeaveBalance => ({
  key: category,
  label: category,
  category,
  remainingDays,
  pendingAlreadyDeducted,
});

function context(overrides: Partial<LeavePlanContext> & { fixture?: FormFixture } = {}): LeavePlanContext {
  const { fixture = minimalForm, ...rest } = overrides;
  return {
    today: TODAY,
    leaveTypes: fixture.leaveTypes,
    balances: [balanceOf("paid", 10)],
    requests: [],
    calendar: [],
    form: fixture.form,
    ...rest,
  };
}

const plan = (input: Partial<LeavePlanInput>, ctx: LeavePlanContext = context()) =>
  planLeaveRequest({ leaveType: FULL_DAY, ...input }, ctx);

const skipped = (p: ReturnType<typeof plan>) =>
  p.days.filter((d) => d.decision === "skip").map((d) => [d.date, d.skipReason]);

describe("ranges", () => {
  it("files 8 workdays for October 5 to 15", () => {
    const p = plan({ range: { from: "2026-10-05", to: "2026-10-15" } });
    expect(p.status).toBe("ready");
    expect(p.requestedCount).toBe(11);
    expect(p.toFile).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
    ]);
    expect(skipped(p)).toEqual([
      ["2026-10-10", "weekend"],
      ["2026-10-11", "weekend"],
      ["2026-10-12", "national_holiday"],
    ]);
    expect(p.days.find((d) => d.date === "2026-10-12")?.detail).toBe("スポーツの日");
  });

  it("crosses a month end with a weekend and a holiday", () => {
    const p = plan({ range: { from: "2026-10-29", to: "2026-11-04" } });
    expect(p.toFile).toEqual(["2026-10-29", "2026-10-30", "2026-11-02", "2026-11-04"]);
    expect(skipped(p)).toEqual([
      ["2026-10-31", "weekend"],
      ["2026-11-01", "weekend"],
      ["2026-11-03", "national_holiday"],
    ]);
  });

  it("leaves 3 workdays in Golden Week", () => {
    const p = plan({ range: { from: "2027-04-29", to: "2027-05-07" } });
    expect(p.requestedCount).toBe(9);
    expect(p.toFile).toEqual(["2027-04-30", "2027-05-06", "2027-05-07"]);
  });

  it("skips 振替休日", () => {
    const p = plan({ range: { from: "2027-03-19", to: "2027-03-23" } });
    expect(p.toFile).toEqual(["2027-03-19", "2027-03-23"]);
    expect(p.days.find((d) => d.date === "2027-03-22")).toMatchObject({
      decision: "skip",
      skipReason: "national_holiday",
      detail: "春分の日 振替休日",
    });
  });

  it("only knows New Year's Day without Jobcan's calendar", () => {
    const p = plan({ range: { from: "2026-12-28", to: "2027-01-05" } });
    expect(p.toFile).toEqual(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-04", "2027-01-05"]);
  });

  it("skips the company's New Year closure when Jobcan's calendar has it", () => {
    const range = { from: "2026-12-28", to: "2027-01-05" };
    const calendar = standardCalendar(range, ["2026-12-29", "2026-12-30", "2026-12-31"]);
    const p = plan({ range }, context({ calendar }));
    expect(p.toFile).toEqual(["2026-12-28", "2027-01-04", "2027-01-05"]);
    expect(skipped(p)).toEqual([
      ["2026-12-29", "company_holiday"],
      ["2026-12-30", "company_holiday"],
      ["2026-12-31", "company_holiday"],
      ["2027-01-01", "national_holiday"],
      ["2027-01-02", "weekend"],
      ["2027-01-03", "weekend"],
    ]);
  });

  it("files a Saturday that Jobcan says is a workday", () => {
    const p = plan({ dates: ["2026-10-10"] }, context({ calendar: [{ date: "2026-10-10", isWorkday: true }] }));
    expect(p.toFile).toEqual(["2026-10-10"]);
  });

  it("falls back for days Jobcan has no data for", () => {
    const calendar = [{ date: "2026-10-05", isWorkday: false, label: "公休" }];
    const p = plan({ range: { from: "2026-10-05", to: "2026-10-06" } }, context({ calendar }));
    expect(skipped(p)).toEqual([["2026-10-05", "company_holiday"]]);
    expect(p.toFile).toEqual(["2026-10-06"]);
  });
});

describe("dates given one by one", () => {
  it("sorts them", () => {
    expect(plan({ dates: ["2026-10-07", "2026-10-05"] }).toFile).toEqual(["2026-10-05", "2026-10-07"]);
  });

  it("files a repeated date once and reports it", () => {
    const p = plan({ dates: ["2026-10-05", "2026-10-05", "2026-10-06"] });
    expect(p.requestedCount).toBe(2);
    expect(p.toFile).toEqual(["2026-10-05", "2026-10-06"]);
    expect(p.duplicates).toEqual(["2026-10-05"]);
    expect(p.balance?.cost).toBe(2);
  });

  it("merges dates with a range that overlaps them", () => {
    const p = plan({ dates: ["2026-10-06", "2026-10-20"], range: { from: "2026-10-05", to: "2026-10-07" } });
    expect(p.toFile).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-20"]);
    expect(p.duplicates).toEqual(["2026-10-06"]);
  });

  it("files nothing for a Saturday", () => {
    const p = plan({ dates: ["2026-10-10"] });
    expect(p.status).toBe("nothing_to_file");
    expect(p.toFile).toEqual([]);
    expect(skipped(p)).toEqual([["2026-10-10", "weekend"]]);
  });
});

describe("past dates", () => {
  it("skips dates before today", () => {
    const p = plan({ range: { from: "2026-09-28", to: "2026-09-30" } });
    expect(skipped(p)).toEqual([["2026-09-28", "past_date"]]);
    expect(p.toFile).toEqual(["2026-09-29", "2026-09-30"]);
  });

  it("files nothing when every date has passed", () => {
    expect(plan({ dates: ["2026-09-01"] }).status).toBe("nothing_to_file");
  });

  it("files them when asked to", () => {
    const p = plan({ dates: ["2026-09-28"], allowPast: true });
    expect(p.status).toBe("ready");
    expect(p.toFile).toEqual(["2026-09-28"]);
  });

  it("still skips a past weekend when asked to file past dates", () => {
    const p = plan({ dates: ["2026-09-27"], allowPast: true });
    expect(skipped(p)).toEqual([["2026-09-27", "weekend"]]);
  });
});

describe("dates already requested", () => {
  it("skips a date with a pending request and names it", () => {
    const p = plan({ dates: ["2026-10-05", "2026-10-06"] }, context({ requests: [request("2026-10-05", { id: "41" })] }));
    expect(p.toFile).toEqual(["2026-10-06"]);
    expect(p.days[0]).toMatchObject({ decision: "skip", skipReason: "already_requested", detail: "41" });
  });

  it("skips a date with an approved request", () => {
    const requests = [request("2026-10-05", { status: "approved" })];
    expect(plan({ dates: ["2026-10-05"] }, context({ requests })).status).toBe("nothing_to_file");
  });

  it.each(["rejected", "cancelled"] as const)("files again after a %s request", (status) => {
    const requests = [request("2026-10-05", { status })];
    expect(plan({ dates: ["2026-10-05"] }, context({ requests })).toFile).toEqual(["2026-10-05"]);
  });

  it("skips every date inside a multi-day request", () => {
    const requests = [request("2026-10-05", { to: "2026-10-07", days: 3 })];
    const p = plan({ range: { from: "2026-10-05", to: "2026-10-08" } }, context({ requests }));
    expect(p.toFile).toEqual(["2026-10-08"]);
  });
});

describe("half days", () => {
  it("costs half a day each", () => {
    const p = plan({ leaveType: MORNING, dates: ["2026-10-05", "2026-10-06", "2026-10-07"] });
    expect(p.status).toBe("ready");
    expect(p.balance).toMatchObject({ cost: 1.5, available: 10, after: 8.5 });
  });

  it("lets an afternoon join a morning already requested", () => {
    const requests = [request("2026-10-05", { unit: "half_day_am", days: 0.5 })];
    expect(plan({ leaveType: AFTERNOON, dates: ["2026-10-05"] }, context({ requests })).toFile).toEqual(["2026-10-05"]);
  });

  it("refuses the same half twice", () => {
    const requests = [request("2026-10-05", { unit: "half_day_am", days: 0.5 })];
    expect(plan({ leaveType: MORNING, dates: ["2026-10-05"] }, context({ requests })).status).toBe("nothing_to_file");
  });

  it("refuses a full day on top of a half day", () => {
    const requests = [request("2026-10-05", { unit: "half_day_am", days: 0.5 })];
    expect(plan({ leaveType: FULL_DAY, dates: ["2026-10-05"] }, context({ requests })).status).toBe("nothing_to_file");
  });

  it("refuses a half day on top of a full day", () => {
    const requests = [request("2026-10-05")];
    expect(plan({ leaveType: AFTERNOON, dates: ["2026-10-05"] }, context({ requests })).status).toBe("nothing_to_file");
  });

  it("unitsConflict", () => {
    expect(unitsConflict("half_day_am", "half_day_pm")).toBe(false);
    expect(unitsConflict("half_day_pm", "half_day_am")).toBe(false);
    expect(unitsConflict("half_day_am", "half_day_am")).toBe(true);
    expect(unitsConflict("full_day", "half_day_am")).toBe(true);
    expect(unitsConflict("full_day", "full_day")).toBe(true);
    expect(unitsConflict("hourly", "half_day_pm")).toBe(true);
  });
});

describe("balance", () => {
  it("previews before and after", () => {
    const p = plan({ range: { from: "2026-10-05", to: "2026-10-15" } });
    expect(p.balance).toEqual({ key: "paid", category: "paid", tracked: true, remaining: 10, pending: 0, available: 10, cost: 8, after: 2 });
  });

  it("takes pending requests off what is available", () => {
    const ctx = context({ balances: [balanceOf("paid", 5)], requests: [request("2026-11-02"), request("2026-11-04")] });
    const p = plan({ dates: ["2026-10-05"] }, ctx);
    expect(p.balance).toMatchObject({ remaining: 5, pending: 2, available: 3, cost: 1, after: 2 });
  });

  it("does not take pending requests off twice", () => {
    const ctx = context({ balances: [balanceOf("paid", 3, true)], requests: [request("2026-11-02"), request("2026-11-04")] });
    expect(plan({ dates: ["2026-10-05"] }, ctx).balance).toMatchObject({ remaining: 3, pending: 0, available: 3, after: 2 });
  });

  it("is ready when the request uses the balance exactly", () => {
    const p = plan({ dates: ["2026-10-05", "2026-10-06"] }, context({ balances: [balanceOf("paid", 2)] }));
    expect(p.status).toBe("ready");
    expect(p.balance?.after).toBe(0);
    expect(p.options).toEqual([]);
  });

  it("is short by half a day", () => {
    const p = plan({ dates: ["2026-10-05", "2026-10-06"] }, context({ balances: [balanceOf("paid", 1.5)] }));
    expect(p.status).toBe("insufficient_balance");
    expect(p.balance?.after).toBe(-0.5);
  });

  it("is short with a balance of exactly zero, and cannot offer fewer dates", () => {
    const p = plan({ dates: ["2026-10-05"] }, context({ balances: [balanceOf("paid", 0)] }));
    expect(p.status).toBe("insufficient_balance");
    expect(p.options.some((o) => o.kind === "fewer_dates")).toBe(false);
  });

  it("is short when pending requests hold the rest", () => {
    const ctx = context({ balances: [balanceOf("paid", 2)], requests: [request("2026-11-02"), request("2026-11-04")] });
    const p = plan({ dates: ["2026-10-05"] }, ctx);
    expect(p.status).toBe("insufficient_balance");
    expect(p.balance).toMatchObject({ available: 0, after: -1 });
  });

  it("does not count skipped dates against the balance", () => {
    const p = plan({ range: { from: "2026-10-09", to: "2026-10-13" } }, context({ balances: [balanceOf("paid", 2)] }));
    expect(p.status).toBe("ready");
    expect(p.balance).toMatchObject({ cost: 2, after: 0 });
  });

  it("does not check a leave type Jobcan keeps no balance for", () => {
    const p = plan({ leaveType: SPECIAL, dates: ["2026-10-05"] });
    expect(p.status).toBe("ready");
    expect(p.balance).toEqual({ key: "special", category: "special", tracked: false, cost: 1 });
  });

  it("uses the balance of the leave type's own category", () => {
    const ctx = context({ balances: [balanceOf("paid", 0), balanceOf("compensatory", 1)] });
    const p = plan({ leaveType: COMPENSATORY, dates: ["2026-10-05"] }, ctx);
    expect(p.status).toBe("ready");
    expect(p.balance).toMatchObject({ category: "compensatory", available: 1, after: 0 });
  });
});

describe("options when the balance is short", () => {
  it("offers fewer dates and never files a subset on its own", () => {
    const p = plan({ range: { from: "2026-10-05", to: "2026-10-09" } }, context({ balances: [balanceOf("paid", 3)] }));
    expect(p.status).toBe("insufficient_balance");
    expect(p.toFile).toHaveLength(5);
    expect(p.options).toContainEqual({ kind: "fewer_dates", maxDates: 3 });
  });

  it("offers half days of the same category when only those fit", () => {
    const p = plan({ dates: ["2026-10-05"] }, context({ balances: [balanceOf("paid", 0.5)] }));
    const names = p.options.filter((o) => o.kind === "other_leave_type").map((o) => o.leaveTypeId);
    expect(names).toContain(MORNING);
    expect(names).toContain(AFTERNOON);
    expect(p.options).toContainEqual({
      kind: "other_leave_type",
      leaveTypeId: MORNING,
      name: "有給休暇(午前半休)",
      unit: "half_day_am",
      cost: 0.5,
      available: 0.5,
    });
  });

  it("offers another category that has enough", () => {
    const ctx = context({ balances: [balanceOf("paid", 0), balanceOf("compensatory", 2)] });
    const p = plan({ dates: ["2026-10-05", "2026-10-06"] }, ctx);
    expect(p.options).toContainEqual({
      kind: "other_leave_type",
      leaveTypeId: COMPENSATORY,
      name: "代休(全日)",
      unit: "full_day",
      cost: 2,
      available: 2,
    });
  });

  it("leaves out another category that is also short", () => {
    const ctx = context({ balances: [balanceOf("paid", 0), balanceOf("compensatory", 1), balanceOf("substitute", 0)] });
    const p = plan({ dates: ["2026-10-05", "2026-10-06"] }, ctx);
    const ids = p.options.filter((o) => o.kind === "other_leave_type").map((o) => o.leaveTypeId);
    expect(ids).not.toContain(COMPENSATORY);
    expect(ids).not.toContain("5");
  });

  it("offers an untracked category without a number", () => {
    const p = plan({ dates: ["2026-10-05"] }, context({ balances: [balanceOf("paid", 0)] }));
    const special = p.options.find((o) => o.kind === "other_leave_type" && o.leaveTypeId === SPECIAL);
    expect(special).toEqual({ kind: "other_leave_type", leaveTypeId: SPECIAL, name: "特別休暇(全日)", unit: "full_day", cost: 1 });
  });

  it("offers nothing when the balance is enough", () => {
    expect(plan({ dates: ["2026-10-05"] }).options).toEqual([]);
  });
});

describe("leave type", () => {
  it("is found by name", () => {
    const p = plan({ leaveType: "有給休暇(午後半休)", dates: ["2026-10-05"] });
    expect(p.leaveType?.id).toBe(AFTERNOON);
  });

  it("is invalid when unknown", () => {
    const p = plan({ leaveType: "99", dates: ["2026-10-05"] });
    expect(p.status).toBe("invalid");
    expect(p.problems).toEqual(['Unknown leave type "99"']);
  });

  it("is invalid for a half day where the company has none", () => {
    const p = plan({ leaveType: MORNING, dates: ["2026-10-05"] }, context({ fixture: noHalfDaysForm }));
    expect(p.status).toBe("invalid");
  });

  it("refuses a time range on leave that is not hourly", () => {
    const p = plan({ leaveType: FULL_DAY, dates: ["2026-10-05"], time: { start: "10:00", end: "14:00" } });
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(/not hourly/);
  });
});

describe("hourly leave", () => {
  const HOURLY = "4";
  const ctx = () => context({ fixture: hourlyForm });
  const hourly = (time: { start: string; end: string } | undefined, extra: Partial<LeavePlanInput> = {}, c = ctx()) =>
    plan({ leaveType: HOURLY, dates: ["2026-10-05"], time, ...extra }, c);

  it("costs a fraction of a day: four hours of an eight-hour day is a half day", () => {
    const p = hourly({ start: "10:00", end: "14:00" });
    expect(p.status).toBe("ready");
    expect(p.costPerDate).toBe(0.5);
    expect(p.balance).toMatchObject({ cost: 0.5, after: 9.5 });
  });

  it("adds up over several dates", () => {
    const p = hourly({ start: "13:00", end: "15:00" }, { range: { from: "2026-10-05", to: "2026-10-07" }, dates: undefined });
    expect(p.balance).toMatchObject({ cost: 0.75, after: 9.25 });
  });

  it("fills the form's time fields", () => {
    const p = hourly({ start: "9:30", end: "14:00" });
    expect(p.status).toBe("ready");
  });

  it("asks for the time when none is given", () => {
    const p = hourly(undefined);
    expect(p.status).toBe("needs_input");
    expect(p.missingFields.map((f) => f.field)).toEqual(["start_time", "end_time"]);
  });

  it("asks for the time even when the form has no time fields of its own", () => {
    const leaveTypes = [{ id: "9", name: "時間休", category: "paid" as const, balanceKey: "paid", unit: "hourly" as const, days: 0, minutesPerDay: 480 }];
    const form = defineForm("leave", [
      { kind: "select", name: "leave_type", label: "種別", required: true, role: "leave_type", options: [{ value: "9", label: "時間休" }] },
      { kind: "date", name: "date", label: "取得日", required: true, role: "from_date" },
    ]);
    const p = plan({ leaveType: "9", dates: ["2026-10-05"] }, context({ leaveTypes, form }));
    expect(p.status).toBe("needs_input");
    expect(p.missingFields.map((f) => f.field)).toEqual(["time"]);
  });

  it.each([
    [{ start: "14:00", end: "10:00" }, /end after it starts/],
    [{ start: "10:00", end: "10:00" }, /end after it starts/],
    [{ start: "10", end: "14:00" }, /HH:MM/],
    [{ start: "09:00", end: "18:00" }, /longer than a day/],
  ])("refuses %o", (time, problem) => {
    const p = hourly(time);
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(problem);
  });

  it("refuses minutes the form's selects do not offer", () => {
    const p = hourly({ start: "10:05", end: "14:00" });
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(/multiple of 10 minutes/);
  });

  it("refuses an hourly type Jobcan gave no day length for", () => {
    const leaveTypes = [{ id: "9", name: "時間休", category: "paid" as const, balanceKey: "paid", unit: "hourly" as const, days: 0 }];
    const p = plan({ leaveType: "9", dates: ["2026-10-05"], time: { start: "10:00", end: "14:00" } }, context({ leaveTypes }));
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(/minutes make a day/);
  });

  it("can join another hourly request on the same date when the hours do not overlap", () => {
    const existing = request("2026-10-05", { leaveTypeId: HOURLY, unit: "hourly", days: 0.25, time: { start: "10:00", end: "12:00" } });
    const c = context({ fixture: hourlyForm, requests: [existing] });
    expect(hourly({ start: "12:00", end: "14:00" }, {}, c).toFile).toEqual(["2026-10-05"]);
    expect(hourly({ start: "11:00", end: "14:00" }, {}, c).status).toBe("nothing_to_file");
  });

  it("assumes a collision when the existing request's hours are unknown", () => {
    const existing = request("2026-10-05", { leaveTypeId: HOURLY, unit: "hourly", days: 0.25 });
    expect(hourly({ start: "12:00", end: "14:00" }, {}, context({ fixture: hourlyForm, requests: [existing] })).status).toBe("nothing_to_file");
  });

  it("collides with a full day either way", () => {
    expect(findConflict([request("2026-10-05")], "2026-10-05", "hourly", { start: "10:00", end: "12:00" })).toBeDefined();
    const hourlyRequest = request("2026-10-05", { unit: "hourly", days: 0.25, time: { start: "10:00", end: "12:00" } });
    expect(findConflict([hourlyRequest], "2026-10-05", "full_day")).toBeDefined();
  });

  it("is short when the hours cost more than remains", () => {
    const p = hourly({ start: "10:00", end: "14:00" }, {}, context({ fixture: hourlyForm, balances: [balanceOf("paid", 0.25)] }));
    expect(p.status).toBe("insufficient_balance");
    expect(p.options.some((o) => o.kind === "fewer_dates")).toBe(false);
  });
});

describe("reason", () => {
  it("uses the reason given", () => {
    const p = plan({ dates: ["2026-10-05"], reason: "通院" }, context({ fixture: reasonRequiredForm }));
    expect(p).toMatchObject({ status: "ready", reason: "通院", reasonSource: "given" });
  });

  it("falls back to a stock phrase when the form insists and there is no history", () => {
    const p = plan({ dates: ["2026-10-05"] }, context({ fixture: reasonRequiredForm }));
    expect(p).toMatchObject({ status: "ready", reason: DEFAULT_REASON, reasonSource: "default" });
  });

  it("reuses the reason last used for the same leave type", () => {
    const requests = [
      request("2026-08-03", { id: "10", reason: "旅行", requestedOn: "2026-07-01" }),
      request("2026-09-01", { id: "11", reason: "通院", requestedOn: "2026-08-20" }),
      request("2026-09-10", { id: "12", leaveTypeId: COMPENSATORY, category: "compensatory", reason: "代休消化", requestedOn: "2026-09-05" }),
    ];
    const p = plan({ dates: ["2026-10-05"] }, context({ fixture: reasonRequiredForm, requests }));
    expect(p).toMatchObject({ reason: "通院", reasonSource: "history" });
  });

  it("falls back to any leave's reason, but never a rejected one", () => {
    const type = reasonRequiredForm.leaveTypes.find((t) => t.id === SPECIAL)!;
    const requests = [
      request("2026-09-01", { id: "11", reason: "却下された理由", requestedOn: "2026-08-25", status: "rejected" }),
      request("2026-08-01", { id: "10", reason: "私用", requestedOn: "2026-07-20" }),
    ];
    expect(suggestReason(type, requests)).toEqual({ reason: "私用", source: "history" });
    expect(suggestReason(type, [])).toEqual({ reason: DEFAULT_REASON, source: "default" });
  });

  it("leaves the reason empty when the form does not insist", () => {
    const p = plan({ dates: ["2026-10-05"] }, context({ fixture: noHalfDaysForm, requests: [request("2026-09-01", { reason: "通院" })] }));
    expect(p.reason).toBeUndefined();
    expect(p.reasonSource).toBeUndefined();
  });

  it("insists only for the leave types the form marks", () => {
    const ctx = context({ fixture: ymdSelectsForm });
    expect(plan({ leaveType: FULL_DAY, dates: ["2026-10-05"] }, ctx).reason).toBeUndefined();
    expect(plan({ leaveType: SPECIAL, dates: ["2026-10-05"] }, ctx)).toMatchObject({ reason: DEFAULT_REASON, reasonSource: "default" });
  });
});

describe("bad input", () => {
  it("needs at least one date", () => {
    expect(plan({}).problems).toEqual(["No dates given"]);
    expect(plan({ dates: [] }).status).toBe("invalid");
  });

  it("refuses a date that does not exist", () => {
    const p = plan({ dates: ["2026-02-30"] });
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(/2026-02-30/);
  });

  it("refuses a range that ends before it starts", () => {
    expect(plan({ range: { from: "2026-10-15", to: "2026-10-05" } }).status).toBe("invalid");
  });
});

describe("form fields", () => {
  it("treats a blank reason as missing rather than inventing one", () => {
    const p = plan({ dates: ["2026-10-05"], reason: "   " }, context({ fixture: reasonRequiredForm }));
    expect(p.status).toBe("needs_input");
    expect(p.missingFields.map((f) => [f.field, f.label])).toEqual([["reason", "申請理由"]]);
  });

  it("is ready once the reason is given", () => {
    const p = plan({ dates: ["2026-10-05"], reason: "私用のため" }, context({ fixture: reasonRequiredForm }));
    expect(p.status).toBe("ready");
  });

  it("refuses a reason longer than the form allows", () => {
    const p = plan({ dates: ["2026-10-05"], reason: "あ".repeat(201) }, context({ fixture: reasonRequiredForm }));
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(/200 characters/);
  });

  it("asks for a company-defined select and lists the choices", () => {
    const p = plan({ dates: ["2026-10-05"] }, context({ fixture: customSelectForm }));
    expect(p.status).toBe("needs_input");
    expect(p.missingFields[0]).toMatchObject({ field: "custom_1", label: "休暇中の連絡方法" });
    expect(p.missingFields[0]?.options?.map((o) => o.label)).toEqual(["電話", "メール", "連絡不可"]);
  });

  it("accepts a company-defined field by label, with the option's label", () => {
    const ctx = context({ fixture: customSelectForm });
    expect(plan({ dates: ["2026-10-05"], fields: { 休暇中の連絡方法: "メール" } }, ctx).status).toBe("ready");
    expect(plan({ dates: ["2026-10-05"], fields: { custom_1: "2" } }, ctx).status).toBe("ready");
  });

  it("refuses a value that is not one of the choices", () => {
    const p = plan({ dates: ["2026-10-05"], fields: { custom_1: "FAX" } }, context({ fixture: customSelectForm }));
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(/not an option/);
  });

  it("refuses a field the form does not have", () => {
    const p = plan({ dates: ["2026-10-05"], fields: { nickname: "x" } });
    expect(p.status).toBe("invalid");
    expect(p.problems[0]).toMatch(/no field "nickname"/);
  });

  it("ignores a reason the form has no place for", () => {
    expect(plan({ dates: ["2026-10-05"], reason: "私用のため" }).status).toBe("ready");
  });

  it("reports a short balance ahead of missing fields, and still lists them", () => {
    const ctx = context({ fixture: customSelectForm, balances: [balanceOf("paid", 0)] });
    const p = plan({ dates: ["2026-10-05"] }, ctx);
    expect(p.status).toBe("insufficient_balance");
    expect(p.missingFields).toHaveLength(1);
  });

  it("carries the form's fingerprint", () => {
    expect(plan({ dates: ["2026-10-05"] }).formFingerprint).toBe(minimalForm.form.fingerprint);
  });
});

describe("purity", () => {
  it("gives the same plan for the same input and leaves the context alone", () => {
    const ctx = context({ requests: [request("2026-10-05")] });
    const snapshot = structuredClone(ctx);
    const input = { leaveType: FULL_DAY, range: { from: "2026-10-05", to: "2026-10-09" } };
    expect(planLeaveRequest(input, ctx)).toEqual(planLeaveRequest(input, ctx));
    expect(ctx).toEqual(snapshot);
  });
});
