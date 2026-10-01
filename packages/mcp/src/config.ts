import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Everything site-specific lives here. Selectors marked VERIFY are best guesses —
 * confirm them with the jobcan_inspect_page tool (or your old Raycast code) and adjust.
 */
export const KEYCHAIN_SERVICE = process.env.JOBCAN_KEYCHAIN_SERVICE ?? "jobcan-mcp";
export const PROFILE_DIR = process.env.JOBCAN_PROFILE_DIR ?? join(homedir(), ".jobcan-mcp", "profile");
export const HEADLESS = process.env.JOBCAN_HEADFUL !== "1";

export const URLS = {
  login: "https://id.jobcan.jp/users/sign_in",
  // SSO hop from Jobcan ID into 勤怠管理 (employee side)
  attendanceEntry: "https://ssl.jobcan.jp/jbcoauth/login",
  attendanceBase: "https://ssl.jobcan.jp",
  holidayNew: "https://ssl.jobcan.jp/employee/holiday/new", // VERIFY
  holidayList: "https://ssl.jobcan.jp/employee/holiday",     // VERIFY
};

export const SELECTORS = {
  loginEmail: "#user_email",                                   // VERIFY
  loginPassword: "#user_password",                             // VERIFY
  loginSubmit: "#login_button, input[type=submit], button[type=submit]",
  // Leave request form — VERIFY all of these
  holidayType: "select[name*='holiday_type'], select[name*='type']",
  holidayDate: "input[name*='date']",
  holidayReason: "textarea[name*='reason'], textarea[name*='note']",
  holidaySubmit: "input[type=submit], button[type=submit]",
  holidayListRows: "table tbody tr",
};
