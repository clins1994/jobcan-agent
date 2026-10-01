import type { PlainDate } from "./dates.js";

/** The broad kind of leave. Several balances can share a category, e.g. special leaves. */
export type LeaveCategory = "paid" | "compensatory" | "substitute" | "special" | "other";

/** `partial_day` is a fixed fraction of a day that is neither half; it collides with everything. */
export type LeaveUnit = "full_day" | "half_day_am" | "half_day_pm" | "partial_day" | "hourly";

export interface LeaveType {
  id: string;
  /** Jobcan's name for the type, verbatim. Company-defined. */
  name: string;
  category: LeaveCategory;
  /** The balance this type draws from. Matches `LeaveBalance.key`. */
  balanceKey: string;
  unit: LeaveUnit;
  /** Balance used per day filed: 1 for a full day, 0.5 for a half day, 0 for hourly (see `minutesPerDay`). */
  days: number;
  /** Hourly leave only: how many minutes count as one day of balance. */
  minutesPerDay?: number;
}

/** `HH:MM` to `HH:MM`, on the same day. */
export interface TimeRange {
  start: string;
  end: string;
}

export interface LeaveBalance {
  key: string;
  /** Jobcan's name for the balance, verbatim. */
  label: string;
  category: LeaveCategory;
  remainingDays: number;
  /**
   * Whether `remainingDays` already excludes requests still waiting for approval.
   * When false, pending requests are subtracted to get what can actually be filed.
   */
  pendingAlreadyDeducted: boolean;
}

export type LeaveRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveRequest {
  id: string;
  from: PlainDate;
  to: PlainDate;
  leaveTypeId?: string;
  leaveTypeName: string;
  category: LeaveCategory;
  balanceKey: string;
  unit: LeaveUnit;
  /** Total balance the request uses. */
  days: number;
  status: LeaveRequestStatus;
  /** Hourly leave only. */
  time?: TimeRange;
  reason?: string;
  requestedOn?: PlainDate;
}

/** One day of leave to file. Ranges are expanded before they reach the client. */
export interface LeaveSubmission {
  leaveTypeId: string;
  date: PlainDate;
  /** Hourly leave only. */
  time?: TimeRange;
  reason?: string;
  /** Values for company-defined fields, keyed by field name or label. */
  fields?: Record<string, string>;
}

export interface TimesheetDay {
  date: PlainDate;
  isWorkday: boolean;
  /** Jobcan's label for a non-workday, verbatim. */
  label?: string;
  /** `HH:MM` */
  clockIn?: string;
  /** `HH:MM` */
  clockOut?: string;
  breakMinutes?: number;
  workedMinutes?: number;
  /** A manual record still waiting for approval. */
  pendingApproval?: boolean;
}

/** A place to clock in from, as the company configured it. */
export interface AttendanceSpot {
  id: string;
  name: string;
}

/** Clock times to add to one day. Jobcan requires a note on manual records. */
export interface AttendanceRecord {
  date: PlainDate;
  /** `HH:MM` */
  clockIn?: string;
  /** `HH:MM` */
  clockOut?: string;
  note: string;
  /** Spot id or name; the company's first spot when left out. */
  spot?: string;
}
