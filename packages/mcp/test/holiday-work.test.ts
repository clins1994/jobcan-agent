import { describe, expect, it } from "vitest";
import { FakeClient } from "../src/client/fake.js";
import { planHolidayWork, type HolidayWorkPlanContext } from "../src/domain/holiday-work-plan.js";
import { requestHolidayWork } from "../src/usecases/holiday-work.js";
import { request, TODAY } from "./helpers.js";

const WORK = "2026-10-03"; // a Saturday
const OFF = "2026-10-09";
const calendar = [
  { date: WORK, isWorkday: false, label: "National" },
  { date: OFF, isWorkday: true },
];
const context: HolidayWorkPlanContext = { calendar, leaveRequests: [], holidayWork: [] };
const input = { workDate: WORK, holidayDate: OFF, reason: "Release" };

describe("planHolidayWork", () => {
  it("is ready for a holiday and a workday off, and defaults to a substitute", () => {
    expect(planHolidayWork(input, context)).toMatchObject({ status: "ready", compensation: "substitute", problems: [] });
  });

  it("blocks a day that is already a workday", () => {
    const plan = planHolidayWork({ ...input, workDate: OFF, holidayDate: undefined }, context);
    expect(plan.status).toBe("blocked");
    expect(plan.problems.join()).toMatch(/is a workday/);
  });

  it("blocks a day off that is not a workday, or is the day worked", () => {
    expect(planHolidayWork({ ...input, holidayDate: WORK }, context).problems.join()).toMatch(/same day/);
    expect(planHolidayWork({ ...input, holidayDate: WORK }, context).problems.join()).toMatch(/not a workday/);
  });

  it("blocks an empty reason", () => {
    expect(planHolidayWork({ ...input, reason: "  " }, context).problems).toContain("A reason is required");
  });

  it("blocks a day off on another kind of compensation", () => {
    expect(planHolidayWork({ ...input, compensation: "compensatory" }, context).problems.join()).toMatch(/Only a substitute/);
  });

  it("blocks a second request for the same day, but not after a rejection", () => {
    const existing = { id: "9", workDate: WORK, compensation: "substitute", status: "pending" } as const;
    expect(planHolidayWork(input, { ...context, holidayWork: [existing] }).status).toBe("blocked");
    expect(planHolidayWork(input, { ...context, holidayWork: [{ ...existing, status: "rejected" }] }).status).toBe("ready");
  });

  it("blocks a day off that already has leave", () => {
    const plan = planHolidayWork(input, { ...context, leaveRequests: [request(OFF, { id: "12" })] });
    expect(plan.problems.join()).toMatch(/already has leave request 12/);
  });
});

describe("requestHolidayWork", () => {
  const fake = () => new FakeClient({ today: TODAY, calendar });

  it("writes nothing without confirm", async () => {
    const client = fake();
    expect((await requestHolidayWork(client, input)).mode).toBe("dry_run");
    expect(client.writes).toEqual([]);
  });

  it("writes nothing when blocked, even with confirm", async () => {
    const client = fake();
    expect((await requestHolidayWork(client, { ...input, reason: "", confirm: true })).mode).toBe("blocked");
    expect(client.writes).toEqual([]);
  });

  it("files one request with both days when confirmed", async () => {
    const client = fake();
    const outcome = await requestHolidayWork(client, { ...input, confirm: true });
    expect(outcome).toMatchObject({ mode: "submitted", filed: { workDate: WORK, holidayDate: OFF, status: "pending" } });
    expect(client.writes).toEqual([{ method: "submitHolidayWorkRequest", args: { workDate: WORK, compensation: "substitute", holidayDate: OFF, reason: "Release" } }]);
  });
});
