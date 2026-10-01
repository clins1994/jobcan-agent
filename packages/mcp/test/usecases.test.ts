import { describe, expect, it } from "vitest";
import { readOnly } from "../src/client/client.js";
import { FakeClient, type FakeClientOptions } from "../src/client/fake.js";
import { customSelectForm, hourlyForm, standardCalendar } from "../src/client/fixtures.js";
import type { LeaveSubmission } from "../src/domain/types.js";
import { cancelLeave, checkDate, getLeaveBalance, planLeave, replaceLeave, requestLeave } from "../src/usecases/leave.js";
import { request, TODAY } from "./helpers.js";

const fake = (options: Partial<FakeClientOptions> = {}) =>
  new FakeClient({ today: TODAY, balances: { paid: 10 }, ...options });

const OCTOBER = { from: "2026-10-05", to: "2026-10-15" };

describe("checkDate", () => {
  it("reports a workday", async () => {
    expect(await checkDate(fake(), "2026-10-06")).toEqual({
      date: "2026-10-06",
      kind: "workday",
      isWorkday: true,
      source: "fallback",
      isPast: false,
      alreadyRequested: false,
      requests: [],
    });
  });

  it("reports a weekend and a national holiday", async () => {
    expect((await checkDate(fake(), "2026-10-10")).kind).toBe("weekend");
    expect(await checkDate(fake(), "2026-10-12")).toMatchObject({ kind: "national_holiday", name: "スポーツの日" });
  });

  it("reports a company holiday from Jobcan's calendar", async () => {
    const calendar = standardCalendar({ from: "2026-12-01", to: "2026-12-31" }, ["2026-12-30"]);
    expect(await checkDate(fake({ calendar }), "2026-12-30")).toMatchObject({
      kind: "company_holiday",
      isWorkday: false,
      source: "jobcan",
    });
  });

  it("reports a date that is already requested", async () => {
    const client = fake({ requests: [request("2026-10-06", { id: "5" }), request("2026-10-06", { id: "6", status: "cancelled" })] });
    const check = await checkDate(client, "2026-10-06");
    expect(check.alreadyRequested).toBe(true);
    expect(check.requests.map((r) => r.id)).toEqual(["5"]);
  });

  it("reports a past date", async () => {
    expect((await checkDate(fake(), "2026-09-28")).isPast).toBe(true);
    expect((await checkDate(fake(), TODAY)).isPast).toBe(false);
  });

  it("refuses a date that does not exist", async () => {
    await expect(checkDate(fake(), "2026-02-30")).rejects.toThrow(/2026-02-30/);
  });
});

describe("getLeaveBalance", () => {
  it("subtracts pending requests, half days included", async () => {
    const client = fake({
      balances: { paid: 10, compensatory: 2 },
      requests: [
        request("2026-10-05"),
        request("2026-10-06", { unit: "half_day_am", days: 0.5 }),
        request("2026-10-07", { status: "approved" }),
        request("2026-10-08", { category: "compensatory", balanceKey: "compensatory" }),
      ],
    });
    expect(await getLeaveBalance(client)).toMatchObject([
      { key: "paid", remaining: 10, pending: 1.5, available: 8.5 },
      { key: "compensatory", remaining: 2, pending: 1, available: 1 },
    ]);
  });

  it("gives the same answer whichever way Jobcan reports the balance", async () => {
    const requests = [request("2026-10-05"), request("2026-10-06")];
    const plain = await getLeaveBalance(fake({ requests }));
    const deducted = await getLeaveBalance(fake({ requests, balancesDeductPending: true }));
    expect(plain[0]?.available).toBe(8);
    expect(deducted[0]?.available).toBe(8);
  });
});

