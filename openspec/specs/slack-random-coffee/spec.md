# slack-random-coffee Specification

## Purpose
TBD - created by archiving change add-slack-random-coffee. Update Purpose after archive.
## Requirements
### Requirement: Admin configures the coffee program
The system SHALL allow configured admin users to set and update the Slack coffee channel, first pairing date and time, pairing frequency, timezone, and reminder delay from within Slack. Configured admin users SHALL be identified by Slack user IDs supplied through app configuration, such as an environment variable.

Valid configuration values SHALL include:
- Slack coffee channel: a Slack channel ID that the bot can access.
- First pairing date and time: a local ISO-8601 date-time without a UTC offset, such as `2026-06-03T10:00`, interpreted in the configured timezone.
- Pairing frequency: `weekly` or `biweekly`.
- Timezone: an IANA timezone identifier, such as `Europe/Berlin`.
- Reminder delay: a positive integer number of days less than the selected pairing interval.

Offset-bearing first pairing timestamps SHALL be rejected so recurring cycles remain tied to the configured timezone's wall-clock date and time.

#### Scenario: Admin saves initial schedule
- **WHEN** a configured admin selects a coffee channel and provides a valid first pairing date, frequency, timezone, and reminder delay
- **THEN** the system SHALL persist the configuration and use it for future pairing cycles

#### Scenario: Admin submits invalid configuration
- **WHEN** a configured admin submits an inaccessible channel, malformed first pairing date, offset-bearing first pairing date, unsupported frequency, invalid timezone, or invalid reminder delay
- **THEN** the system SHALL reject the configuration and keep the existing configuration unchanged

#### Scenario: Non-admin attempts to change settings
- **WHEN** a non-admin user attempts to access or submit coffee program settings
- **THEN** the system SHALL prevent the change and keep the existing configuration unchanged

#### Scenario: Schedule is incomplete
- **WHEN** no complete schedule configuration exists
- **THEN** the system SHALL NOT create scheduled pairing cycles

### Requirement: Channel membership defines the participant pool
The system SHALL determine the participant pool from the members of the configured Slack channel at the time a pairing cycle starts.

#### Scenario: User is in the configured channel
- **WHEN** a human, active Slack user is a member of the configured coffee channel and is not opted out
- **THEN** the system SHALL include that user in the eligible participant pool for the cycle

#### Scenario: User is outside the configured channel
- **WHEN** a Slack user is not a member of the configured coffee channel
- **THEN** the system SHALL exclude that user from the eligible participant pool for the cycle

#### Scenario: User is not eligible for matching
- **WHEN** a configured channel member is a bot, deleted, deactivated, or opted out
- **THEN** the system SHALL exclude that user from the eligible participant pool for the cycle

### Requirement: Participants manage opt-out status in Slack
The system SHALL expose Slack App Home controls allowing participants to opt out of future pairings and opt back in.

#### Scenario: Participant opts out
- **WHEN** a participant chooses the opt-out action in Slack App Home
- **THEN** the system SHALL persist the participant as opted out and exclude them from future pairing cycles while they remain opted out

#### Scenario: Participant opts back in
- **WHEN** an opted-out participant chooses the opt-in action in Slack App Home
- **THEN** the system SHALL clear the opt-out state and include them in future cycles if they are otherwise eligible

#### Scenario: Participant views App Home status
- **WHEN** a user opens the Slack App Home
- **THEN** the system SHALL show whether the user is in the configured channel and whether they are currently participating or opted out

### Requirement: Scheduled cycles are created idempotently
The system SHALL create a pairing cycle when the configured schedule is due and SHALL NOT create duplicate cycles for the same scheduled timestamp. A cycle SHALL remain open until the next scheduled cycle timestamp, at which point unresolved pairs from the previous cycle SHALL be closed as expired.

#### Scenario: First scheduled pairing time arrives
- **WHEN** the configured first pairing date and time is reached
- **THEN** the system SHALL create one pairing cycle for that scheduled timestamp

#### Scenario: Recurring pairing time arrives
- **WHEN** a subsequent scheduled time based on the configured frequency is reached
- **THEN** the system SHALL create one new pairing cycle for that scheduled timestamp

#### Scenario: Scheduler restarts after a due timestamp
- **WHEN** the app restarts after a scheduled timestamp that has not yet been processed
- **THEN** the system SHALL process the due cycle once and record it as processed

