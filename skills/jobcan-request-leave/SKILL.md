---
name: jobcan-request-leave
description: File leave in Jobcan and do what the user's company expects around it — announce it in the team's chat channel following the channel's own rules, and block the time on the user's calendar — with one preview and one confirmation. Use when the user asks to take, request, file or submit leave, a day off, a half day, hourly leave, or time off on given dates.
---

# jobcan-request-leave

Turns "I'm off on the 6th" into a Jobcan request, a channel post, and a calendar block, in that
order, with a single preview before anything is sent. Company-specific details never live in this
skill: they come from the user's preset.

## Needs

- The `jobcan` MCP server (tools `jobcan_*`), started with writes enabled.
- The user's preset at `~/.config/jobcan-agent/preset.md`. Read it first. If it is missing, stop and
  run `jobcan-setup` (or ask the user for the channel and its rules) before doing anything else.
- Chat and calendar connectors as available. A missing connector skips its step with a one-line
  note; it never blocks the Jobcan request.

## Procedure

1. **Understand the request.** Dates (expand "next Monday" with `jobcan_get_today`), whole day or
   part of it, and the reason if the user gave one. Map wording to a leave type with
   `jobcan_list_leave_types` and the preset's defaults ("day off" → which type; a half day at a
   company with hourly leave → that many hours, at the time the preset says). Ask only what the
   preset and the tools cannot answer.
2. **Check the calendar** for the dates (read-only) and mention conflicts in the preview.
3. **Plan in Jobcan**: `jobcan_request_leave` without `confirm`. Present the plan:
   dates filed, dates skipped and why, balance before → after, the reason to be sent and where it
   came from. If the balance is short, present the options and let the user choose. Never pick.
4. **Draft the announcements** from the preset, before anything is sent:
   - the channel message, using the preset's template, mentions and language;
   - the calendar event: out-of-office, auto-declining meetings, whole day for full days, only the
     hours off for a half or hourly day.
5. **One confirmation.** Show the Jobcan plan, the message text and the event in one preview and ask
   once. Then, in this order:
   1. `jobcan_request_leave` with `confirm: true`. Stop here if it fails.
   2. Post the message (`references/slack.md` or `references/teams.md`). Put the request id in it
      only if the preset's template has a place for it; otherwise keep it in the calendar event.
   3. Add the preset's reaction to the post if the rules ask for one.
   4. Create the calendar event (`references/gcal.md` or `references/outlook.md`) carrying
      `jobcan:<request id>`, so the three can be found from each other later.
6. **Report** what was done, with the request id, the message link and the event, and anything that
   was skipped.

## Rules

- Every write needs the user's yes on the exact preview. One yes covers the three steps of that
  preview, nothing else.
- Sudden absences: the preset may say to post first and file in Jobcan within a deadline. Follow
  it, and say when the Jobcan step is due.
- Changes and cancellations are `jobcan-cancel-leave`, not this skill.
- Never invent a reason silently: when Jobcan needs one and the user gave none, the tool reuses the
  user's usual one and marks it; say so in the preview.
- Do not post to any channel or calendar not named in the preset.
