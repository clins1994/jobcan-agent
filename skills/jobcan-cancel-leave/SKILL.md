---
name: jobcan-cancel-leave
description: Cancel or change leave already filed in Jobcan, and undo or update what was announced for it — the chat post's thread and the calendar block — with one preview and one confirmation. Use when the user wants to cancel, withdraw, drop, move or change a day off, half day or leave request.
---

# jobcan-cancel-leave

## Needs

The same as `jobcan-request-leave`: the `jobcan` MCP server with writes enabled, the preset at
`~/.config/jobcan-agent/preset.md`, and whatever chat and calendar connectors exist.

## Procedure

1. **Find the request** with `jobcan_list_leave_requests`. If more than one matches the user's
   words, ask which. Find the matching channel post (the preset's channel, the request's date) and
   the calendar event (`jobcan:<id>` in its title or description).
2. **Preview** with `jobcan_cancel_leave_request` (no `confirm`) for a cancellation, or
   `jobcan_replace_leave` (no `confirm`) for a change such as half day → full day. Show:
   - what happens in Jobcan;
   - the reply that will go in the original post's thread, using the preset's cancel or change
     wording;
   - the calendar event that will be deleted or replaced.
3. **Approved requests cannot be withdrawn by the user.** When the tool answers `contact_admin`,
   tell the user who to contact (the preset's admin contact) and still offer to post the thread
   reply and update the calendar, since the company may want the notice even before the admin acts.
4. **One confirmation**, then in order: Jobcan, thread reply, calendar.
5. **Report** what changed.

## Rules

- A chat message alone never cancels leave; Jobcan is the source of truth. Say so if the user asks
  to "just post that I'm not off anymore".
- Reply in the original post's thread, never with a new top-level post, unless the preset says
  otherwise or the original cannot be found (then say so and ask).
