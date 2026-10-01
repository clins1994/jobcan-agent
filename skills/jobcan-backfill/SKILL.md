---
name: jobcan-backfill
description: Bring a past month in Jobcan up to date — compare what the user actually did (their chat posts, their calendar) with what Jobcan has, file the leave that is missing, then fill in the attendance for the days they worked — with one preview and one confirmation per step. Use when the user asks to backfill, catch up, fill in or close a month, or to record last month's attendance.
---

# jobcan-backfill

Month-end catch-up. Nothing is assumed about how the user works: the preset says which sources
count as evidence of what they did and what their usual day looks like.

## Needs

- The `jobcan` MCP server with writes enabled.
- The user's preset at `~/.config/jobcan-agent/preset.md`, in particular its "My defaults" and
  "Backfill" sections. Missing preset: stop and ask for the usual hours, the attendance note and
  which sources to check, then suggest saving them as a preset.
- Whatever connectors the preset's sources need. A missing connector means that source is skipped,
  and the report says so.

## Procedure

1. **Pick the month.** "Last month" is relative to `jobcan_get_today`. Confirm the month in one
   line if the user was vague.
2. **Gather, read-only.**
   - Jobcan: `jobcan_get_timesheet` for the month and `jobcan_list_leave_requests` for it.
   - Each source the preset lists (`references/sources.md`): the user's own posts in the channel
     for the month, out-of-office events on the calendar. Ignore other people's posts and events
     that are not about the user's absence.
3. **Build the month, one row per workday**, from the timesheet's own calendar (weekends and
   holidays are already marked there). For each day: what Jobcan has (leave, clock times, pending),
   what each source says (off, half day, hours, nothing).
4. **Sort the days into**:
   - agree: nothing to do;
   - leave missing in Jobcan: a source says off and Jobcan has no request;
   - unclear: sources disagree, a half day whose hours are not stated, an event that may not be
     leave (a lunch block, a trip), leave in the middle of a day;
   - nothing recorded: a workday with no leave and no clock times, to be filled in step 6.
   Show the table. **Ask about every unclear day before going on**; never resolve one by guessing.
   A source alone never proves leave: if the user says the calendar block was not leave, it is
   not leave.
5. **File the missing leave**: `jobcan_request_leave` for the confirmed dates, past dates allowed,
   the user's half-day rule from the preset for half days. One preview with the balance before
   and after, one yes, then `confirm: true`. Stop on any failure and report it.
6. **Fill in the attendance**: `jobcan_record_attendance` for the month with the preset's usual
   hours, note and spot. It skips days off, days already recorded, days on full-day leave and
   today, and works around hourly leave. Show its day-by-day plan (before → after), get one yes,
   then `confirm: true`.
7. **Report**: what was filed, what was recorded, what was skipped and why, and what still needs
   the user or an administrator (an approved request that is wrong, a day that could not be
   recorded).

## Rules

- Leave before attendance, always: the attendance plan depends on the leave being in Jobcan.
- Two confirmations, one per step. Do not merge them; the user may want the leave but not the
  attendance.
- Never record attendance for a day the user has not accounted for if a source says they were
  away that day; that day goes to "unclear".
- Do not post anything to the channel or the calendar in this skill. If the reconciliation shows a
  leave that was filed but never announced, say so and offer `jobcan-request-leave`'s announcement
  step separately.
- Jobcan is the source of truth for the result; the chat and calendar are evidence of intent.
