# jobcan-mcp-server

MCP server for Jobcan 勤怠管理. Talks to Jobcan over plain HTTP, runs locally on stdio. Setup and
the quick start are in the [root README](../../README.md); this file covers the tools, the checks
and the environment variables.

## Tools

Writes run only when the server is started with `JOBCAN_ALLOW_WRITES=1`, and each call still needs
`confirm=true` on a plan the user has seen. Otherwise they stop at the dry run.

| Tool | What |
|---|---|
| `jobcan_get_today` | Today's date in Japan time |
| `jobcan_check_date` | Workday, weekend, national or company holiday, and leave already requested |
| `jobcan_get_leave_balance` | Remaining days per balance, minus pending requests |
| `jobcan_list_leave_types` | Leave types with unit (full day, half day, hourly) and balance |
| `jobcan_list_leave_requests` | Requests with status and days; optional `month` |
| `jobcan_request_leave` | Plans dates or ranges: skips non-workdays, previews the balance, fills the reason. Write. |
| `jobcan_cancel_leave_request` | Withdraws a pending request. Write. |
| `jobcan_replace_leave` | Withdraws a pending request and files another in its place, e.g. half day → full day. Write. |
| `jobcan_get_timesheet` | One month of attendance |
| `jobcan_list_attendance_spots` | The company's clock-in spots |
| `jobcan_record_attendance` | Fills clock times for worked days never clocked; works around hourly leave. Write. |
| `jobcan_discover_forms` | The leave form as the company configured it, with a fingerprint |
| `jobcan_inspect_page` | Dev helper: dumps a page's forms and links through a headless browser (needs Playwright's browser) |

## Checks

```bash
npm test            # unit tests, no network
npm run typecheck
npm run verify      # read-only check against real Jobcan with the Keychain credentials
```

`verify` signs in and reads every page the tools use. It sends GET requests and the sign-in POST,
nothing else, and prints leave types, balances and request dates, never reasons. `npm run verify
-- --fresh` ignores the saved session and signs in again.

## Environment variables

- `JOBCAN_ALLOW_WRITES=1`: allow the write tools.
- `JOBCAN_KEYCHAIN_SERVICE`: Keychain item to read credentials from. Default `jobcan-mcp`.
- `JOBCAN_SESSION_FILE`: where the HTTP session is saved, mode 600. Default `~/.jobcan-mcp/session.json`.
  Delete it to force a new sign-in.

For `jobcan_inspect_page` only:

- `JOBCAN_HEADFUL=1`: show the browser.
- `JOBCAN_PROFILE_DIR`: the browser profile. Default `~/.jobcan-mcp/profile`.
