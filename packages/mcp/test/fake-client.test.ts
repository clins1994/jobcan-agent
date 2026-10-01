import { describe, expect, it } from "vitest";
import { JobcanRejection, readOnly, WRITE_METHODS, WriteBlockedError } from "../src/client/client.js";
import { FakeClient } from "../src/client/fake.js";
import { customSelectForm, FORM_FIXTURES, noHalfDaysForm, standardCalendar, ymdSelectsForm } from "../src/client/fixtures.js";
import { request, TODAY } from "./helpers.js";

const fake = (options: Partial<ConstructorParameters<typeof FakeClient>[0]> = {}) =>
  new FakeClient({ today: TODAY, balances: { paid: 10 }, ...options });

describe("reads", () => {
  it("reports the seeded date as today", async () => {
    expect(await fake().getToday()).toBe(TODAY);
  });

  it("returns only the calendar days it has, inside the range", async () => {
    const calendar = standardCalendar({ from: "2026-10-01", to: "2026-10-31" });
    const days = await fake({ calendar }).getCalendar({ from: "2026-10-30", to: "2026-11-02" });
    expect(days.map((d) => d.date)).toEqual(["2026-10-30", "2026-10-31"]);
  });

  it("lists the fixture's leave types and form", async () => {
    const client = fake({ fixture: noHalfDaysForm });
    expect((await client.listLeaveTypes()).map((t) => t.id)).toEqual(["1", "4", "5", "6"]);
    expect((await client.discoverForm("leave")).fingerprint).toBe(noHalfDaysForm.form.fingerprint);
  });

  it("reports balances without pending requests taken out, by default", async () => {
    const client = fake({ balances: { paid: 10, compensatory: 1 }, requests: [request("2026-10-05")] });
    expect(await client.getLeaveBalances()).toEqual([
      { key: "paid", label: "paid", category: "paid", remainingDays: 10, pendingAlreadyDeducted: false },
      { key: "compensatory", label: "compensatory", category: "compensatory", remainingDays: 1, pendingAlreadyDeducted: false },
    ]);
  });

  it("can report balances with pending requests taken out", async () => {
    const client = fake({ balancesDeductPending: true, requests: [request("2026-10-05")] });
    expect(await client.getLeaveBalances()).toMatchObject([{ key: "paid", remainingDays: 9, pendingAlreadyDeducted: true }]);
  });

  it("filters requests by overlap with a range", async () => {
    const client = fake({
      requests: [request("2026-09-30", { id: "1" }), request("2026-10-05", { id: "2", to: "2026-10-07", days: 3 }), request("2026-11-02", { id: "3" })],
    });
    expect((await client.listLeaveRequests()).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect((await client.listLeaveRequests({ from: "2026-10-07", to: "2026-10-31" })).map((r) => r.id)).toEqual(["2"]);
  });

  it("hands out copies, so callers cannot change its state", async () => {
    const client = fake({ requests: [request("2026-10-05", { id: "1" })] });
    (await client.listLeaveRequests())[0]!.status = "approved";
    (await client.listLeaveTypes())[0]!.days = 99;
    expect((await client.getLeaveRequest("1"))?.status).toBe("pending");
    expect((await client.listLeaveTypes())[0]?.days).toBe(1);
  });

  it("does not record reads as writes", async () => {
    const client = fake();
    await Promise.all([client.getToday(), client.listLeaveTypes(), client.getLeaveBalances(), client.listLeaveRequests(), client.discoverForm("leave")]);
    expect(client.writes).toEqual([]);
  });
});

describe("submitLeaveRequest", () => {
  it("creates a pending request and records the write", async () => {
    const client = fake();
    const created = await client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" });
    expect(created).toMatchObject({
      id: "1",
      from: "2026-10-05",
      to: "2026-10-05",
      leaveTypeName: "有給休暇(全日)",
      category: "paid",
      days: 1,
      status: "pending",
      requestedOn: TODAY,
    });
    expect(await client.listLeaveRequests()).toHaveLength(1);
    expect(client.writes).toEqual([{ method: "submitLeaveRequest", args: { leaveTypeId: "1", date: "2026-10-05" } }]);
  });

  it("numbers requests after the highest existing one", async () => {
    const client = fake({ requests: [request("2026-10-05", { id: "41" })] });
    expect((await client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-06" })).id).toBe("42");
  });

  it.each(FORM_FIXTURES.map((f) => [f.name, f] as const))("accepts a complete submission on the %s form", async (_, fixture) => {
    const client = fake({ fixture });
    const created = await client.submitLeaveRequest({
      leaveTypeId: "1",
      date: "2026-10-05",
      reason: "私用のため",
      fields: fixture === customSelectForm ? { custom_1: "2" } : undefined,
    });
    expect(created.status).toBe("pending");
  });

  it("rejects a submission missing a company-defined field", async () => {
    const client = fake({ fixture: customSelectForm });
    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" })).rejects.toThrow(JobcanRejection);
    expect(await client.listLeaveRequests()).toEqual([]);
  });

  it("rejects a half day where the company has none", async () => {
    const client = fake({ fixture: noHalfDaysForm });
    await expect(client.submitLeaveRequest({ leaveTypeId: "2", date: "2026-10-05" })).rejects.toThrow(/not an option/);
  });

  it("rejects a reason only when the leave type needs one", async () => {
    const client = fake({ fixture: ymdSelectsForm });
    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" })).resolves.toBeDefined();
    await expect(client.submitLeaveRequest({ leaveTypeId: "6", date: "2026-10-06" })).rejects.toThrow(JobcanRejection);
  });

  it("rejects a date that is already requested", async () => {
    const client = fake({ requests: [request("2026-10-05", { id: "7" })] });
    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" })).rejects.toThrow(/No\. 7/);
  });

  it("accepts a morning and an afternoon on one date", async () => {
    const client = fake();
    await client.submitLeaveRequest({ leaveTypeId: "2", date: "2026-10-05" });
    await expect(client.submitLeaveRequest({ leaveTypeId: "3", date: "2026-10-05" })).resolves.toBeDefined();
  });

  it("rejects once pending requests have used the balance", async () => {
    const client = fake({ balances: { paid: 1 } });
    await client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" });
    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-06" })).rejects.toThrow(JobcanRejection);
    expect(await client.listLeaveRequests()).toHaveLength(1);
  });

  it("does not limit a category without a balance", async () => {
    const client = fake({ balances: { paid: 0 } });
    await expect(client.submitLeaveRequest({ leaveTypeId: "6", date: "2026-10-05" })).resolves.toBeDefined();
  });

  it("records a rejected write too", async () => {
    const client = fake({ balances: { paid: 0 } });
    await client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" }).catch(() => undefined);
    expect(client.writes).toHaveLength(1);
  });
});

describe("cancelLeaveRequest", () => {
  it("cancels a pending request and frees its balance", async () => {
    const client = fake({ balances: { paid: 1 }, requests: [request("2026-10-05", { id: "1" })] });
    expect((await client.cancelLeaveRequest("1")).status).toBe("cancelled");
    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-05" })).resolves.toBeDefined();
  });

  it.each(["approved", "rejected", "cancelled"] as const)("rejects cancelling a request that is %s", async (status) => {
    const client = fake({ requests: [request("2026-10-05", { id: "1", status })] });
    await expect(client.cancelLeaveRequest("1")).rejects.toThrow(JobcanRejection);
    expect((await client.getLeaveRequest("1"))?.status).toBe(status);
  });

  it("rejects an unknown request", async () => {
    await expect(fake().cancelLeaveRequest("404")).rejects.toThrow(JobcanRejection);
  });
});

describe("approval", () => {
  it("takes the days off the balance when approved", async () => {
    const client = fake({ balances: { paid: 10 }, requests: [request("2026-10-05", { id: "1" })] });
    client.approve("1");
    expect((await client.getLeaveRequest("1"))?.status).toBe("approved");
    expect((await client.getLeaveBalances())[0]?.remainingDays).toBe(9);
  });

  it("reports the same balance before and after approval when pending is already taken out", async () => {
    const client = fake({ balancesDeductPending: true, requests: [request("2026-10-05", { id: "1" })] });
    const before = (await client.getLeaveBalances())[0]?.remainingDays;
    client.approve("1");
    expect((await client.getLeaveBalances())[0]?.remainingDays).toBe(before);
  });

  it("leaves the balance alone when rejected", async () => {
    const client = fake({ requests: [request("2026-10-05", { id: "1" })] });
    client.reject("1");
    expect((await client.getLeaveRequest("1"))?.status).toBe("rejected");
    expect((await client.getLeaveBalances())[0]?.remainingDays).toBe(10);
  });
});

describe("attendance", () => {
  it("records clock times for a day, waiting for approval", async () => {
    const client = fake();
    const day = await client.recordAttendance({ date: "2026-09-28", clockIn: "10:00", clockOut: "19:00", note: "手続き" });
    expect(day).toEqual({ date: "2026-09-28", isWorkday: true, clockIn: "10:00", clockOut: "19:00", pendingApproval: true });
    expect(await client.getTimesheet("2026-09")).toEqual([day]);
    expect(client.writes).toEqual([{ method: "recordAttendance", args: { date: "2026-09-28", clockIn: "10:00", clockOut: "19:00", note: "手続き" } }]);
  });

  it("lists the company's spots and accepts one by name", async () => {
    const client = fake({ spots: [{ id: "1", name: "本社" }, { id: "3", name: "在宅" }] });
    expect(await client.listAttendanceSpots()).toHaveLength(2);
    await expect(client.recordAttendance({ date: "2026-09-28", clockIn: "10:00", note: "x", spot: "在宅" })).resolves.toBeDefined();
    await expect(client.recordAttendance({ date: "2026-09-28", clockIn: "10:00", note: "x", spot: "月" })).rejects.toThrow(/group_id/);
  });

  it("returns only the month asked for", async () => {
    const timesheet = [
      { date: "2026-09-30", isWorkday: true, clockIn: "10:00", clockOut: "19:00" },
      { date: "2026-10-01", isWorkday: true, clockIn: "10:00" },
    ];
    expect((await fake({ timesheet }).getTimesheet("2026-10")).map((d) => d.date)).toEqual(["2026-10-01"]);
  });

  it("adds a clock-out to a day that has a clock-in", async () => {
    const client = fake({ timesheet: [{ date: "2026-09-28", isWorkday: true, clockIn: "10:00" }] });
    const day = await client.recordAttendance({ date: "2026-09-28", clockOut: "19:00", note: "打刻漏れ" });
    expect(day).toMatchObject({ clockIn: "10:00", clockOut: "19:00" });
  });

  it("rejects a record without a note, without a time, or with a bad time", async () => {
    await expect(fake().recordAttendance({ date: "2026-09-28", clockOut: "19:00", note: " " })).rejects.toThrow(/notice/);
    await expect(fake().recordAttendance({ date: "2026-09-28", note: "x" })).rejects.toThrow(/time: empty/);
    await expect(fake().recordAttendance({ date: "2026-09-28", clockIn: "25:99", note: "x" })).rejects.toThrow(/invalid/);
  });
});

describe("readOnly", () => {
  it("lets reads through", async () => {
    const client = readOnly(fake({ requests: [request("2026-10-05")] }));
    expect(await client.getToday()).toBe(TODAY);
    expect(await client.listLeaveRequests()).toHaveLength(1);
    expect((await client.listLeaveTypes()).length).toBeGreaterThan(0);
  });

  it("blocks every write before it reaches the client", async () => {
    const inner = fake({ requests: [request("2026-10-05", { id: "1" })] });
    const client = readOnly(inner);

    await expect(client.submitLeaveRequest({ leaveTypeId: "1", date: "2026-10-06" })).rejects.toThrow(WriteBlockedError);
    await expect(client.cancelLeaveRequest("1")).rejects.toThrow(WriteBlockedError);
    await expect(client.recordAttendance({ date: "2026-09-28", clockOut: "19:00", note: "x" })).rejects.toThrow(WriteBlockedError);

    expect(inner.writes).toEqual([]);
    expect((await inner.getLeaveRequest("1"))?.status).toBe("pending");
  });

  it("covers every method of the interface that is not a read", () => {
    const reads = ["getCalendar", "listLeaveTypes", "getLeaveBalances", "listLeaveRequests", "getLeaveRequest", "discoverForm", "getTimesheet", "listAttendanceSpots", "getToday"];
    const controls = ["approve", "reject"];
    const methods = Object.getOwnPropertyNames(FakeClient.prototype).filter((m) => m !== "constructor");
    const publicMethods = methods.filter((m) => !["mustFind", "nextId", "timesheetDay", "categoryOf"].includes(m));
    expect(publicMethods.filter((m) => !reads.includes(m) && !controls.includes(m)).sort()).toEqual([...WRITE_METHODS].sort());
  });
});
