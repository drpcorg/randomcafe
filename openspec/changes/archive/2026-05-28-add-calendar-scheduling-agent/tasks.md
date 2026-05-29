## 1. Configuration and Dependencies

- [x] 1.1 Add Pi SDK and schema dependencies needed for embedded agent sessions and custom tools.
- [x] 1.2 Add Google Calendar API dependency and runtime configuration for `CALENDAR_SCHEDULING_ENABLED`, `CALENDAR_PROVIDER`, Google credentials, bot calendar ID, default duration, search horizon, minimum notice, default preferred weekday window, and `CALENDAR_AGENT_FALLBACK_MODE`.
- [x] 1.3 Add Pi runtime configuration for `PI_PROVIDER`, `PI_MODEL`, and `PI_AGENT_TIMEOUT_MS`, defaulting to `deepseek` / `deepseek-v4-flash`.
- [x] 1.4 Update `.env.example`, Dockerfile/compose, and operations docs to describe Pi credential mounting and Google Calendar credential setup.
- [x] 1.5 Update Slack manifest/docs with any required scopes for verified email mapping and scheduling interactivity.

## 2. Data Model and Repository

- [x] 2.1 Add SQLite migrations for calendar identities, verified invite addresses, scheduling preferences, scheduling requests, candidate slots, participant responses, scheduling messages, and scheduling notification/job metadata.
- [x] 2.2 Add TypeScript domain types for scheduling status, slot candidates, participant responses, scheduling preferences, calendar identities, verified invite addresses, fallback mode, and calendar events.
- [x] 2.3 Add repository methods to create/get/update scheduling requests idempotently per match.
- [x] 2.4 Add repository methods to save/list candidate slots, participant responses, scheduling messages, selected slots, Slack message references, and provider event IDs.
- [x] 2.5 Add repository methods for manual, booked, failed, and expired scheduling transitions with guards against invalid state changes.
- [x] 2.6 Add migration/repository tests proving existing Random Coffee data still loads and scheduling state survives restart.

## 3. Calendar Service

- [x] 3.1 Define a provider-neutral `CalendarService` interface for resolving availability identities and invite addresses, fetching free/busy intervals, finding shared slots, revalidating a slot, and creating bot-owned events.
- [x] 3.2 Implement a slot search/scoring module that combines free/busy intervals, duration, search horizon, minimum notice, structured preferences, rejected slots, and per-request text constraints.
- [x] 3.3 Implement a fake calendar service for unit tests and local development.
- [x] 3.4 Implement the initial Google Calendar/Workspace adapter for free/busy lookup and bot-owned event creation.
- [x] 3.5 Add idempotency handling for Google event creation using a key derived from scheduling request ID and accepted slot ID.
- [x] 3.6 Add calendar privacy tests verifying that event titles/descriptions/attendees from other meetings and provider tokens never enter agent prompts, Slack messages, or logs.

## 4. Pi Runtime and Scheduling Agent

- [x] 4.1 Add a Cafe Pi runtime helper modeled on PaperPodcast's `piRuntime.ts` for selecting configured models and reading Pi credentials from the mounted agent directory or environment.
- [x] 4.2 Implement `SchedulingAgent` with one in-memory Pi session per scheduling request, idle disposal, persisted message seeding, built-in tools disabled, and custom scheduling tools only.
- [x] 4.3 Add `get_scheduling_state` and `find_calendar_slots` custom tools that expose only sanitized request state and persisted candidate slots.
- [x] 4.4 Define a strict structured agent output format for proposals, participant-facing text, selected primary slot ID, alternative slot IDs, and fallback/manual recommendations.
- [x] 4.5 Validate agent output so unknown slot IDs, malformed responses, or unsafe recommendations are rejected and converted to manual/failed fallback behavior.
- [x] 4.6 Add tests for agent prompt construction, tool boundaries, output parsing, unavailable Pi model/credentials fallback, and persistence of scheduling conversation history.

## 5. Scheduling Orchestration

- [x] 5.1 Create a scheduling coordinator that starts a request after each new match when scheduling is enabled and leaves existing pair notifications unchanged when disabled.
- [x] 5.2 Hook scheduling request creation into cycle processing immediately after match creation without changing pair history or reminder creation semantics.
- [x] 5.3 Generate the initial proposal by invoking the scheduling coordinator/agent and persisting all candidate slots before Slack notifications are sent.
- [x] 5.4 Implement participant response handling for accept, reject, alternatives, text preference, and manual-mode actions.
- [x] 5.5 Implement transactional consensus detection: both participants must accept the same active persisted slot before event creation begins, and stale/terminal actions must not mutate scheduling state.
- [x] 5.6 Revalidate accepted slots immediately before booking and replan if availability changed.
- [x] 5.7 Create the bot-owned calendar event, persist the provider event ID, mark the request booked, and notify both participants.
- [x] 5.8 Expire non-terminal scheduling requests when the associated match/cycle reaches a terminal outcome.
- [x] 5.9 Add orchestration tests for proposed, booked, manual, failed, expired, participant-acceptance, replanning, and restart/idempotency flows.

## 6. Slack UX

- [x] 6.1 Extend App Home to show calendar scheduling status and controls for calendar identity/preference setup.
- [x] 6.2 Add Slack blocks for scheduling proposals with primary slot, optional alternatives, accept, request alternatives, suggest preference, and manual-mode actions.
- [x] 6.3 Add modal handling for free-text scheduling preferences and structured preference edits.
- [x] 6.4 Implement mirrored DM notification behavior so both participants receive consistent scheduling state updates.
- [x] 6.5 Implement manual-mode notification text that tells the other participant the pair will arrange manually and that the bot will only continue reminders.
- [x] 6.6 Add booked-event notification text with final date/time and attendee information.
- [x] 6.7 Add Slack action tests for authorization, stale slot/action handling, modal parsing, response persistence, and visible message updates.

## 7. Reminder and Notification Integration

- [x] 7.1 Ensure existing pair notification and reminder jobs remain retryable and are not duplicated by scheduling notifications.
- [x] 7.2 Add scheduling notification job support or equivalent retryable send state for proposals, manual-mode notices, replans, and booking confirmations.
- [x] 7.3 Ensure manual and booked scheduling states keep the associated Random Coffee match active until existing feedback/reminder logic resolves it.
- [x] 7.4 Add tests covering scheduling notification retry behavior and interaction with existing reminder/feedback outcomes.

## 8. Validation and Documentation

- [x] 8.1 Add unit tests for new calendar, agent, repository, Slack block, and scheduling state-machine modules.
- [x] 8.2 Add integration-style tests using the fake calendar service for a full match-to-booked flow and a full match-to-manual flow.
- [x] 8.3 Run `npm run typecheck`, `npm test`, and `npm run build` and fix regressions.
- [x] 8.4 Update README/operations docs with calendar scheduling setup, privacy boundaries, manual fallback behavior, and rollback instructions.
- [x] 8.5 Update manual test plan with Slack App Home setup, proposal response, free-text preference, manual mode, booking, retry, and restart scenarios.

## 9. Host-Neutral Scheduling Module

- [x] 9.1 Extract scheduling orchestration and agent logic into an independent `src/scheduling/` module with store and environment interfaces.
- [x] 9.2 Add host environment adapters so Slack delivery is an adapter and the scheduling core can run in a mock or future non-Slack host.
- [x] 9.3 Add mock-host integration tests for match-to-booked, manual-mode, and replan flows without a Slack client.
