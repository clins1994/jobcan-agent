import { describe, expect, it } from "vitest";
import { classifyDate, nationalHoliday } from "../src/domain/holidays.js";

describe("nationalHoliday", () => {
  it("finds a fixed holiday", () => {
    expect(nationalHoliday("2027-01-01")?.name).toBe("元日");
  });

  it("finds a Monday holiday that moves each year", () => {
    expect(nationalHoliday("2026-10-12")?.name).toBe("スポーツの日");
    expect(nationalHoliday("2026-10-05")).toBeUndefined();
  });

  it("finds 振替休日 when a holiday falls on a Sunday", () => {
    // Constitution Day 2026-05-03 is a Sunday; the next free weekday is Wednesday the 6th
    expect(nationalHoliday("2026-05-03")?.name).toBe("憲法記念日");
    expect(nationalHoliday("2026-05-06")?.name).toContain("振替休日");
  });

  it("finds 国民の休日, a weekday between two holidays", () => {
    expect(nationalHoliday("2026-09-21")?.name).toBe("敬老の日");
    expect(nationalHoliday("2026-09-22")).toBeDefined();
    expect(nationalHoliday("2026-09-23")?.name).toBe("秋分の日");
  });

  it("returns nothing for an ordinary day", () => {
    expect(nationalHoliday("2026-10-06")).toBeUndefined();
  });
});

describe("classifyDate without Jobcan data", () => {
  it("treats an ordinary weekday as a workday", () => {
    expect(classifyDate("2026-10-06")).toEqual({
      date: "2026-10-06",
      kind: "workday",
      isWorkday: true,
      source: "fallback",
    });
  });

  it("treats Saturday and Sunday as weekend", () => {
    expect(classifyDate("2026-10-10").kind).toBe("weekend");
    expect(classifyDate("2026-10-11").kind).toBe("weekend");
  });

  it("names a national holiday", () => {
    expect(classifyDate("2026-10-12")).toMatchObject({
      kind: "national_holiday",
      isWorkday: false,
      name: "スポーツの日",
      source: "fallback",
    });
  });

  it("reports a holiday on a weekend as the holiday", () => {
    expect(classifyDate("2026-05-03").kind).toBe("national_holiday");
  });

  it("covers every day of Golden Week 2026", () => {
    const kinds = ["2026-04-29", "2026-04-30", "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07"]
      .map((d) => classifyDate(d).kind);
    expect(kinds).toEqual([
      "national_holiday", // 昭和の日
      "workday",
      "workday",
      "weekend",
      "national_holiday", // 憲法記念日 (Sunday)
      "national_holiday", // みどりの日
      "national_holiday", // こどもの日
      "national_holiday", // 振替休日
      "workday",
    ]);
  });

  it("cannot know about a company's New Year closure", () => {
    expect(classifyDate("2026-12-30").kind).toBe("workday");
    expect(classifyDate("2027-01-01").kind).toBe("national_holiday");
    expect(classifyDate("2027-01-04").kind).toBe("workday");
  });
});

describe("classifyDate with Jobcan data", () => {
  it("marks a company holiday on a weekday", () => {
    expect(classifyDate("2026-12-30", { date: "2026-12-30", isWorkday: false, label: "公休" })).toEqual({
      date: "2026-12-30",
      kind: "company_holiday",
      isWorkday: false,
      name: "公休",
      source: "jobcan",
    });
  });

  it("lets Jobcan make a national holiday a workday", () => {
    expect(classifyDate("2026-10-12", { date: "2026-10-12", isWorkday: true })).toMatchObject({
      kind: "workday",
      isWorkday: true,
      source: "jobcan",
    });
  });

  it("lets Jobcan make a Saturday a workday", () => {
    expect(classifyDate("2026-10-10", { date: "2026-10-10", isWorkday: true }).kind).toBe("workday");
  });

  it("still explains a weekend as a weekend", () => {
    expect(classifyDate("2026-10-10", { date: "2026-10-10", isWorkday: false, label: "公休" }).kind).toBe("weekend");
  });

  it("still names the national holiday", () => {
    expect(classifyDate("2026-10-12", { date: "2026-10-12", isWorkday: false, label: "祝日" })).toMatchObject({
      kind: "national_holiday",
      name: "スポーツの日",
      source: "jobcan",
    });
  });
});
