#!/usr/bin/env node
/**
 * Read-only check of this client against real Jobcan. Signs in, fetches each page the
 * client reads, and reports what it understood. It sends GET requests and the sign-in
 * POST, nothing else. Reasons for leave are never printed.
 *
 * Usage: node dist/cli/verify.js [--fresh]
 *   --fresh  ignore the saved session and sign in again
 */
import { parse } from "node-html-parser";
import { HttpJobcanClient } from "../client/http/http-client.js";
import { Session } from "../client/http/session.js";
import { loadJar, saveJar, SESSION_FILE } from "../client/http/session-store.js";
import { getCredentials } from "../credentials.js";
import { addDays, monthOf, monthRange } from "../domain/dates.js";
import { availableBalances } from "../domain/balance.js";
import { CookieJar } from "tough-cookie";

const fresh = process.argv.includes("--fresh");
let failures = 0;

const heading = (title: string) => console.log(`\n== ${title}`);
const line = (label: string, value: unknown) => console.log(`  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

async function step<T>(title: string, run: () => Promise<T>): Promise<T | undefined> {
  heading(title);
  try {
    return await run();
  } catch (err) {
    failures++;
    console.log(`  FAILED: ${(err as Error).name}: ${(err as Error).message}`);
    return undefined;
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** Forms and links of a page, without any values: enough to see what it can do. */
function outline(html: string) {
  const root = parse(html);
  return {
    forms: root.querySelectorAll("form").map((f) => ({
      method: (f.getAttribute("method") ?? "get").toLowerCase(),
      action: (f.getAttribute("action") ?? "").split("?")[0],
      fields: f
        .querySelectorAll("input, select, textarea, button")
        .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute("type") ? `[${el.getAttribute("type")}]` : ""}:${el.getAttribute("name") ?? ""}`),
    })),
    links: [
      ...new Set(
        root
          .querySelectorAll("a[href]")
          .map((a) => (a.getAttribute("href") ?? "").split("?")[0]!)
          .filter((href) => /holiday|cancel/.test(href)),
      ),
    ],
    headings: root.querySelectorAll("h1, h2, h3, h4, h5, th").map((h) => h.text.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 40),
  };
}

const jar = fresh ? new CookieJar() : await loadJar();
const session = new Session({ jar });
const client = new HttpJobcanClient({ session, getCredentials, onSignedIn: () => saveJar(jar) });

console.log("jobcan-agent verify: read-only check against real Jobcan");
line("saved session", fresh ? "ignored (--fresh)" : SESSION_FILE);

const signIn = await step("Sign in", async () => {
  const result = await client.signIn();
  line("signed in now", result.signedIn ? "yes, with credentials from the Keychain" : "no, the saved session was still good");
  line("hops", result.hops);
  return result;
});

if (signIn) {
  const today = await client.getToday();
  const thisMonth = monthOf(today);
  const nextMonth = monthOf(addDays(monthRange(thisMonth).to, 1));

  for (const month of [thisMonth, nextMonth]) {
    await step(`Attendance ${month}`, async () => {
      const days = await client.getTimesheet(month);
      line("days", days.length);
      line("workdays", days.filter((d) => d.isWorkday).length);
      line("non-workday labels", countBy(days.filter((d) => !d.isWorkday), (d) => d.label ?? ""));
      line("days with a clock-in", days.filter((d) => d.clockIn).length);
    });
  }

  const types = await step("Leave types", async () => {
    const list = await client.listLeaveTypes();
    for (const t of list) line(`#${t.id}`, { name: t.name, category: t.category, balanceKey: t.balanceKey, unit: t.unit, days: t.days });
    return list;
  });

  await step("Leave form", async () => {
    const form = await client.discoverForm("leave");
    line("fingerprint", form.fingerprint);
    for (const f of form.fields) {
      line(f.name, { kind: f.kind, required: f.required, role: f.role, options: f.kind === "select" ? f.options.length : undefined });
    }
  });

  const requests = await step("Leave requests (180 days back, 365 ahead)", async () => {
    const list = await client.listLeaveRequests();
    line("count", list.length);
    line("by status", countBy(list, (r) => r.status));
    line("types we could not place", list.filter((r) => !r.leaveTypeId).length);
    for (const r of list.slice(0, 15)) {
      line(`#${r.id}`, { from: r.from, to: r.to, type: r.leaveTypeName, status: r.status, days: r.days, requestedOn: r.requestedOn });
    }
    return list;
  });

  await step("Status wording", async () => {
    const page = await client.page("/employee/holiday/");
    const cells = parse(page.body)
      .querySelectorAll("table tbody tr")
      .map((row) => row.querySelectorAll("td")[2]?.text.replace(/\s+/g, " ").trim())
      .filter((text): text is string => Boolean(text));
    line("as written by Jobcan (default list)", countBy(cells, (c) => c));
  });

  await step("Balances", async () => {
    const balances = await client.getLeaveBalances();
    for (const b of availableBalances(balances, requests ?? [])) {
      line(b.label, { key: b.key, category: b.category, remaining: b.remaining, pendingRequests: b.pending, available: b.available });
    }
    const unmatched = balances.filter((b) => b.key.startsWith("label:"));
    line("balances with no leave type", unmatched.map((b) => b.label));
    line("leave types with no balance", (types ?? []).filter((t) => !balances.some((b) => b.key === t.balanceKey)).map((t) => t.name));
  });

  const latest = requests?.[0];
  if (latest) {
    await step(`Request detail page (#${latest.id}, status ${latest.status})`, async () => {
      const page = await client.page(`/employee/holiday/info?applied_id=${encodeURIComponent(latest.id)}`);
      const { forms, links, headings } = outline(page.body);
      line("forms", forms);
      line("links", links);
      line("headings", headings);
    });
  }
  const pending = requests?.find((r) => r.status === "pending" && r.id !== latest?.id);
  if (pending) {
    await step(`Request detail page (#${pending.id}, pending)`, async () => {
      const page = await client.page(`/employee/holiday/info?applied_id=${encodeURIComponent(pending.id)}`);
      line("forms", outline(page.body).forms);
    });
  }
}

console.log(`\n${failures === 0 ? "All steps passed." : `${failures} step(s) failed.`}`);
process.exitCode = failures === 0 ? 0 : 1;