describe("requestLeave without confirm", () => {
  it("plans 8 workdays for October 5 to 15 and sends nothing", async () => {
    const client = fake();
    const outcome = await requestLeave(client, { leaveType: "1", range: OCTOBER });

    expect(outcome.mode).toBe("dry_run");
    expect(outcome.plan.status).toBe("ready");
    expect(outcome.plan.toFile).toHaveLength(8);
    expect(outcome.plan.balance).toMatchObject({ available: 10, cost: 8, after: 2 });
    expect(client.writes).toEqual([]);
    expect(await client.listLeaveRequests()).toEqual([]);
  });

  it.each([undefined, false])("treats confirm=%s as a dry run", async (confirm) => {
    const client = fake();
    expect((await requestLeave(client, { leaveType: "1", dates: ["2026-10-05"], confirm })).mode).toBe("dry_run");
    expect(client.writes).toEqual([]);
  });

  it("treats anything but true as a dry run", async () => {
    const client = fake();
    const confirm = "true" as unknown as boolean;
    expect((await requestLeave(client, { leaveType: "1", dates: ["2026-10-05"], confirm })).mode).toBe("dry_run");
    expect(client.writes).toEqual([]);
  });

  it("works through a read-only client", async () => {
    const outcome = await requestLeave(readOnly(fake()), { leaveType: "1", range: OCTOBER });
    expect(outcome.plan.toFile).toHaveLength(8);
  });

  it("uses Jobcan's calendar for the dates asked for", async () => {
    const calendar = standardCalendar(OCTOBER, ["2026-10-13"]);
    const plan = await planLeave(fake({ calendar }), { leaveType: "1", range: OCTOBER });
    expect(plan.toFile).toHaveLength(7);
    expect(plan.days.find((d) => d.date === "2026-10-13")?.skipReason).toBe("company_holiday");
  });

  it("counts pending requests outside the dates asked for", async () => {
    const client = fake({ balances: { paid: 2 }, requests: [request("2026-12-01"), request("2026-12-02")] });
    const plan = await planLeave(client, { leaveType: "1", dates: ["2026-10-05"] });
    expect(plan.status).toBe("insufficient_balance");
  });
});

