# Cafe — Slack Random Coffee

A minimal Slack-first Random Coffee bot for one workspace.

- Runtime: Node.js + Slack Bolt Socket Mode
- Persistence: SQLite
- Hosting: local Docker container
- UX: Slack App Home, DMs, interactive reminder buttons, optional calendar-assisted scheduling

## Quick start

1. Create a Slack app using `docs/slack-setup.md`.
2. Copy `.env.example` to `.env` and fill Slack tokens/admin IDs.
3. Run locally:

```bash
npm install
npm run dev
```

Or with Docker:

```bash
docker compose up --build
```

The bot persists data in `/data/cafe.sqlite` inside the Docker volume.

## App icon

Prepared Slack icon assets:

- `assets/slack-app-icon.svg` — source vector
- `assets/slack-app-icon-512.png` — upload this in Slack app Display Information
- `assets/slack-app-icon-1024.png` — high-resolution backup/export

Slack manifests cannot embed local icon files, so upload the PNG manually after creating the app from `slack-app-manifest.yml`.

## Calendar-assisted scheduling

Optional scheduling can use Pi (`deepseek-v4-flash` by default) plus Google Calendar free/busy to propose meeting slots. Before planning pending matches, the Slack host refreshes participant calendar identity from Slack profile email when no explicit calendar identity exists yet. Google free/busy reads use Domain-Wide Delegation with only `calendar.freebusy`; final event creation uses the service account directly with `calendar.events` on a bot-owned/shared calendar.

The bot proposes three equal slot options, lets each participant select every option that works, and creates a bot-owned calendar event only when their selections overlap. Either participant can switch a pair to manual mode; reminders still continue.

Keep `CALENDAR_SCHEDULING_ENABLED=false` for the original pairing-only behavior.

### Local scheduling test UI

To test the scheduling flow without Slack or Google Calendar, run:

```bash
npm run dev:scheduling-ui
```

Open <http://localhost:8787>. The page contains two local users (`U1`, `U2`), free-text scheduling messages, accept/manual buttons, fake calendars, and bot output from the real Pi scheduling agent.

## Documentation

- `docs/slack-setup.md` — Slack app settings, scopes, Socket Mode, channel setup
- `docs/operations.md` — Docker/local operation, environment, rollback
- `docs/manual-test-plan.md` — MVP verification checklist
