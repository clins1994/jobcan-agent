import { parse } from "node-html-parser";
import {
  ATTENDANCE_ORIGIN,
  ID_ORIGIN,
  RequestBlockedError,
  SIGN_IN_URL,
  type HttpResponse,
  type Session,
} from "./session.js";

export interface Credentials {
  email: string;
  password: string;
}

export class LoginFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginFailedError";
  }
}

/** Something a person has to deal with: a captcha, a second factor, an unfamiliar page. */
export class LoginChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginChallengeError";
  }
}

export interface LoginResult {
  /** False when the saved session was still good and no credentials were sent. */
  signedIn: boolean;
  hops: string[];
}

const EMPLOYEE_HOME = `${ATTENDANCE_ORIGIN}/employee`;
const ATTENDANCE_ENTRY = `${ATTENDANCE_ORIGIN}/jbcoauth/login`;

export function isSignInPage(response: Pick<HttpResponse, "url" | "body">): boolean {
  if (new URL(response.url).pathname.startsWith("/users/sign_in")) return true;
  return /<form[^>]+action="[^"]*\/users\/sign_in/i.test(response.body);
}

export function isEmployeePage(response: Pick<HttpResponse, "url" | "body">): boolean {
  const url = new URL(response.url);
  return url.origin === ATTENDANCE_ORIGIN && url.pathname.startsWith("/employee") && !isSignInPage(response);
}

export interface SignInForm {
  fields: Record<string, string>;
  emailField: string;
  passwordField: string;
}

/** Reads the sign-in form as it is served, hidden fields included, so nothing is hardcoded but the two inputs we fill. */
export function parseSignInForm(html: string): SignInForm {
  const root = parse(html);
  const form = root.querySelectorAll("form").find((f) => (f.getAttribute("action") ?? "").includes("/users/sign_in"));
  if (!form) throw new LoginChallengeError("The sign-in page has no sign-in form. Jobcan's login may have changed.");

  if (/captcha/i.test(form.outerHTML)) {
    throw new LoginChallengeError("The sign-in page is asking for a captcha.");
  }

  const fields: Record<string, string> = {};
  let emailField: string | undefined;
  let passwordField: string | undefined;
  for (const input of form.querySelectorAll("input")) {
    const name = input.getAttribute("name");
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (!name) continue;
    if (type === "password") passwordField = name;
    else if (type === "email" || /\[email\]$/.test(name)) emailField = name;
    else if (type === "checkbox" || type === "radio") {
      if (input.hasAttribute("checked")) fields[name] = input.getAttribute("value") ?? "on";
    } else fields[name] = input.getAttribute("value") ?? "";
  }

  if (!fields.authenticity_token) {
    const meta = root.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
    if (meta) fields.authenticity_token = meta;
  }
  if (!fields.authenticity_token) throw new LoginChallengeError("The sign-in form has no CSRF token.");
  if (!emailField || !passwordField) {
    throw new LoginChallengeError("The sign-in form has no email and password fields. It may use another sign-in method.");
  }
  return { fields, emailField, passwordField };
}

function signInError(html: string): string | undefined {
  const root = parse(html);
  const text = root.querySelector(".flash, .alert, .error, #error_explanation, .form-error")?.text.trim();
  return text ? text.replace(/\s+/g, " ").slice(0, 200) : undefined;
}

/**
 * Signs in to 勤怠管理. Sends credentials only when the session is not already good,
 * and only to Jobcan's own sign-in endpoint.
 */
export async function login(session: Session, getCredentials: () => Promise<Credentials>): Promise<LoginResult> {
  // signed out, Jobcan may send us to a page we do not read; that only means "not signed in"
  const home = await session.get(EMPLOYEE_HOME).catch((err: unknown) => {
    if (err instanceof RequestBlockedError) return undefined;
    throw err;
  });
  if (home?.status === 200 && isEmployeePage(home)) return { signedIn: false, hops: home.hops };

  const page = await session.get(`${SIGN_IN_URL}?app_key=atd`);
  if (isEmployeePage(page)) return { signedIn: false, hops: page.hops };
  if (page.status !== 200) throw new LoginFailedError(`The sign-in page answered ${page.status}`);

  const form = parseSignInForm(page.body);
  const { email, password } = await getCredentials();
  const posted = await session
    .postForm(SIGN_IN_URL, { ...form.fields, [form.emailField]: email, [form.passwordField]: password }, page.url)
    .catch((err: unknown) => {
      // after a sign-in, a page we do not know is an extra step such as a verification code
      if (err instanceof RequestBlockedError) {
        throw new LoginChallengeError(`Jobcan is asking for a second step to sign in (it went to ${err.target}).`);
      }
      throw err;
    });

  let landed = posted;
  if (isSignInPage(landed)) {
    throw new LoginFailedError(signInError(landed.body) ?? "Jobcan did not accept the email and password");
  }
  if (new URL(landed.url).origin === ID_ORIGIN) landed = await session.get(ATTENDANCE_ENTRY, landed.url);
  if (!isEmployeePage(landed)) {
    throw new LoginChallengeError(`Signed in, but could not reach 勤怠管理 (stopped at ${new URL(landed.url).pathname})`);
  }
  return { signedIn: true, hops: [...page.hops, ...posted.hops, ...(landed === posted ? [] : landed.hops)] };
}
