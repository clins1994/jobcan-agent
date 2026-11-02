# Sources of what the user actually did

The preset's "Backfill" section lists which of these to read. Read only the user's own items, only
for the month in question, and take nothing from them as final: they are evidence to show the user.

## Chat channel (Slack, Teams)

- Search the preset's channel for the user's own posts in the month (a message-search tool with the
  channel, the user and a date range). Include thread replies: plans often change in the thread
  ("I'll work half a day after all").
- Read each post for: the date it is about (often "tomorrow" relative to the post), whole day or
  part of it, hours if given, and later corrections.
- Do not read other people's posts, and do not go outside the month; if a post from the previous
  month is about a day in this one, the date is what matters.

## Calendar (Google Calendar, Outlook)

- List the user's out-of-office events for the month. An event carrying `jobcan:<id>` in its title
  or description is already matched to a Jobcan request; skip it.
- Other out-of-office events are hints, not leave: a short block at lunch, a trip, an errand may or
  may not have been time off. They go to "unclear" unless the chat channel says the same thing.
- Ordinary events (meetings, focus time, "Office" markers) are not evidence of absence.

## None

Some people announce nowhere. Then only Jobcan's own timesheet and requests are used, every workday
with no leave and no clock times is "nothing recorded", and the user is asked once whether any day
in the month was off.
