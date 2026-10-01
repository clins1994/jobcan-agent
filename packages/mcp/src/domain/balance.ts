import type { LeaveBalance, LeaveCategory, LeaveRequest } from "./types.js";

export interface AvailableBalance {
  key: string;
  label: string;
  category: LeaveCategory;
  /** What Jobcan reports. */
  remaining: number;
  /** Days held by requests still waiting for approval, subtracted by us. */
  pending: number;
  /** What can actually be filed now. */
  available: number;
}

/** Sums of hourly leave can carry floating-point noise; balances never need more precision than this. */
export const roundDays = (days: number) => Math.round(days * 1e6) / 1e6;

/** Days of one balance held by requests that are still waiting for approval. */
export function pendingDays(requests: LeaveRequest[], balanceKey: string): number {
  return requests
    .filter((r) => r.status === "pending" && r.balanceKey === balanceKey)
    .reduce((sum, r) => roundDays(sum + r.days), 0);
}

export function availableBalance(balance: LeaveBalance, requests: LeaveRequest[]): AvailableBalance {
  const pending = balance.pendingAlreadyDeducted ? 0 : pendingDays(requests, balance.key);
  return {
    key: balance.key,
    label: balance.label,
    category: balance.category,
    remaining: balance.remainingDays,
    pending,
    available: roundDays(balance.remainingDays - pending),
  };
}

export function availableBalances(balances: LeaveBalance[], requests: LeaveRequest[]): AvailableBalance[] {
  return balances.map((b) => availableBalance(b, requests));
}
