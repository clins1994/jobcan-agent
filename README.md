# jobcan-agent

**English** | [日本語](README.ja.md) | [Português](README.pt.md)

> **Unofficial.** Not affiliated with DONUTS Co., Ltd., the vendor of Jobcan.

Lets an AI agent (Claude, ChatGPT, ...) work with Jobcan 勤怠管理: file leave, check balances, fill
in attendance, and keep your team's chat channel and your calendar in step. Every write is shown
to you as a plan first and sent only when you confirm.

- **MCP server** (`packages/mcp`): talks to Jobcan, over plain HTTP, and returns structured data.
- **Skills** (`skills/`): combine the MCP with the connectors your agent has (Slack or Teams,
  Google Calendar or Outlook), following your company's rules.
- **Preset** (`preset.example.md`): where those rules and your defaults go. Your real preset lives
  at `~/.config/jobcan-agent/preset.md` and is never committed.

## Safety rules

- Every write is a dry run until `confirm=true`, and you see the plan before you confirm.
- The HTTP client can reach only a fixed list of Jobcan pages, in any mode.
- Credentials stay in your OS keychain. They never pass through the chat or the model.
- Nothing company-specific is committed to this repository.

## Jobcan's terms

Jobcan's terms of use are an agreement between Jobcan and your company, not you personally. They
do not mention automation or scripts, but they do prohibit analysing the service and anything that
could disturb its operation ([basic terms](https://all.jobcan.ne.jp/terms/), article 9). This tool
signs in as you, reads the same pages your browser does, and paces its requests. Whether that is
acceptable is for you and whoever administers Jobcan at your company to decide. Ask them first.

## Status

Early development, verified on one company's Jobcan. See [Tested so far](#tested-so-far) and
[Not yet tested](#not-yet-tested).

## Quick start

Requirements: macOS (credentials are read from the Keychain), Node.js 20 or newer, and a Jobcan
account that signs in with email and password. Single sign-on and two-factor prompts are detected
and stop with a message; they are not supported yet.

```bash
git clone https://github.com/clins1994/jobcan-agent.git
cd jobcan-agent
npm install && npm run build
security add-generic-password -s jobcan-mcp -a you@example.com -w   # prompts for your password
npm run verify -w packages/mcp                                        # read-only check against Jobcan
```

Register the server with your agent. Writes are off unless you turn them on:

```bash
claude mcp add jobcan -- node "$PWD/packages/mcp/dist/index.js"                              # read-only
claude mcp add jobcan -e JOBCAN_ALLOW_WRITES=1 -- node "$PWD/packages/mcp/dist/index.js"     # writes allowed
```

For Claude Desktop, add `{"command": "node", "args": ["<repo>/packages/mcp/dist/index.js"],
"env": {"JOBCAN_ALLOW_WRITES": "1"}}` under `mcpServers.jobcan`.

Try: "check my leave balance", then "plan a day off next Friday", then confirm.

That is enough for the Jobcan tools. For the skills, which add the chat and calendar steps:

1. Copy [`preset.example.md`](preset.example.md) to `~/.config/jobcan-agent/preset.md` and fill
   it in with your channel, its rules and your usual day.
2. Make the skills visible to your agent. For Claude Code, link or copy them into
   `~/.claude/skills/`:

   ```bash
   for s in skills/*/; do ln -s "$PWD/$s" ~/.claude/skills/; done
   ```

3. Enable the connectors your preset uses (Slack or Teams, Google Calendar or Outlook) in your
   agent. A missing connector skips that step; it never blocks the Jobcan request.

Then, in a new session: "take next Friday off" or "backfill last month".

## Tested so far

All of this was run by the author against one company's real Jobcan, in the session that built the
agent. It worked end to end at least once; it is not proven for every setup.

- Sign-in with email and password; the saved session is reused; a second sign-in does not end an
  existing browser session.
- Reads: calendar (including future months), leave types, balances, requests, timesheet, and
  discovery of the leave form (fields, whether a reason is required, hour selects).
- Leave: full days and hourly leave (a 4-hour half day), past dates, the reason reused from the
  user's history when none is given, withdrawing a pending request, and replacing a pending hourly
  request with a full day.
- Attendance: a whole month of clock-ins and clock-outs (15 days, 30 records), working around
  hourly leave. A second run records nothing twice while the first awaits approval.
- The `jobcan-request-leave` skill, driven step by step: file; post in the channel per its rules
  and react; create the out-of-office event. The month-end procedure that became
  `jobcan-backfill`, driven the same way: reconcile the chat channel, the calendar and Jobcan;
  file the missing leave; fill in the attendance.
- 427 unit tests against fakes of the client and of Jobcan's pages, and `npm run verify` against
  the real thing.

## Not yet tested

- **Setup by a non-engineer**: handing an agent the repository link and asking to be set up, with
  no help from the author.
- **A fresh session** with the server registered and the skills linked: invoking a skill by name,
  or just saying "take next Friday off" or "backfill last month". So far the author drove the
  skills by hand, and `jobcan-backfill` has never run as a skill at all.
- **`jobcan-setup`**, the interactive preset builder. It does not exist yet; presets are written by
  hand. It should ask about your own workflow (chat only, calendar only, chat first and Jobcan
  later, your usual hours) and write the preset for you.
- **Other workflows**: calendar only, chat only, chat first; Teams and Outlook (reference notes
  exist, never run).
- **Other companies' Jobcan**: half-day leave types, 代休 and 振休, extra required form fields, an
  optional reason, single sign-on, two-factor sign-in.
- **After approval**: how approved records and leave read back from the timesheet, and whether
  Jobcan's balance already excludes pending requests (assumed not; the tool can only understate
  what is available).
- **Sudden absence**: post first, file in Jobcan within the company's deadline.
- MCPB bundle for one-click Claude Desktop install, remote transport, ChatGPT, evals, a nightly
  read-only smoke test.

## Contributing

Testing on your own Jobcan is the most useful contribution right now.

- **Open an issue** for anything that fails, asks a question it should not, or reads a page
  wrongly. The `npm run verify` output and the plan the tool showed you are the best evidence.
- **Open a pull request** for fixes and new cases. Say how you tested it, on real Jobcan or against
  the fakes, and what happened.
- **Keep company data out** of issues, pull requests and fixtures: no company names, channel names,
  people, Slack ids, leave-type names or screenshots with names. Describe the shape of what you
  saw instead.

## Development

```bash
npm test                          # unit tests, no network
npm run typecheck -w packages/mcp
```

[`packages/mcp/README.md`](packages/mcp/README.md) lists the tools and environment variables.
[`AGENTS.md`](AGENTS.md) is for agents working on the code.

## Inspiration

- [m13/calendar2jobcan](https://github.com/m13/calendar2jobcan): syncs Jobcan from Google Calendar or
  a CSV. The idea that attendance can be filled from what your calendar already knows comes from there.
- [clins1994/raycast-jobcan](https://github.com/clins1994/raycast-jobcan): the author's unfinished Raycast extension for
  Jobcan. Its recordings of Jobcan's login flow and endpoints were the starting point for the HTTP client.

## License

MIT
