## Context

This project is starting from an empty implementation with OpenSpec initialized. The target product is a minimal Slack-first Random Coffee bot for one Slack workspace. The bot will be hosted locally in Docker, implemented with Node.js, and persist state in SQLite.

Participation is intentionally bounded by a configured Slack channel: users in the channel are considered potential participants, and users outside the channel are ignored. Users can additionally opt out through Slack App Home without leaving the channel. An admin configures the channel and schedule.

Because the app is hosted locally, the design should avoid requiring a public HTTPS endpoint. Slack Socket Mode is the simplest fit for receiving Slack events, App Home interactions, and interactive button payloads from a local container.

## Goals / Non-Goals

**Goals:**

- Provide an MVP Slack Random Coffee workflow entirely inside Slack.
- Let admins configure the coffee channel, first pairing date, frequency, timezone, and reminder timing.
- Use the configured Slack channel as the participant source of truth at each pairing cycle.
- Support opt-out and opt-in from Slack App Home.
- Generate random pairs with a simple bias toward people who have not met before or have not met recently.
- Leave one participant unpaired when the eligible participant count is odd, while avoiding repeatedly skipping the same person.
- Notify pairs and collect simple meeting feedback.
- Persist enough state to survive container restarts and avoid duplicate cycles/reminders.

**Non-Goals:**

- Calendar integration or automatic meeting scheduling.
- Department, interest, timezone, seniority, or preference-based matching.
- Rich analytics, leaderboards, or reporting dashboards.
- Multi-workspace SaaS installation flow.
- Web UI outside Slack.
- Holiday calendars or business-day-aware scheduling.
- Full conversation tracking or verification that a meeting actually occurred.

## Decisions

### Use Slack Bolt for Node.js with Socket Mode

The app will use Slack Bolt for Node.js and run in Socket Mode from a Docker container.

Rationale:
- Socket Mode works well for local hosting because Slack connects to the app over WebSocket and no public HTTPS callback URL is required.
- Bolt provides first-class handlers for App Home, actions, commands, and messaging.
- Node.js matches the requested runtime and has mature Slack SDK support.

Alternative considered: Slack Events API over HTTPS. This would require a public endpoint, reverse proxy, ngrok, or hosted infrastructure, which conflicts with the local-hosting MVP.

### Use SQLite as the single persistence layer

SQLite will persist configuration, opt-out state, cycles, matches, skipped users, reminders, and feedback. The database file will live in a Docker volume.

Rationale:
- Single-workspace MVP has low concurrency and small data volume.
- SQLite is simple to run locally and requires no separate database service.
- Durable local state is enough for schedule idempotency and history-aware pairing.

Alternative considered: Postgres. It adds operational complexity without clear MVP benefit.

### Treat channel membership as live source of truth at pairing time

The bot will fetch members of the configured channel when starting a pairing cycle. It will not maintain a realtime mirror of membership events.

Rationale:
- This is simpler and robust for MVP.
- Joining or leaving the channel naturally affects the next cycle.
- Current cycles remain stable after they are created.

Eligibility filter:
- Include active human Slack users who are members of the configured channel.
- Exclude Slack bots and deleted/deactivated users.
- Exclude users who are currently opted out.

### Use Slack App Home for user and admin controls

Slack App Home will show participant status and actions. Admin users will see schedule/channel controls in addition to normal participant status.

Rationale:
- The user explicitly expects the app UI to live where Slack apps/bots normally expose controls.
- App Home avoids a separate web UI and works well with Block Kit buttons/modals.

Admin authorization will be configured explicitly, for example through environment variables listing Slack user IDs allowed to manage settings.

### Implement an idempotent internal scheduler

The app will run a background scheduler inside the Node.js process. Schedule configuration is stored in SQLite. On startup and on an interval, the scheduler checks for due pairing cycles and reminders.

Schedule inputs will be intentionally narrow for MVP:
- First pairing date/time is a local ISO-8601 date-time without UTC offset, interpreted in the configured IANA timezone.
- Offset-bearing first pairing timestamps are rejected so recurring cycles remain tied to the configured timezone's wall-clock time.
- Frequency is `weekly` or `biweekly`.
- Reminder delay is a positive integer number of days less than the selected pairing interval.

Rationale:
- The app is a single local service; an external scheduler is unnecessary for MVP.
- Persisted cycle/reminder records allow safe restart handling.
- Narrow schedule formats avoid cron parsing and timezone precedence ambiguity.

Idempotency rules:
- A scheduled cycle has a stable scheduled timestamp.
- The app must not create more than one cycle for the same scheduled timestamp.
- Each cycle remains open until the next scheduled cycle timestamp.
- Starting a new cycle closes unresolved pairs from the previous cycle as expired.
- Reminder jobs must be persisted and marked sent to prevent duplicate reminders after restart.

