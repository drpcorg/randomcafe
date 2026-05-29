## 1. Project and Runtime Setup

- [x] 1.1 Initialize the Node.js project structure with TypeScript-compatible source, scripts, and dependency management
- [x] 1.2 Add Slack Bolt, SQLite, scheduling/time, environment validation, and test dependencies
- [x] 1.3 Create the Slack Bolt Socket Mode app entrypoint and graceful startup/shutdown flow
- [x] 1.4 Add Dockerfile, docker-compose configuration, and a persistent volume path for SQLite
- [x] 1.5 Add example environment configuration for Slack tokens, admin Slack user IDs, database path, and scheduler settings

## 2. SQLite Persistence

- [x] 2.1 Implement database initialization and migration execution on app startup
- [x] 2.2 Create tables for app configuration, opt-out state, pairing cycles, matches, skipped participants, reminders, and feedback responses
- [x] 2.3 Implement repository functions for reading and updating admin configuration
- [x] 2.4 Implement repository functions for participant opt-out and opt-in state
- [x] 2.5 Implement repository functions for cycles, matches, skip history, reminders, and feedback responses
- [x] 2.6 Ensure persisted records support idempotency for scheduled cycle timestamps and reminder sends

## 3. Slack App Home and Admin Controls

- [x] 3.1 Render Slack App Home for regular users with channel membership status, participation status, next cycle information, and opt-out/opt-in controls
- [x] 3.2 Render Slack App Home for configured admins with additional coffee channel and schedule settings
- [x] 3.3 Implement opt-out and opt-in interactive actions and refresh App Home after state changes
- [x] 3.4 Implement admin-only configuration interactions for channel, local first pairing date/time without UTC offset, `weekly`/`biweekly` frequency, IANA timezone, and reminder delay
- [x] 3.5 Reject non-admin attempts to submit admin configuration changes without mutating persisted configuration
- [x] 3.6 Validate admin-submitted configuration and reject inaccessible channels, offset-bearing first pairing timestamps, unsupported frequencies, invalid timezones, and invalid reminder delays

## 4. Participant Pool and Slack Integration

- [x] 4.1 Implement paginated Slack API lookup for all members of the configured coffee channel
- [x] 4.2 Implement Slack user profile lookup and filtering for active human users, excluding bots and deleted/deactivated users
- [x] 4.3 Combine channel membership, Slack user state, and persisted opt-out state into an eligible participant pool
- [x] 4.4 Enforce the configured maximum eligible participant count before matching
- [x] 4.5 Handle missing bot channel access, participant-limit violations, or Slack API failures with clear logs and no partial cycle creation

## 5. Matching Logic

- [x] 5.1 Implement pair history lookup and scoring data needed by the matcher
- [x] 5.2 Implement random candidate pairing generation with at least 200 candidate attempts when at least two pair arrangements are possible
- [x] 5.3 Implement the defined history-aware scoring penalties for never-met, older, recent, and previous-cycle pairings while allowing repeats
- [x] 5.4 Implement odd-count skip selection using oldest `last_skipped_at`, treating never-skipped participants as oldest
- [x] 5.5 Persist created matches and skipped participant records for each cycle
- [x] 5.6 Add unit tests for score selection, tie handling, repeat handling, and odd-count skip fairness

## 6. Scheduler and Cycle Processing

- [x] 6.1 Implement schedule calculation from local first pairing date/time without offset, `weekly`/`biweekly` frequency, and IANA timezone
- [x] 6.2 Implement a background scheduler loop that detects due pairing cycles and due reminders
- [x] 6.3 Ensure due pairing cycles are created exactly once per scheduled timestamp, including after app restart
- [x] 6.4 Implement cycle creation flow: load config, build participant pool, generate matches, persist cycle state, and enqueue notifications/reminders
- [x] 6.5 Ensure cycles with fewer than two eligible participants are recorded without creating matches
- [x] 6.6 Close unresolved pairs from the previous cycle as expired when a new cycle starts
- [x] 6.7 Add tests for due-cycle detection, timezone handling, idempotent cycle creation, and prior-cycle expiry

## 7. Pair Notifications and Reminders

- [x] 7.1 Implement individual Slack DM notification for each participant identifying their assigned partner and active cycle
- [x] 7.2 Persist notification send attempts and avoid duplicate notifications after restart
- [x] 7.3 Implement reminder message with `Met`, `Not yet`, and `Cannot meet` actions after the configured reminder delay
- [x] 7.4 Persist reminder jobs and mark them sent after successful Slack delivery
- [x] 7.5 Implement Slack rate-limit handling using Retry-After when present and exponential backoff otherwise
- [x] 7.6 Persist successful, pending, and failed send states so restart/retry does not duplicate successful sends

## 8. Feedback Handling

- [x] 8.1 Implement `Met` feedback action to record the response, mark the pair outcome as met, and stop future reminders for the pair
- [x] 8.2 Implement `Cannot meet` feedback action to record the response, mark the pair outcome as cancelled, and stop future reminders for the pair
- [x] 8.3 Implement `Not yet` feedback action to record the response and schedule another reminder only while the cycle is open and the pair has fewer than two reminders
- [x] 8.4 Stop reminders after `Met`, `Cannot meet`, max reminder count, or cycle expiry
- [x] 8.5 Preserve individual feedback responses while maintaining a single current pair outcome
- [x] 8.6 Refresh or update Slack messages after feedback so users can see the recorded state
- [x] 8.7 Add tests for feedback state transitions, max reminder count, cycle expiry, and reminder scheduling

## 9. Documentation and Verification

- [x] 9.1 Document required Slack app settings, Socket Mode setup, bot scopes, and channel invitation requirements
- [x] 9.2 Document local Docker setup, environment variables, SQLite volume, startup, shutdown, and rollback
- [x] 9.3 Document an MVP manual test plan covering admin setup, opt-out/opt-in, pairing, reminders, feedback, restart recovery, odd participant counts, rate limits, and participant limits
- [x] 9.4 Run automated tests and verify the OpenSpec requirements are covered by implementation or tests

## 10. Security and Operational Boundaries

- [x] 10.1 Ensure Slack events and interactive actions are processed only through authenticated Slack Bolt Socket Mode delivery, or through verified Slack signatures if HTTP mode is used
- [x] 10.2 Re-check configured admin Slack user IDs on every admin action before mutating settings
- [x] 10.3 Use parameterized SQLite statements for all Slack-derived and user-submitted values
- [x] 10.4 Redact Slack tokens, signing secrets, app tokens, and complete raw Slack payloads from logs
- [x] 10.5 Add tests or manual verification for participant limit enforcement, retry-safe send state, and security-sensitive input handling
