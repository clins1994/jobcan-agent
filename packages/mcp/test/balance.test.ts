import { describe, expect, it } from "vitest";
import { availableBalance, availableBalances, pendingDays } from "../src/domain/balance.js";
import type { LeaveBalance } from "../src/domain/types.js";
import { request } from "./helpers.js";

const paid = (remainingDays: number, pendingAlreadyDeducted = false): LeaveBalance => ({
  key: "paid",
  label: "有給休暇",
  category: "paid",
  remainingDays,
  pendingAlreadyDeducted,
});

describe("pendingDays", () => {
  it("adds up pending requests in the category", () => {
    const requests = [request("2026-10-05"), request("2026-10-06"), request("2026-10-07", { unit: "half_day_am", days: 0.5 })];
    expect(pendingDays(requests, "paid")).toBe(2.5);
  });

  it("ignores requests that are not pending", () => {
    const requests = [
      request("2026-10-05", { status: "approved" }),
      request("2026-10-06", { status: "rejected" }),
      request("2026-10-07", { status: "cancelled" }),
    ];
    expect(pendingDays(requests, "paid")).toBe(0);
  });

  it("ignores other balances", () => {
    expect(pendingDays([request("2026-10-05", { balanceKey: "compensatory" })], "paid")).toBe(0);
  });

  it("counts a multi-day request by its days", () => {
    expect(pendingDays([request("2026-10-05", { to: "2026-10-07", days: 3 })], "paid")).toBe(3);
  });
});

describe("availableBalance", () => {
  it("is the remaining balance when nothing is pending", () => {
    expect(availableBalance(paid(10), [])).toMatchObject({ key: "paid", remaining: 10, pending: 0, available: 10 });
  });

  it("subtracts pending requests", () => {
    const requests = [request("2026-10-05"), request("2026-10-06", { unit: "half_day_pm", days: 0.5 })];
    expect(availableBalance(paid(10), requests)).toMatchObject({ remaining: 10, pending: 1.5, available: 8.5 });
  });

  it("does not subtract twice when Jobcan already did", () => {
    const requests = [request("2026-10-05"), request("2026-10-06")];
    expect(availableBalance(paid(8, true), requests)).toMatchObject({ remaining: 8, pending: 0, available: 8 });
  });

  it("reaches exactly zero", () => {
    expect(availableBalance(paid(1), [request("2026-10-05")]).available).toBe(0);
  });

  it("goes negative when more is pending than remains", () => {
    expect(availableBalance(paid(1), [request("2026-10-05"), request("2026-10-06")]).available).toBe(-1);
  });

  it("hides floating-point noise from hourly leave", () => {
    const hourly = [0.1, 0.2].map((days, i) => request(`2026-10-0${i + 1}`, { unit: "hourly", days }));
    expect(availableBalance(paid(0.3), hourly)).toMatchObject({ pending: 0.3, available: 0 });
  });

  it("keeps half days exact", () => {
    const requests = Array.from({ length: 7 }, (_, i) => request(`2026-10-0${i + 1}`, { unit: "half_day_am", days: 0.5 }));
    expect(availableBalance(paid(3.5), requests).available).toBe(0);
  });
});

describe("availableBalances", () => {
  it("handles each balance on its own", () => {
    const balances: LeaveBalance[] = [
      paid(10),
      { key: "compensatory", label: "代休", category: "compensatory", remainingDays: 2, pendingAlreadyDeducted: false },
    ];
    const requests = [request("2026-10-05"), request("2026-10-06", { category: "compensatory", balanceKey: "compensatory" })];
    expect(availableBalances(balances, requests).map((b) => [b.key, b.available])).toEqual([
      ["paid", 9],
      ["compensatory", 1],
    ]);
  });

  it("keeps two special leaves apart", () => {
    const balances: LeaveBalance[] = [
      { key: "special", label: "特別休暇A", category: "special", remainingDays: 3, pendingAlreadyDeducted: false },
      { key: "special2", label: "特別休暇B", category: "special", remainingDays: 5, pendingAlreadyDeducted: false },
    ];
    const requests = [request("2026-10-05", { category: "special", balanceKey: "special2" })];
    expect(availableBalances(balances, requests).map((b) => [b.key, b.available])).toEqual([
      ["special", 3],
      ["special2", 4],
    ]);
  });
});