### Use random candidate sampling with a concrete history score

For each cycle, the app will generate random candidate pairings and select a lowest-score candidate. When at least two pair arrangements are possible, the matcher will attempt at least 200 random candidate arrangements; duplicate candidate attempts are acceptable for MVP.

Pair penalties:
- never paired before: `0`
- last paired 6 or more completed cycles ago: `1`
- last paired 3 to 5 completed cycles ago: `5`
- last paired 1 to 2 completed cycles ago: `25`
- paired in the immediately previous completed cycle: `100`

A candidate arrangement score is the sum of its pair penalties. The matcher selects one of the lowest-scoring generated candidates, with random tie-breaking allowed.

This keeps the implementation simple while maximizing new acquaintances better than a single shuffle.

Odd participant handling:
- If the eligible count is odd, select one user to skip before pairing.
- Select among participants with the oldest `last_skipped_at`, treating never-skipped participants as oldest.
- Break skip ties randomly.
- Persist skipped user history so one person is not repeatedly left out.

### Start with individual DMs for pair and reminder notifications

The MVP will notify each participant individually with their assigned partner and include feedback buttons in reminders.

Rationale:
- Individual DMs require fewer Slack API edge cases than creating multiparty DMs.
- They are sufficient to tell both participants who their partner is.
- The implementation can later switch to a shared multiparty DM if desired.

Alternative considered: Create a shared DM with the bot and both participants. This improves coordination UX but can introduce extra Slack permission and API complexity, so it is left as a potential post-MVP enhancement.

### Treat feedback as pair-level state with recorded responses

Reminder buttons will offer:
- `Met`
- `Not yet`
- `Cannot meet`

For MVP, a single participant response can update the pair status. The app should still record who responded and when.

Pair outcomes:
- `active`: pair is open and can receive reminders.
- `met`: a participant reported that the pair met; stop reminders.
- `cancelled`: a participant reported that the pair cannot meet; stop reminders.
- `expired`: the cycle closed without terminal feedback; stop reminders.

Reminder lifecycle:
- Send the first reminder after the configured reminder delay.
- Send at most two reminders per pair per cycle.
- A `Not yet` response schedules another reminder only if the pair has not reached the two-reminder maximum and the cycle is still open.
- Opening the next scheduled cycle closes unresolved pairs from the previous cycle as `expired`.

### Bound Slack API operations and secure persisted state

The app will use Slack API pagination for channel membership and will support up to 200 eligible human participants by default. If the eligible participant count exceeds the configured limit, the cycle fails before creating pairs and records the reason.

Notification and reminder sends will persist send status. Successful sends are not repeated after restart; failed or rate-limited sends remain pending or failed for retry. Slack rate-limit responses will use Slack's indicated delay when available, otherwise exponential backoff.

Security boundaries:
- Process Slack events/actions only through authenticated Slack Bolt Socket Mode delivery; if HTTP mode is ever used, verify Slack request signatures and timestamps.
- Re-check admin Slack user ID authorization on every admin action.
- Validate all admin-submitted configuration before persistence/use.
- Use parameterized SQLite statements for Slack-derived or user-submitted values.
- Do not log Slack tokens, signing secrets, app tokens, or complete raw Slack payloads.

## Risks / Trade-offs

- Local app downtime may cause missed cycles or reminders → Persist scheduled timestamps and run overdue work on startup, with idempotency checks.
- Slack API permissions may be insufficient for private channel membership lookup or DMs → Document required scopes and require the bot to be invited to the configured channel.
- Slack rate limits may affect large channels → Send messages sequentially with retries/backoff and store send status.
- Individual DMs may make it slightly harder for a pair to start a conversation → Keep message copy clear and include partner mentions; consider shared DM post-MVP.
- One participant's feedback may not reflect the other participant's view → Record individual responses, but use the first terminal response as pair status for MVP simplicity.
- Admin identity configured by environment variable is simple but manual → Accept for local MVP; consider Slack user group or richer role management later.

## Migration Plan

1. Create Slack app configuration with Socket Mode enabled and required bot scopes.
2. Configure environment variables for Slack tokens, admin Slack user IDs, and SQLite path.
3. Run the Docker container with a persistent volume for the SQLite database.
4. Invite the bot to the configured coffee channel.
5. Use App Home as an admin to set the initial schedule.
6. Test with a small channel and a manual or near-term first pairing date.

Rollback is straightforward for MVP: stop the container. Existing Slack DMs remain as history, and SQLite state can be preserved, backed up, or deleted from the Docker volume.

## Open Questions

- Whether to switch from individual DMs to a shared multiparty DM after the MVP depends on real user feedback.
- The default reminder delay can be set to 3 days, but admins should be able to configure it.
