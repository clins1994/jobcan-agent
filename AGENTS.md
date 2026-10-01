# AGENTS.md

Instructions for agents working in this repository. This file is the source of truth; `CLAUDE.md`
only imports it. Unofficial project, not affiliated with DONUTS.

## What this is

- `packages/mcp/`: MCP server for Jobcan 勤怠管理. Jobcan only: no chat, calendar, or company logic.
- `skills/`: orchestration skills that combine the MCP with the connectors the agent has.
- `preset.example.md`: generic template for the user-local preset.

## Rules you must follow

1. Every write tool is a dry run until `confirm=true`. Only pass `confirm=true` after the user
   has approved the exact preview.
2. Never ask for, echo, or store the user's Jobcan password. Credentials are read from the OS
   keychain by the server.
3. Never commit anything company-specific: company names, channels, people, Slack ids, form
   schemas, or presets. The preset lives at `~/.config/jobcan-agent/preset.md`. Sweep the diff
   before every commit.
4. If a leave balance is short, present the options and let the user choose. Never pick one.
5. On a captcha or an unexpected challenge, stop and ask before opening a visible window.
6. **READMEs come in several languages and must stay in step.** `README.md` (English) is the
   canonical text. Any change to it goes into `README.ja.md` and `README.pt.md` in the same
   commit, and every version starts with the same language line linking all of them. Adding a
   language means adding the file and the link in every existing version.

## Setup (development checkout)

```bash
npm install
npm run build
npm test
npm run verify -w packages/mcp   # read-only check against real Jobcan, needs the Keychain entry
```

Register the server with your agent host, pointing at `packages/mcp/dist/index.js`; set
`JOBCAN_ALLOW_WRITES=1` in its environment to allow writes. See `packages/mcp/README.md` for
credentials and environment variables, and the root `README.md` for the quick start.

---

## Project spec and state

Unofficial, personal open-source project. Goal: anyone using Jobcan 勤怠管理 can ask their agent to
file leave and manage attendance. Company-agnostic: nothing company-specific is ever committed.

### 0. Repository

Author identity for commits is `Caio Lins <dev@clins.me>` (GitHub `clins1994`), configured in this
repository's own git config. Remote: `https://github.com/clins1994/jobcan-agent`. MIT license.

### 0.5 Prior art

