# Operations

## Environment

Copy `.env.example` to `.env` and fill required values:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
ADMIN_USER_IDS=U01234567
DATABASE_PATH=/data/cafe.sqlite
LOG_LEVEL=info
SCHEDULER_INTERVAL_SECONDS=60
SCHEDULING_PLANNING_CONCURRENCY=4
MAX_PARTICIPANTS=200
MATCH_CANDIDATE_ATTEMPTS=200
MAX_REMINDERS_PER_MATCH=2
CALENDAR_SCHEDULING_ENABLED=false
PI_PROVIDER=deepseek
PI_MODEL=deepseek-v4-flash
```

Schedule settings are configured by admins from Slack App Home and persisted in SQLite. Calendar-assisted scheduling is disabled by default and can be enabled with `CALENDAR_SCHEDULING_ENABLED=true` after Pi and Google Calendar credentials are configured.

Valid schedule values:

- first pairing date/time: local ISO-8601 without offset, e.g. `2026-06-03T10:00`
- frequency: `weekly` or `biweekly`
- timezone: IANA timezone, e.g. `Europe/Berlin`
- reminder delay: positive integer days less than the pairing interval

## Local development

```bash
npm install
npm run dev
```

## Docker

```bash
docker compose up --build
```

The compose file bind-mounts local `./data` at `/data`, mounts the relative host path from `GOOGLE_CALENDAR_CREDENTIALS_PATH` at `/run/secrets/google-calendar-credentials.json`, and mounts `${HOME}/.pi/agent` read-only at `/root/.pi/agent` so the embedded Pi scheduling agent can reuse configured model credentials.

Run only one Slack Socket Mode consumer for the app token. Before switching between local `npm run dev` and Docker, stop the other process/container; duplicate consumers can split Slack interactive envelopes and cause delayed retries even when each process acknowledges quickly.

## Shutdown

The app handles `SIGINT` and `SIGTERM`, stops the scheduler, stops the Slack app, and closes SQLite.

## Rollback

1. Stop the container:

```bash
docker compose down
```

2. Keep local `./data/cafe.sqlite` to preserve state, or remove the local database files to reset.

Slack DMs already sent remain visible in Slack. To roll back calendar-assisted scheduling without removing data, set `CALENDAR_SCHEDULING_ENABLED=false`; existing scheduling rows become inert while existing Random Coffee reminders continue.

## Calendar-assisted scheduling

Optional calendar scheduling uses:

```env
CALENDAR_SCHEDULING_ENABLED=true
CALENDAR_PROVIDER=google
GOOGLE_CALENDAR_CREDENTIALS_PATH=/run/secrets/google-calendar.json
GOOGLE_CALENDAR_SUBJECT=calendar-bot@example.com
CALENDAR_BOT_CALENDAR_ID=calendar-bot@example.com
CALENDAR_AGENT_FALLBACK_MODE=manual
```

The Google adapter uses the same service-account credentials in two modes:

- free/busy reads use Domain-Wide Delegation with `GOOGLE_CALENDAR_SUBJECT` and only `https://www.googleapis.com/auth/calendar.freebusy` authorized in Google Admin;
- event writes use the service account without impersonation and `https://www.googleapis.com/auth/calendar.events` to create final coffee events in `CALENDAR_BOT_CALENDAR_ID`.

Share `CALENDAR_BOT_CALENDAR_ID` with the service-account email using `Make changes to events` so the bot can write there. If a pending scheduling request has no explicit calendar identity yet, the Slack host refreshes the participant profile and provisions calendar/invite identity from the Slack email before planning. Users outside the delegated domain must share their Google Calendar with the bot service account using `See only free/busy (hide details)`, or the configured Google credentials must otherwise have free/busy access.

Pending scheduling requests are planned in parallel up to `SCHEDULING_PLANNING_CONCURRENCY`. SQLite runs in WAL mode with a busy timeout, and related provisioning writes are grouped in transactions.

The bot reads only free/busy intervals, not private event titles or descriptions. Calendar events are created only after both participants select overlapping proposed slots and the final availability check passes.

If the Pi agent is unavailable, `CALENDAR_AGENT_FALLBACK_MODE` controls behavior:

- `manual`: switch the pair to manual scheduling.
- `failed`: mark scheduling failed while leaving the coffee match active.

## Security/operational notes

- Use Socket Mode for local hosting; do not expose unnecessary HTTP receivers.
- Do not commit `.env`.
- Logs redact Slack tokens/secrets and omit full raw Slack payloads.
- Do not log Google credentials, provider tokens, raw calendar payloads, or private calendar event metadata.
- SQLite writes use parameterized statements.
- Slack channel membership is paginated.
- Notification jobs persist sent/pending/failed state so retries do not duplicate successful sends.
