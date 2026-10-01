# Google Calendar

Use the Google Calendar connector's tools on the user's primary calendar.

- **Before filing**: list events on the dates (read-only) and mention conflicts with other people's
  meetings in the preview. Do not decline anything yourself.
- **After filing**: create one event per contiguous block of leave:
  - `eventType: OUT_OF_OFFICE` so invitations during it are declined automatically;
  - full day: from 00:00 to 00:00 the next day in the user's timezone (out-of-office events are
    timed, not all-day);
  - half or hourly day: exactly the hours off;
  - title: the preset's event title (or "OOO"), followed by ` · jobcan:<request id>`. Out-of-office
    events refuse a description (the API answers "invalid argument"), so the id lives in the title;
  - no description, no attendees, no reminders beyond the calendar's defaults.
- **On cancellation**: find the event by `jobcan:<id>` in its title and delete it.

Never create events on shared or other people's calendars.
