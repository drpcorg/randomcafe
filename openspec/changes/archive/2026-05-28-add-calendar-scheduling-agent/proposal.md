## Why

Random Coffee currently creates pairs and asks participants to coordinate meeting time themselves, leaving the highest-friction part of the workflow outside the bot. Adding calendar-assisted scheduling lets the bot turn a match into an actual coffee meeting while preserving a manual escape hatch for participants who prefer to arrange directly.

## What Changes

- Add a Pi SDK based scheduling agent, using `deepseek-v4-flash` by default, that can reason over participant preferences and conversation state for each coffee match.
- Add opt-in calendar availability integration for finding shared free slots for matched participants without exposing event details to the LLM or Slack.
- Add Slack controls for participants to accept a proposed slot, request alternatives, reject with a reason, provide free-text scheduling preferences, or switch to manual mode.
- Create a bot-owned calendar event only after both participants agree to the same slot and the slot is still available.
- Support manual mode: if either participant chooses to arrange themselves, the bot stops scheduling for that match, notifies the other participant, and continues normal Random Coffee reminders/feedback.
- Persist scheduling state, participant responses, proposed slots, and created calendar event identifiers so the flow survives restarts.

## Capabilities

### New Capabilities
- `calendar-assisted-scheduling`: Scheduling matched Random Coffee pairs through calendar availability, Pi agent slot negotiation, Slack participant controls, bot-owned event creation, and manual-mode fallback.

### Modified Capabilities

## Impact

- Adds Pi SDK integration to Cafe, following the runtime/session pattern used in `~/Work/paperpodcast`, with configuration for `PI_PROVIDER`, `PI_MODEL`, agent mode, timeout, and Pi credential mounting in Docker.
- Adds a calendar provider abstraction with an initial Google Calendar/Workspace adapter plus test fakes for reading free/busy availability and creating bot-owned events.
- Extends SQLite schema with scheduling requests, slot proposals, participant responses, scheduling conversation history, calendar availability identities, and verified invite addresses.
- Extends Slack App Home and match messages with calendar connection/preferences status and scheduling actions/modals.
- Updates Slack app scopes/events as needed for email identity mapping, interactive scheduling controls, and optional text preference intake.
- Adds tests for scheduling state transitions, agent tool boundaries, calendar-service behavior, Slack action handling, and persistence/restart behavior.