describe("requestLeave with confirm", () => {
  it("files one request per workday", async () => {
    const client = fake();
    const outcome = await requestLeave(client, { leaveType: "1", range: OCTOBER, reason: "私用のため", confirm: true });

    expect(outcome.mode).toBe("submitted");
    if (outcome.mode !== "submitted") return;
    expect(outcome.failed).toBeUndefined();
    expect(outcome.notAttempted).toEqual([]);
    expect(outcome.filed.map((r) => r.from)).toEqual(outcome.plan.toFile);
    expect(outcome.filed.every((r) => r.status === "pending")).toBe(true);
    expect(client.writes.map((w) => (w.args as LeaveSubmission).date)).toEqual(outcome.plan.toFile);
    expect((await getLeaveBalance(client))[0]?.available).toBe(2);
  });

  it("files nothing for a Saturday", async () => {
    const client = fake();
    const outcome = await requestLeave(client, { leaveType: "1", dates: ["2026-10-10"], confirm: true });
    expect(outcome.mode).toBe("blocked");
    expect(outcome.plan.status).toBe("nothing_to_file");
    expect(client.writes).toEqual([]);
  });

  it("files nothing when the balance is short, and picks no option", async () => {
    const client = fake({ balances: { paid: 3, compensatory: 8 } });
    const outcome = await requestLeave(client, { leaveType: "1", range: OCTOBER, confirm: true });

    expect(outcome.mode).toBe("blocked");
    expect(outcome.plan.status).toBe("insufficient_balance");
    expect(outcome.plan.options.map((o) => o.kind)).toContain("fewer_dates");
    expect(outcome.plan.options.map((o) => o.kind)).toContain("other_leave_type");
    expect(client.writes).toEqual([]);
  });

  it("files nothing while a required field is missing", async () => {
    const client = fake({ fixture: customSelectForm });
    const outcome = await requestLeave(client, { leaveType: "1", dates: ["2026-10-05"], confirm: true });
    expect(outcome.mode).toBe("blocked");
    expect(outcome.plan.missingFields.map((f) => f.label)).toEqual(["休暇中の連絡方法"]);
    expect(client.writes).toEqual([]);
  });

  it("files hourly leave with its hours and charges a fraction of a day", async () => {
    const client = fake({ fixture: hourlyForm });
    const outcome = await requestLeave(client, { leaveType: "4", dates: ["2026-10-05"], time: { start: "10:00", end: "14:00" }, confirm: true });
    expect(outcome.mode).toBe("submitted");
    expect((await client.listLeaveRequests())[0]).toMatchObject({ unit: "hourly", days: 0.5, time: { start: "10:00", end: "14:00" } });
    expect((await getLeaveBalance(client))[0]?.available).toBe(9.5);
  });

  it("previews the reason it will use when the user gave none", async () => {
    const client = fake({ fixture: hourlyForm });
    const outcome = await requestLeave(client, { leaveType: "6", dates: ["2026-10-05"] });
    expect(outcome.plan).toMatchObject({ status: "ready", reasonSource: "default" });
  });

  it("files nothing for invalid input", async () => {
    const client = fake();
    const outcome = await requestLeave(client, { leaveType: "99", dates: ["2026-10-05"], confirm: true });
    expect(outcome.mode).toBe("blocked");
    expect(client.writes).toEqual([]);
  });

  it("is blocked by a read-only client", async () => {
    const inner = fake();
    await expect(requestLeave(readOnly(inner), { leaveType: "1", dates: ["2026-10-05"], confirm: true })).rejects.toThrow(/read-only/);
    expect(inner.writes).toEqual([]);
  });

  it("stops at the first date Jobcan refuses and says what was left", async () => {
    const client = fake();
    const submit = client.submitLeaveRequest.bind(client);
    client.submitLeaveRequest = async (submission) => {
      // stands in for a rule only the real form knows about
      if (submission.date === "2026-10-07") await submit({ ...submission, leaveTypeId: "unknown" });
      return submit(submission);
    };

    const outcome = await requestLeave(client, { leaveType: "1", range: { from: "2026-10-05", to: "2026-10-09" }, confirm: true });

    expect(outcome.mode).toBe("submitted");
    if (outcome.mode !== "submitted") return;
    expect(outcome.filed.map((r) => r.from)).toEqual(["2026-10-05", "2026-10-06"]);
    expect(outcome.failed?.date).toBe("2026-10-07");
    expect(outcome.failed?.messages[0]).toMatch(/not an option/);
    expect(outcome.notAttempted).toEqual(["2026-10-08", "2026-10-09"]);
    expect(await client.listLeaveRequests()).toHaveLength(2);
  });

  it("skips dates filed by an earlier run", async () => {
    const client = fake();
    await requestLeave(client, { leaveType: "1", dates: ["2026-10-05", "2026-10-06"], confirm: true });
    const again = await requestLeave(client, { leaveType: "1", dates: ["2026-10-05", "2026-10-06", "2026-10-07"], confirm: true });

    expect(again.mode).toBe("submitted");
    expect(again.plan.toFile).toEqual(["2026-10-07"]);
    expect(await client.listLeaveRequests()).toHaveLength(3);
  });
});

describe("cancelLeave", () => {
  it("previews without confirm and sends nothing", async () => {
    const client = fake({ requests: [request("2026-10-05", { id: "1" })] });
    const outcome = await cancelLeave(client, { id: "1" });
    expect(outcome).toMatchObject({ mode: "dry_run", request: { id: "1", status: "pending" } });
    expect(client.writes).toEqual([]);
  });

  it("cancels a pending request with confirm", async () => {
    const client = fake({ requests: [request("2026-10-05", { id: "1" })] });
    const outcome = await cancelLeave(client, { id: "1", confirm: true });
    expect(outcome).toMatchObject({ mode: "cancelled", request: { id: "1", status: "cancelled" } });
    expect(client.writes).toEqual([{ method: "cancelLeaveRequest", args: { id: "1" } }]);
  });

  it("points to the administrator for an approved request, confirmed or not", async () => {
    const client = fake({ requests: [request("2026-10-05", { id: "1", status: "approved" })] });
    expect((await cancelLeave(client, { id: "1" })).mode).toBe("contact_admin");
    expect((await cancelLeave(client, { id: "1", confirm: true })).mode).toBe("contact_admin");
    expect(client.writes).toEqual([]);
  });

  it.each(["rejected", "cancelled"] as const)("has nothing to cancel for a %s request", async (status) => {
    const client = fake({ requests: [request("2026-10-05", { id: "1", status })] });
    expect((await cancelLeave(client, { id: "1", confirm: true })).mode).toBe("not_cancellable");
    expect(client.writes).toEqual([]);
  });

  it("reports an unknown request", async () => {
    const client = fake();
    expect(await cancelLeave(client, { id: "404", confirm: true })).toEqual({ mode: "not_found", id: "404" });
    expect(client.writes).toEqual([]);
  });

  it("frees the date for a new request", async () => {
    const client = fake({ requests: [request("2026-10-05", { id: "1" })] });
    await cancelLeave(client, { id: "1", confirm: true });
    const outcome = await requestLeave(client, { leaveType: "1", dates: ["2026-10-05"], confirm: true });
    expect(outcome.mode).toBe("submitted");
  });
});