#### Scenario: Next cycle closes unresolved prior pairs
- **WHEN** a new scheduled cycle starts and the prior cycle has pairs without a terminal outcome
- **THEN** the system SHALL mark those prior pairs as expired and stop reminders for them

### Requirement: Matching favors new acquaintances while allowing repeats
The system SHALL generate random pairings using a history-aware score and SHALL select a lowest-scoring candidate arrangement from the generated candidates. The system SHALL attempt at least 200 random candidate arrangements for each cycle when at least two pair arrangements are possible; duplicate candidate attempts are allowed.

Pair score penalties SHALL be:
- Never paired before: `0`.
- Last paired 6 or more completed cycles ago: `1`.
- Last paired 3 to 5 completed cycles ago: `5`.
- Last paired 1 to 2 completed cycles ago: `25`.
- Paired in the immediately previous completed cycle: `100`.

The candidate arrangement score SHALL be the sum of its pair score penalties. Ties between lowest-scoring generated candidates MAY be broken randomly.

#### Scenario: Lower-score arrangement is generated
- **WHEN** multiple candidate arrangements are generated and one candidate has a lower total score than another
- **THEN** the system SHALL prefer the lower-score candidate over the higher-score candidate

#### Scenario: Repeats are unavoidable
- **WHEN** the eligible participant pool and history make repeat pairings unavoidable
- **THEN** the system SHALL allow repeat pairings rather than failing the cycle

#### Scenario: Lowest-score candidates tie
- **WHEN** multiple generated candidates have the same lowest total score
- **THEN** the system SHALL select one of the tied lowest-score candidates

#### Scenario: Pair history is recorded
- **WHEN** the system creates a pair in a cycle
- **THEN** the system SHALL persist the pair relationship for use in future matching decisions

### Requirement: Odd participant counts leave one user unpaired fairly
The system SHALL leave exactly one eligible participant unpaired when the eligible participant count is odd and greater than one. The skipped participant SHALL be selected from users with the oldest `last_skipped_at` value, treating participants who have never been skipped as older than any participant who has been skipped before. Ties MAY be broken randomly.

#### Scenario: Eligible participant count is odd
- **WHEN** a cycle has an odd number of eligible participants greater than one
- **THEN** the system SHALL leave one participant unpaired and pair all remaining eligible participants

#### Scenario: Some participants were skipped previously
- **WHEN** selecting which participant to leave unpaired and one candidate has never been skipped or was skipped less recently than another candidate
- **THEN** the system SHALL prefer the never-skipped or less-recently-skipped candidate over the more-recently-skipped candidate

#### Scenario: Skip history is recorded
- **WHEN** the system leaves a participant unpaired for a cycle
- **THEN** the system SHALL persist that participant's skip record for use in future odd-count cycles

#### Scenario: Fewer than two eligible participants exist
- **WHEN** a cycle has fewer than two eligible participants
- **THEN** the system SHALL create the cycle without creating any pairs

### Requirement: Participants are notified about assigned pairs
The system SHALL notify both participants in each pair through Slack when a pairing cycle creates their match.

#### Scenario: Pair is created
- **WHEN** the system creates a pair for a cycle
- **THEN** the system SHALL send a Slack notification to each participant identifying their assigned partner

#### Scenario: Pair notification is sent
- **WHEN** a participant receives a pair notification
- **THEN** the notification SHALL include enough information to contact the partner in Slack and understand the active coffee cycle

### Requirement: Reminders ask for meeting status
The system SHALL send reminder messages for active pairs and ask whether the participants met, have not met yet, or cannot meet. The system SHALL send at most two reminder messages per pair per cycle. A pair SHALL stop receiving reminders when it reaches a terminal outcome, receives the maximum number of reminders, or its cycle closes, whichever happens first.

#### Scenario: Reminder delay elapses
- **WHEN** the configured reminder delay elapses for a pair that has no terminal outcome, has not reached the maximum reminder count, and belongs to the open cycle
- **THEN** the system SHALL send a Slack reminder with actions for `Met`, `Not yet`, and `Cannot meet`

#### Scenario: Participant reports met
- **WHEN** a participant chooses `Met` for a pair
- **THEN** the system SHALL mark the pair outcome as met and stop future reminders for that pair

#### Scenario: Participant reports cannot meet
- **WHEN** a participant chooses `Cannot meet` for a pair
- **THEN** the system SHALL mark the pair outcome as cancelled and stop future reminders for that pair

