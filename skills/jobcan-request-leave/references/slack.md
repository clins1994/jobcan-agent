# Slack

Use the Slack connector's tools. Names differ by host; the actions are:

1. **Find the channel** by the name in the preset (a channel-search tool). Use the channel id from
   then on. Never guess a channel.
2. **Read the channel's pinned or first messages** if the preset says the rules live there, and
   follow wording changes there over the preset.
3. **Post the message** (a send-message tool) with the preset's template filled in:
   - `{date}` in the channel's date style (the preset gives an example, e.g. `10/15（木）`);
   - `{kind}` as the channel writes it (full day, AM/PM, hours);
   - mentions as Slack user ids `<@Uxxxx>` or groups `<!subteam^Sxxxx>`, never plain names;
   - Japanese first, then English, when the preset lists both.
4. **React** to the post with the preset's reaction if the rules use one to mean "Jobcan done".
5. **Keep the message timestamp**: cancellations and changes are replies in this thread.

Never post in a DM or another channel because the target one could not be found; report instead.
