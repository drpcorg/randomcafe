# MVP Manual Test Plan

## 1. Admin setup

- Open the app Home tab as a configured admin.
- Save settings with:
  - channel ID where the bot is invited
  - local first pairing date/time without offset
  - `weekly` or `biweekly`
  - valid IANA timezone
  - reminder delay less than interval
- Verify invalid values are rejected and previous settings remain unchanged.
- Open App Home as a non-admin and verify admin controls are not available.

## 2. Participant status and opt-out

- Join the configured coffee channel as a test user.
- Open App Home and verify status is `participating`.
- Click `Opt out` and verify status changes to `opted out`.
- Click `Join matching again` and verify status returns to `participating`.
- Leave the channel and verify App Home indicates the user is not in the coffee channel.

## 3. Pairing cycle

- Set first pairing date/time to a near-term due time.
- Run the bot and wait for scheduler tick.
- Verify one cycle is recorded for the scheduled timestamp.
- Verify only active human channel members not opted out are paired.
- Verify users receive individual DM pair notifications.

## 4. Odd participant count

- Use an odd number of eligible users.
- Verify exactly one user is left unpaired.
- Run another cycle and verify recently skipped users are deprioritized for skipping.

## 5. Reminders and feedback

- Wait until reminder delay or adjust test data to make a reminder due.
- Verify reminder DMs include `Met`, `Not yet`, and `Cannot meet` buttons.
- Click `Met`; verify match outcome is terminal and no further reminders are sent.
- Click `Cannot meet`; verify match outcome is terminal and no further reminders are sent.
- Click `Not yet`; verify another reminder is scheduled only while the cycle is open and fewer than two reminders have been sent.
- Verify no pair receives more than two reminders per cycle.

## 6. Restart recovery

- Stop the container after pair notifications are sent.
- Restart it.
- Verify existing cycle/matches are loaded and successful sends are not duplicated.
- Verify pending/failed sends remain retryable.

## 7. Rate limits and retry state

- Simulate Slack rate-limit responses in tests or with a stubbed client.
- Verify the app respects `Retry-After` when available or uses exponential backoff.
- Verify successful sends remain `sent` and are not repeated.

## 8. Participant limit

- Set `MAX_PARTICIPANTS` lower than the eligible channel size.
- Trigger a cycle.
- Verify the cycle fails before pairs are created and records a failure reason.

## 9. Calendar-assisted scheduling

- Enable `CALENDAR_SCHEDULING_ENABLED=true` with a fake or test Google calendar setup.
- Verify App Home shows calendar scheduling status and preference defaults.
- Trigger a pairing cycle with both participants opted into calendar availability and verify each receives a scheduling proposal with accept, other options, suggest time, and manual controls.
- Have one participant submit a free-text preference such as "next week after lunch" and verify a refreshed proposal is sent.
- Have both participants accept the same active slot and verify exactly one bot-owned calendar event is created.
- Click an old/stale slot action after replanning and verify no event is created and the current state is returned.
- Choose manual mode as one participant and verify the other participant is notified, no calendar event is created, and normal reminders still run.
- Restart the app during an active scheduling request and verify responses continue against restored state.
- Simulate Pi/calendar unavailability and verify the configured fallback mode is applied.

## 10. Security-sensitive handling

- Verify admin action authorization is checked on submit, not only when opening the modal.
- Verify `.env` is not committed.
- Review logs and confirm Slack tokens, app tokens, signing secrets, and full raw payloads are not emitted.
