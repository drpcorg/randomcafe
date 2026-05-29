## Why

Teams need a lightweight way to encourage informal cross-team conversations without manually coordinating participants and pairings. A minimal Slack-first Random Coffee bot can use an existing Slack channel as the participation boundary, pair people on a schedule, and collect simple meeting outcomes without introducing a separate web app.

## What Changes

- Add a Slack Random Coffee bot that runs locally in Docker using Node.js and SQLite.
- Allow an admin to configure the coffee channel, first pairing date, pairing frequency, timezone, and reminder timing.
- Use membership in the configured Slack channel as the source of participants.
- Allow participants to opt out and opt back in through Slack App Home while remaining in the channel.
- Generate random pairs for each scheduled cycle, biased toward new acquaintances while allowing repeats when needed.
- If there is an odd number of eligible participants, leave one participant unpaired for the cycle and prioritize fairness across cycles.
- Notify each pair in Slack and send follow-up reminders.
- Ask participants whether they met, have not met yet, or cannot meet, and record the outcome.

## Capabilities

### New Capabilities
- `slack-random-coffee`: Slack-based scheduled random coffee pairings, channel-scoped participant management, opt-out, reminders, and meeting feedback.

### Modified Capabilities
- None.

## Impact

- New Slack app/bot integration using Slack Bolt for Node.js, likely in Socket Mode for local Docker hosting.
- New SQLite persistence for configuration, user opt-out state, pairing cycles, match history, skipped participants, reminders, and feedback.
- New Docker-based local runtime with persistent SQLite volume.
- New scheduler/background worker behavior for pairing cycles and reminders.
- Slack permissions will be required for App Home, interactive buttons, channel membership lookup, profile/user lookup, and direct messaging or multiparty messaging.
- Security-sensitive Slack inputs, admin actions, and SQLite writes will need validation, authorization checks, safe persistence, and token-safe logging.
- Slack API pagination, rate limits, and notification retry behavior will need to be handled for bounded local operation.