describe("replaceLeave", () => {
  const fourHours = () =>
    request("2026-09-25", { id: "47", leaveTypeId: "4", unit: "hourly", days: 0.5, time: { start: "10:00", end: "14:00" }, reason: "試験", requestedOn: "2026-09-24" });

  it("plans the full day as if the four hours were already gone, and sends nothing", async () => {
    const client = fake({ fixture: hourlyForm, balances: { paid: 1 }, requests: [fourHours()] });
    const outcome = await replaceLeave(client, { id: "47", replacement: { leaveType: "1" } });
    expect(outcome.mode).toBe("dry_run");
    if (outcome.mode !== "dry_run") return;
    expect(outcome.withdraw.id).toBe("47");
    expect(outcome.plan).toMatchObject({ status: "ready", toFile: ["2026-09-25"], costPerDate: 1, reason: "試験", reasonSource: "history" });
    expect(outcome.plan.balance).toMatchObject({ available: 1, after: 0 });
    expect(client.writes).toEqual([]);
  });

  it("withdraws then files on confirm", async () => {
    const client = fake({ fixture: hourlyForm, balances: { paid: 1 }, requests: [fourHours()] });
    const outcome = await replaceLeave(client, { id: "47", replacement: { leaveType: "1" }, confirm: true });
    expect(outcome.mode).toBe("replaced");
    expect(client.writes.map((w) => w.method)).toEqual(["cancelLeaveRequest", "submitLeaveRequest"]);
    const requests = await client.listLeaveRequests();
    expect(requests.map((r) => [r.id, r.status, r.days])).toEqual([
      ["47", "cancelled", 0.5],
      ["48", "pending", 1],
    ]);
  });

  it("files for the old request's date even though it is in the past", async () => {
    const client = fake({ fixture: hourlyForm, requests: [fourHours()] });
    const outcome = await replaceLeave(client, { id: "47", replacement: { leaveType: "1" } });
    expect(outcome.mode === "dry_run" && outcome.plan.toFile).toEqual(["2026-09-25"]);
  });

  it("leaves the old request alone when the new one cannot be filed", async () => {
    const client = fake({ fixture: hourlyForm, balances: { paid: 0.5 }, requests: [fourHours()] });
    const outcome = await replaceLeave(client, { id: "47", replacement: { leaveType: "1" }, confirm: true });
    expect(outcome.mode).toBe("blocked");
    expect(outcome.mode === "blocked" && outcome.plan.status).toBe("insufficient_balance");
    expect(client.writes).toEqual([]);
  });

  it("points to the administrator for an approved request", async () => {
    const client = fake({ fixture: hourlyForm, requests: [fourHours(), request("2026-08-14", { id: "41", status: "approved" })] });
    expect((await replaceLeave(client, { id: "41", replacement: { leaveType: "1" }, confirm: true })).mode).toBe("contact_admin");
    expect((await replaceLeave(client, { id: "404", replacement: { leaveType: "1" } })).mode).toBe("not_found");
    expect(client.writes).toEqual([]);
  });
});
