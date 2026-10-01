import { chromium, type BrowserContext, type Page } from "playwright";
import { HEADLESS, PROFILE_DIR, SELECTORS, URLS } from "./config.js";
import { getCredentials } from "./credentials.js";

let ctx: BrowserContext | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Serialize all browser work — one page, one action at a time. */
export function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const page = await getPage();
    try {
      return await fn(page);
    } catch (err) {
      throw new Error(`${(err as Error).message} (at ${page.url()})`);
    }
  });
  queue = next.catch(() => undefined);
  return next;
}

async function getPage(): Promise<Page> {
  // Persistent profile = cookies survive restarts, so we rarely re-login.
  ctx ??= await chromium.launchPersistentContext(PROFILE_DIR, { headless: HEADLESS, locale: "ja-JP" });
  return ctx.pages()[0] ?? ctx.newPage();
}

function onLoginPage(page: Page) {
  return page.url().startsWith(URLS.login) || page.url().includes("/users/sign_in");
}

/** Navigate to an attendance URL, logging in first if the session expired. */
export async function gotoAuthed(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!onLoginPage(page) && page.url().startsWith(URLS.attendanceBase)) return;

  await page.goto(URLS.login, { waitUntil: "domcontentloaded" });
  if (onLoginPage(page)) {
    const { email, password } = await getCredentials();
    await page.fill(SELECTORS.loginEmail, email);
    await page.fill(SELECTORS.loginPassword, password);
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.click(SELECTORS.loginSubmit)]);
    if (onLoginPage(page)) throw new Error("Login failed — check Keychain credentials or whether 2FA/captcha appeared (run with JOBCAN_HEADFUL=1).");
  }
  await page.goto(URLS.attendanceEntry, { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!page.url().startsWith(URLS.attendanceBase)) throw new Error("Could not reach 勤怠管理 after login.");
}

export async function closeBrowser() {
  await ctx?.close();
}