The author's unfinished Raycast extension, [clins1994/raycast-jobcan](https://github.com/clins1994/raycast-jobcan),
recorded Jobcan's login flow and endpoints. Everything useful from it is in
[What Jobcan does](#what-jobcan-does) below.

### 1. Architecture: one monorepo, two layers
```
<repo>/
├── README.md            # English, with a language line linking README.ja.md (Japanese) at the top.
├── README.ja.md         # Japanese. "Unofficial" notice at the top of both.
├── AGENTS.md            # setup instructions written FOR agents
├── packages/mcp/        # the MCP server (this scaffold moves here)
├── skills/              # orchestration skills, installed via `npx skills add <owner>/<repo>`
│   ├── jobcan-setup/          # interactive preset builder
│   ├── jobcan-request-leave/  # references/: slack.md, teams.md, gcal.md, outlook.md
│   ├── jobcan-cancel-leave/
│   └── jobcan-backfill/       # month-end catch-up (the spec's jobcan-fix-punch)
└── preset.example.md    # generic template only
```
- **MCP = Jobcan only.** No Slack/Calendar/company logic. Returns typed, structured data.
- **Skills = orchestration.** Combine the MCP with whatever connectors the agent has
  (Slack or Teams; Google Calendar or Outlook). Provider notes live in references/ files,
  not one skill per provider combination.
- Distribution: npm (`npx`), `.mcpb` in GitHub releases (one-click Claude Desktop install),
  `server.json` for the MCP Registry. Skills show up on skills.sh automatically via install telemetry.

### 2. MCP tools (v1)
Every write is a DRY RUN until `confirm=true`.

Leaves
- `jobcan_check_date(date)`: workday / weekend / national holiday / company holiday / already requested.
  Jobcan's calendar is the source of truth; `@holiday-jp/holiday_jp` is the fallback.
- `jobcan_get_leave_balance()`: remaining days per type, minus PENDING requests; half day = 0.5
- `jobcan_request_leave(dates|range, type, fields…, confirm)`: expands ranges, skips non-workdays
  with reasons, and previews "X of Y available, balance before → after". If the balance is short,
  return options and never pick one.
- `jobcan_list_leave_requests(month?)`: id, date, type, status
- `jobcan_cancel_leave_request(id, confirm)`: if already approved, return a clear "contact your admin"

Attendance
- `jobcan_get_today()`, `jobcan_punch(action)`, `jobcan_get_timesheet(month)` (flag gaps),
  `jobcan_request_correction(date, in?, out?, reason)`

Discovery / dev
- `jobcan_discover_forms(request_type, explore_options=true)`: read-only. Selects every option in
  every select and re-snapshots, to capture conditional fields. Returns a field tree + fingerprint.
- `jobcan_inspect_page(path)`: raw dev helper (already in the scaffold)

### 3. Forms are customized per company AND per employee type
- Filling is **schema-driven** (fields found by label/name from discovery), not fixed selectors.
  Only login and navigation are hardcoded.
- Validate input against the schema before submitting; missing required field → ask the user.
- Drift: fingerprint change or a Jobcan rejection → re-discover the changed form, show a diff,
  retry only after the user confirms.

### 4. Preset (user-local, never committed)
Saved at `~/.config/jobcan-agent/preset.md`. Two parts:
- **Policy** (human-written, shared out of band, e.g. dropped in company chat): notification channel,
  mentions, message template, languages, reactions, cancel wording, admin contact
- **Form schema** (discovered per user by `jobcan-setup`): leave types, required/optional fields,
  defaults the user chose ("day off" → which type, default reason…), plus fingerprint

`jobcan-setup` skill flow: crawl → ask only what forms can't answer (plain language) →
dry-run each form → user confirms → write preset.

### 5. Runtime rules
- **Headless always** (Playwright headless shell): no window, no Dock icon, no stolen focus.
- Separate persistent profile (`~/.jobcan-mcp/profile`); never touch the user's own browser.
- Captcha / unexpected challenge: stop and ASK before opening a visible window.
- Credentials never pass through chat or the model.
  - Local dev: macOS Keychain (`security`), already implemented
  - MCPB: `user_config` fields marked `sensitive` (stored in the OS keychain by Claude Desktop)
  - Later: optional 1Password (`op read`)
- Use the installed Google Chrome (`channel: "chrome"`); fall back to downloading Chromium.
- TO TEST: does the background login end the user's own Jobcan browser session?

### 6. Skills behavior (side effects are optional, per available connector)
- After a successful request: post in the preset's channel using its template, add the reaction,
  and create an **Out of office** event on the user's own calendar (OOO auto-declines meetings;
  half days → only that half).
- Before requesting: warn about calendar conflicts on those days.
- The Jobcan request ID (`jobcan:<id>` in the event description / message) links request ↔ message ↔
  event. Cancel = withdraw in Jobcan + reply with the preset's cancel wording in the thread +
  delete the event.
- Connector missing → skip that step with a one-line note.
- Setup: `setup` opens a LOCAL page for the password (never pasted into chat); `verify` does a
  read-only login + balance check and reports ready or a plain-language fix.

### 7. Quality
- Split pure logic from a `JobcanClient` interface: `PlaywrightClient` + in-memory `FakeClient`.
- Unit tests: ranges across weekends/holidays/month ends, 振替休日, Golden Week, New Year,
  half days, pending requests, exactly-zero and short balances, duplicates, past dates.
- Form fixtures for the fake: minimal, reason required, custom select, no half days, Y/M/D selects.
- Agent evals against the fake: prompt + seeded state → expected tool calls + final state
  (e.g. "off oct 5~15" → 8 workdays, no submit before confirm; "leave on Saturday" → nothing filed;
  ambiguous cancel → asks which one; Japanese in → Japanese out).
- Skill evals: correct connector calls, correct message, cancel cleans up all three.
- Read-only nightly smoke test against real Jobcan to catch UI changes.
- Every bug becomes an eval case before it's fixed.

### 8. Phases
1. Own Mac: verify login/navigation, build logic + FakeClient + tests, discovery, one real end-to-end run
2. MCPB bundle + `jobcan-setup` skill + no-terminal install
3. Pilot with one non-technical user, no help given
4. Later: remote transport (Streamable HTTP + OAuth, e.g. Cloudflare Workers + Browser Rendering)
   for ChatGPT and phones; late arrival / early leave / stepping-away requests

### Current state (2026-09-30)

Works, against one company's real Jobcan:

- `packages/mcp/src/domain/`: pure logic. Dates are `YYYY-MM-DD` strings in Japan time, never local
  `Date`s. `leave-plan.ts` and `attendance-plan.ts` are the planners behind every dry run.