#### Scenario: Participant reports not yet
- **WHEN** a participant chooses `Not yet` for a pair that has not reached the maximum reminder count and belongs to the open cycle
- **THEN** the system SHALL keep the pair active and schedule another reminder no earlier than the configured reminder delay

#### Scenario: Maximum reminder count is reached
- **WHEN** a pair has already received two reminder messages and has no terminal outcome
- **THEN** the system SHALL NOT send additional reminders for that pair

#### Scenario: Cycle closes before feedback is submitted
- **WHEN** a pair has no terminal outcome when its cycle closes
- **THEN** the system SHALL mark the pair outcome as expired and stop future reminders for that pair

### Requirement: Feedback responses are recorded
The system SHALL record feedback responses with the pair, responder, selected outcome, and timestamp.

#### Scenario: Participant submits feedback
- **WHEN** a participant responds to a meeting-status reminder
- **THEN** the system SHALL persist the response and associate it with the corresponding cycle and pair

#### Scenario: Multiple participants respond
- **WHEN** both participants in a pair submit feedback
- **THEN** the system SHALL preserve each individual response while maintaining a single current pair outcome

### Requirement: Slack interactions and persisted data are handled safely
The system SHALL process Slack events and interactive actions only through authenticated Slack Bolt delivery. If an HTTP receiver is used instead of Socket Mode, the system SHALL verify Slack request signatures and timestamps before processing payloads. The system SHALL re-check admin authorization for every admin action, validate all user-submitted configuration before persistence or use, use parameterized SQLite statements for persisted data access, and avoid logging Slack tokens or full Slack payloads.

#### Scenario: Slack payload is not authenticated
- **WHEN** a Slack event or interactive action is not delivered through authenticated Socket Mode or does not pass Slack signature verification in HTTP mode
- **THEN** the system SHALL reject the payload and SHALL NOT mutate persisted state

#### Scenario: Admin action is submitted
- **WHEN** a user submits an admin configuration action
- **THEN** the system SHALL verify the user's Slack ID against the configured admin list before applying the action

#### Scenario: User-submitted values are persisted
- **WHEN** the system stores Slack-derived or user-submitted values in SQLite
- **THEN** the system SHALL use parameterized statements and SHALL NOT build SQL by concatenating untrusted input

#### Scenario: Application logs are written
- **WHEN** the system logs Slack or configuration-related activity
- **THEN** the logs SHALL NOT include Slack tokens, signing secrets, app tokens, or complete raw Slack payloads

### Requirement: Slack API operations are bounded and retryable
The system SHALL use Slack API pagination when reading channel membership and SHALL support configured coffee channels with up to 200 eligible human participants by default. The system SHALL avoid partial cycle creation when the participant pool cannot be fully resolved and SHALL persist notification/reminder send status so failed sends can be retried without duplicating successful sends.

#### Scenario: Channel membership spans multiple Slack pages
- **WHEN** the configured coffee channel has more members than one Slack API response page
- **THEN** the system SHALL follow Slack pagination cursors until all channel members are retrieved or an unrecoverable Slack API error occurs

#### Scenario: Participant limit is exceeded
- **WHEN** the resolved eligible participant count exceeds the configured maximum supported participant count
- **THEN** the system SHALL fail the cycle before creating pairs and record the failure reason

#### Scenario: Slack API rate limit is returned
- **WHEN** Slack returns a rate-limit response while sending notifications or reminders
- **THEN** the system SHALL retry after Slack's indicated delay or an exponential backoff delay and SHALL preserve pending send state

#### Scenario: Notification send partially fails
- **WHEN** some pair notifications or reminders are sent successfully and another send fails
- **THEN** the system SHALL record successful sends, keep failed sends pending or failed for retry, and SHALL NOT duplicate successful sends after restart

### Requirement: Runtime state survives container restarts
The system SHALL persist configuration and operational state in SQLite so the local Docker-hosted bot can continue after restarts.

#### Scenario: App restarts after configuration exists
- **WHEN** the app starts and a prior configuration exists in SQLite
- **THEN** the system SHALL load the saved configuration and continue scheduling from persisted state

#### Scenario: App restarts after pairs were created
- **WHEN** the app restarts after a cycle created pairs but before all reminders or feedback are complete
- **THEN** the system SHALL retain the cycle, match, reminder, and feedback state and continue processing pending work without duplicating already-sent notifications

