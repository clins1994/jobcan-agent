# Jobcan agent preset

Copy this file to `~/.config/jobcan-agent/preset.md` and replace every value. Never commit your copy.
The skills read this file; the Jobcan tools do not need it.

## Where to announce leave

- Channel: `#time-off` (Slack channel id `C0000000000`, or the Teams team and channel)
- Mention: `<@U0000000001>` (manager), `<@U0000000002>` (HR), `<!subteam^S0000000003>` (my team)
- Message: `{mentions} {M}/{D}（{weekday}）{kind}／ジョブカン申請済み{reason?}` then an English line
  `{Mon} {D} ({Dow}) {kind_en} / Jobcan: done{reason?}`
  Kinds: 全休 / 午前休 / 午後休 / 時間休 {HH:MM}〜{HH:MM}
- Reaction once the Jobcan request is filed: `:white_check_mark:`
- Sudden absence: post first, file in Jobcan within 3 business days, then react
- Cancel or change: withdraw in Jobcan, then reply `取消` or `変更` in the thread of the original post
- Admin contact when an approved request must change: `<@U0000000002>`
- Languages: Japanese first, then English

## Calendar

- Google Calendar, primary calendar
- One out-of-office event per block of leave, title `OOO`, with `jobcan:<id>` in the title
- Full day = 00:00 to 24:00 in Asia/Tokyo; half or hourly day = the hours off

## My defaults

- "day off" or "all day" = the full-day paid leave type
- "half day" = 4 hours of hourly leave; morning off = 10:00–14:00, afternoon off = 15:00–19:00
- Usual hours: 10:00–19:00
- Attendance note (Jobcan requires one on manual records): `手続き`
- Clock-in spot: the first one
- Reason when I give none: reuse my last one, else `私用のため`

## Backfill

Which sources show what I actually did in a month (the `jobcan-backfill` skill reads these):

- Chat channel: yes, the channel above, my own posts and their threads
- Calendar: yes, out-of-office events on my primary calendar
- Neither: leave the two lines above as "no" and the skill will ask me instead

## Discovered form (optional)

Filled in by `jobcan-setup` once it exists; until then `jobcan_discover_forms` prints it.

- Fingerprint: `<from jobcan_discover_forms>`
- Leave types: `<from jobcan_list_leave_types>`