- `src/client/client.ts`: the `JobcanClient` interface. `src/client/fake.ts` + `fixtures.ts`: the
  in-memory fake with synthetic form fixtures. `src/client/http/`: the real client.
- `src/client/http/session.ts` allows only listed pages: a fixed set of GETs, the sign-in POST, and,
  with `allowWrites`, exactly `POST /employee/holiday/confirm`, `POST /employee/holiday/save`,
  `POST /employee/adit/insert/` and `GET /employee/holiday/delete/`. A redirect is never followed
  into a write; after a write, a redirect to an unlisted page is left unfollowed and the outcome is
  read from the list instead.
- `src/usecases/leave.ts`: what the tools call. A write is reached only when `confirm === true`
  and the plan is `ready`. `replaceLeave` plans as if the old request were gone, withdraws, then
  files, and reports an uncovered day if the second step fails.
- `src/index.ts`: the MCP tools. `JOBCAN_ALLOW_WRITES=1` turns writes on.
- `src/cli/verify.ts` (`npm run verify`): read-only check of every page. Run it when Jobcan changes.
- Skills `jobcan-request-leave`, `jobcan-cancel-leave` and `jobcan-backfill` (month-end catch-up;
  the spec called it `jobcan-fix-punch`) exist. The first was exercised by hand end to end; the
  procedure behind the third was run by hand before it was written as a skill. `jobcan-setup` does
  not exist. No MCPB bundle, `server.json`, evals or
  nightly smoke test yet.
- 427 unit tests. Pages are fetched in English (`employee_language=en` cookie); parsers rely on it.

### What Jobcan does

Verified live on 2026-09-29 and 2026-09-30.

- Sign-in: `GET id.jobcan.jp/users/sign_in?app_key=atd`, `POST` the form (a Rails
  `authenticity_token` plus hidden fields), then redirects through `/oauth/authorize` and
  `ssl.jobcan.jp/jbcoauth/callback` to `/employee`. The session is the `sid` cookie. A second sign-in
  does not end an existing one.
- Leave types: `var holidays = {...}` on `/employee/holiday/new`; the visible select is empty until
  the page's script fills it. `holiday_type` is the balance key (paid, compensatory, substitute,
  special, special2, ...). `paid_type`: 10 or 0 = full day, -1 = hourly, anything else = tenths of
  a day. `hourlyLeaveDayMin` = minutes per day of hourly leave.
- Reason rule, from the page: `#holiday-reason-required` alone = every type; with
  `#holiday-reason-optional` too = every type except annual paid leave; neither = optional.
- Hour selects (`start[h][0]` etc.) start at 03:00: option value = hour − 3. Hours must be encoded
  through the select's labels (`TimePartsField.hours`). Minutes are on a 10-minute grid.
- Balances: `/employee/attendance`, "Remaining Vacations" card, matched to leave types by the `type`
  label in the embedded data. Whether they already exclude pending requests is unknown; assumed
  not, which can only understate what is available.
- Calendar: the attendance page's "Holiday Type" column, filled in for future months.
- Requests: `/employee/holiday/?search_type=term&from[y]…`; hourly leave shows as `10:00～14:00`;
  a pending request reads "Waiting for Approval".
- Filing: `POST /employee/holiday/confirm` returns the save form (nothing saved yet; past dates are
  accepted), then re-post that form's hidden fields to `POST /employee/holiday/save`, then find the
  new request in the list.
- Withdrawing a pending request: `/employee/holiday/delete-confirm/?applied_id=N` links to
  `GET /employee/holiday/delete/?applied_id=N&token=…` (a GET that writes), then Jobcan lands on
  `/employee/holiday/delete-finish`. Approved requests have no cancel control.
- Manual clock records: `POST /employee/adit/insert/` as XHR, one per time, with the clock-edit
  page's `token`, `client_id`, `employee_id`, `time` as HHMM, `group_id` (spot) and `notice`
  (required when the label says "(Required)"). Answer `{result: 1}` or `{result: 0, errors}`.
  Until approved, the timesheet hides the times and marks the row `jbc-table-warning`
  (`TimesheetDay.pendingApproval`); the planner skips such days.

### Owner decisions

- Reads of real Jobcan are fine without asking. Every write gets a previewed "yes" from the owner
  first (Jobcan, chat posts, calendar events alike).
- Writes for leave and attendance were enabled on 2026-09-30 and used for real.
