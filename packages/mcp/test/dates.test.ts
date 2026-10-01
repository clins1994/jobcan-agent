import { describe, expect, it } from "vitest";
import {
  addDays,
  assertPlainDate,
  dayOfWeek,
  daysBetween,
  expandRange,
  fromParts,
  InvalidDateError,
  isPlainDate,
  isWeekend,
  monthOf,
  monthRange,
  todayIn,
  toParts,
} from "../src/domain/dates.js";

describe("isPlainDate", () => {
  it.each(["2026-10-05", "2024-02-29", "2026-12-31", "2000-02-29"])("accepts %s", (d) => {
    expect(isPlainDate(d)).toBe(true);
  });

  it.each([
    ["2026-02-29", "not a leap year"],
    ["2100-02-29", "century that is not a leap year"],
    ["2026-04-31", "April has 30 days"],
    ["2026-13-01", "month 13"],
    ["2026-00-10", "month 0"],
    ["2026-10-00", "day 0"],
    ["2026-10-5", "not zero padded"],
    ["2026/10/05", "slashes"],
    ["10-05-2026", "wrong order"],
    ["", "empty"],
    ["2026-10-05T00:00:00Z", "timestamp"],
  ])("rejects %s (%s)", (d) => {
    expect(isPlainDate(d)).toBe(false);
  });

  it("assertPlainDate throws a typed error", () => {
    expect(() => assertPlainDate("2026-02-30")).toThrow(InvalidDateError);
  });
});

describe("parts", () => {
  it("round-trips", () => {
    expect(toParts("2026-01-09")).toEqual({ year: 2026, month: 1, day: 9 });
    expect(fromParts(2026, 1, 9)).toBe("2026-01-09");
  });

  it("refuses impossible parts", () => {
    expect(() => fromParts(2026, 2, 30)).toThrow(InvalidDateError);
  });
});

describe("addDays", () => {
  it("crosses a month end", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });

  it("crosses a year end", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("handles February in leap and common years", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("is unaffected by daylight saving changes elsewhere", () => {
    // US clocks change on 2026-03-08 and 2026-11-01
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
  });
});

describe("daysBetween", () => {
  it("counts whole days, signed", () => {
    expect(daysBetween("2026-10-05", "2026-10-15")).toBe(10);
    expect(daysBetween("2026-10-15", "2026-10-05")).toBe(-10);
    expect(daysBetween("2026-10-05", "2026-10-05")).toBe(0);
  });
});

describe("dayOfWeek", () => {
  it("knows the weekday", () => {
    expect(dayOfWeek("2026-10-05")).toBe(1); // Monday
    expect(dayOfWeek("2026-10-10")).toBe(6); // Saturday
    expect(dayOfWeek("2026-10-11")).toBe(0); // Sunday
  });

  it("flags weekends", () => {
    expect(isWeekend("2026-10-10")).toBe(true);
    expect(isWeekend("2026-10-11")).toBe(true);
    expect(isWeekend("2026-10-12")).toBe(false);
  });
});

describe("expandRange", () => {
  it("includes both ends", () => {
    expect(expandRange({ from: "2026-10-05", to: "2026-10-07" })).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("gives one day when both ends match", () => {
    expect(expandRange({ from: "2026-10-05", to: "2026-10-05" })).toEqual(["2026-10-05"]);
  });

  it("crosses month and year ends", () => {
    expect(expandRange({ from: "2026-12-30", to: "2027-01-02" })).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("refuses a range that ends before it starts", () => {
    expect(() => expandRange({ from: "2026-10-15", to: "2026-10-05" })).toThrow(/ends before it starts/);
  });

  it("refuses a range longer than a year, which is usually a typo", () => {
    expect(() => expandRange({ from: "2026-10-05", to: "2027-10-15" })).toThrow(/longer than/);
  });

  it("refuses invalid ends", () => {
    expect(() => expandRange({ from: "2026-02-30", to: "2026-03-02" })).toThrow(InvalidDateError);
  });
});

describe("months", () => {
  it("monthOf", () => {
    expect(monthOf("2026-10-05")).toBe("2026-10");
  });

  it("monthRange covers the whole month", () => {
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("refuses invalid months", () => {
    expect(() => monthRange("2026-13")).toThrow(InvalidDateError);
    expect(() => monthRange("2026-1")).toThrow(InvalidDateError);
  });
});

describe("todayIn", () => {
  const lateEveningUtc = new Date("2026-09-29T15:30:00Z");

  it("defaults to Japan time", () => {
    expect(todayIn(undefined, lateEveningUtc)).toBe("2026-09-30");
  });

  it("differs by timezone at the same instant", () => {
    expect(todayIn("Asia/Tokyo", lateEveningUtc)).toBe("2026-09-30");
    expect(todayIn("UTC", lateEveningUtc)).toBe("2026-09-29");
    expect(todayIn("America/Los_Angeles", lateEveningUtc)).toBe("2026-09-29");
  });

  it("rolls over at midnight in Japan", () => {
    expect(todayIn("Asia/Tokyo", new Date("2026-12-31T14:59:59Z"))).toBe("2026-12-31");
    expect(todayIn("Asia/Tokyo", new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
  });
});
