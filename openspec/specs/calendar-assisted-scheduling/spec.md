# calendar-assisted-scheduling Specification

## Purpose
Define calendar-assisted scheduling for Random Coffee matches, including participant scheduling identity and preferences, opt-in calendar-backed slot proposals, Slack responses, manual fallback, bot-owned event creation, data protection, persistence, and safe failure handling.

## Requirements
### Requirement: Participants can connect scheduling identity and preferences
The system SHALL maintain the calendar identity and scheduling preferences needed to plan Random Coffee meetings for each participant. Preferences SHALL include meeting duration, preferred availability windows, preferred weekdays, minimum notice, and whether automated scheduling is enabled for that participant.

If a participant has no saved scheduling preferences, the system SHALL use safe defaults: 30-minute meetings, a 7-day search horizon, 0 hours minimum notice so same-day slots are allowed, and Monday-Friday 10:00-17:00 in the configured coffee timezone unless runtime configuration overrides those defaults.

The system SHALL read calendar availability only for participants who have both a verified calendar identity and automated scheduling enabled. The system SHALL maintain a verified invite address for calendar invitations; the invite address MAY come from the connected calendar identity or from a verified Slack email address. Before planning pending Slack-hosted scheduling requests, the Slack adapter SHALL refresh participant profile data and, when no explicit calendar identity exists, provision calendar identity, invite address, and default scheduling preferences from the participant's Slack profile email. The system SHALL NOT require a participant to connect a calendar in order to remain eligible for Random Coffee matching.

#### Scenario: Participant has scheduling identity
- **WHEN** a participant has a verified calendar identity, saved scheduling preferences, and automated scheduling enabled
- **THEN** the system SHALL use that identity and preferences when planning future coffee meetings for that participant

#### Scenario: Participant lacks scheduling identity
- **WHEN** a matched participant has no verified calendar identity
- **THEN** the system SHALL keep the Random Coffee match active and SHALL NOT attempt to read that participant's calendar availability

#### Scenario: Participant disables automated scheduling
- **WHEN** a participant has a verified calendar identity but disables automated scheduling
- **THEN** the system SHALL NOT read that participant's calendar availability for future scheduling requests while the setting remains disabled

#### Scenario: Participant updates scheduling preferences
- **WHEN** a participant updates their meeting duration, preferred time window, preferred weekdays, minimum notice, or automated scheduling setting
- **THEN** the system SHALL persist the updated preferences for future scheduling requests

#### Scenario: Participant has no saved scheduling preferences
- **WHEN** a participant without saved scheduling preferences enters a scheduling request
- **THEN** the system SHALL apply the configured default duration, search horizon, minimum notice, preferred weekdays, and preferred time window for planning

#### Scenario: Slack profile email provisions scheduling identity
- **WHEN** a pending Slack-hosted scheduling request involves a participant with a Slack profile email and no saved calendar identity
- **THEN** the system SHALL save that email as the participant's calendar identity and invite address, and SHALL create default scheduling preferences before attempting calendar-backed planning

#### Scenario: Participant views Home scheduling status
- **WHEN** a participant opens Slack App Home and calendar-assisted scheduling is enabled
- **THEN** the system SHALL show what calendar identity, invite email, automated scheduling setting, preferred time window, preferred weekdays, weekly booked/busy preview, and calendar privacy boundary the bot will use
- **AND** when the calendar can be read, the weekly booked/busy preview SHALL show every busy interval returned by the calendar provider without intentionally truncating per-day entries
- **AND** when the calendar is not connected or cannot be read, the system SHALL show the preferred weekly window and setup instructions instead of failing the Home view

#### Scenario: Participant edits preferred time, days, and notice
- **WHEN** a participant updates preferred start/end times, preferred weekdays, or minimum notice from Slack App Home
- **THEN** the system SHALL save those preferences and use them for future scheduling slot generation

### Requirement: New matches start a scheduling request when scheduling is available
The system SHALL create a scheduling request for each newly created Random Coffee match when calendar-assisted scheduling is globally enabled. The scheduling request SHALL be tracked separately from the match outcome so scheduling can be booked, manual, failed, or expired while the match remains active for reminders and feedback.

Automated calendar-backed planning SHALL begin only when at least one participant has a verified calendar identity with automated scheduling enabled. If neither participant has enabled calendar-backed planning, the request SHALL move to manual mode and the match SHALL continue with normal reminders and feedback.

#### Scenario: Match is created with scheduling enabled
- **WHEN** a pairing cycle creates a match and calendar-assisted scheduling is enabled
- **THEN** the system SHALL create one scheduling request associated with that match

#### Scenario: At least one participant opted into automated scheduling
- **WHEN** a scheduling request starts and at least one participant has verified calendar access with automated scheduling enabled
- **THEN** the system SHALL attempt calendar-backed planning using only the opted-in participant calendars

#### Scenario: No participants opted into automated scheduling
- **WHEN** a scheduling request starts and neither participant has verified calendar access with automated scheduling enabled
- **THEN** the system SHALL mark the scheduling request as manual, notify both participants to arrange directly, and continue the normal Random Coffee reminder flow

#### Scenario: Scheduler restarts after request creation
- **WHEN** the application restarts after creating a scheduling request for a match
- **THEN** the system SHALL continue the existing scheduling request and SHALL NOT create a duplicate request for the same match

#### Scenario: Scheduling is disabled
- **WHEN** a pairing cycle creates a match and calendar-assisted scheduling is disabled
- **THEN** the system SHALL use the existing Random Coffee notification and reminder behavior without creating a scheduling request

### Requirement: Scheduling agent proposes calendar-backed slots
The system SHALL use a Pi scheduling agent to recommend up to three equal meeting slot options for a scheduling request. The scheduling agent SHALL use `deepseek-v4-flash` by default through configurable Pi provider/model settings and SHALL be limited to application-provided scheduling tools.

The scheduling agent SHALL only propose slots that were returned by the calendar slot-finding service for the current scheduling request. When participant notes, non-overlapping selections, alternatives requests, or calendar availability changes cause a new proposal, the scheduling agent SHALL explain in participant-facing text why the new options are being proposed.

#### Scenario: Shared availability exists
- **WHEN** both participants have verified calendar access with automated scheduling enabled and at least one shared slot satisfies their constraints
- **THEN** the system SHALL send a Slack scheduling proposal containing up to three equal slot options

#### Scenario: Only one participant has calendar access
- **WHEN** exactly one participant in a match has verified calendar access with automated scheduling enabled
- **THEN** the system SHALL derive candidate slots only from the connected participant's availability and known preferences, SHALL clearly indicate that the other participant's calendar was not checked, and SHALL require explicit acceptance from both participants before creating any event

#### Scenario: Agent uses calendar slot tool
- **WHEN** the scheduling agent needs candidate meeting times
- **THEN** the agent SHALL request slots through the application-provided calendar slot tool rather than inventing times from conversation alone

#### Scenario: Agent output references unknown slot
- **WHEN** the scheduling agent recommends a slot that is not a persisted candidate for the current request
- **THEN** the system SHALL reject that recommendation and SHALL NOT present it as an actionable booking option

#### Scenario: Pi agent unavailable
- **WHEN** the configured Pi agent model, credentials, or SDK runtime are unavailable
- **THEN** the system SHALL follow the configured agent fallback mode: switch the scheduling request to manual or mark the scheduling request as failed, while keeping the Random Coffee match active

### Requirement: Participants respond to scheduling proposals in Slack
The system SHALL let each participant respond to proposed slots from Slack. Supported responses SHALL include selecting one to three proposed slots that work for them, requesting alternatives, rejecting with a reason, providing free-text scheduling preferences for the current request, and switching to manual mode.

The Slack adapter SHALL acknowledge interactive payloads immediately before calendar, Pi, booking, or other long-running work. After a terminal or replacement action, the adapter SHALL remove controls from the acted-on proposal message and deliver any new proposal or final status as a separate Slack message. A production deployment SHALL run at most one active Socket Mode consumer for a Slack app token so interactive envelopes are not split between competing bot processes.

#### Scenario: Participant selects proposed slots
- **WHEN** a participant selects one or more proposed slots as acceptable
- **THEN** the system SHALL record that participant's acceptable slot set and SHALL wait for the other participant unless both participants have selected at least one overlapping slot

#### Scenario: Participant confirms immediately after changing checkbox selection
- **WHEN** Slack sends a Confirm action whose embedded checkbox state conflicts with the latest checkbox action observed for the same participant and scheduling request
- **THEN** the Slack adapter SHALL use the latest observed checkbox action as the participant's selected slot set

#### Scenario: Slack interactive action is acknowledged promptly
- **WHEN** a participant clicks Confirm, Other options, Suggest time, Manual mode, or changes the proposed-slot checkbox selection
- **THEN** the Slack adapter SHALL send the Slack acknowledgement before doing long-running planning, booking, notification delivery, or calendar work
- **AND** the system SHOULD log enough timing information to distinguish delayed Slack delivery from slow application acknowledgement without logging raw Slack payloads

#### Scenario: Deployment has duplicate Socket Mode consumers
- **WHEN** another process or container is already connected to Slack Socket Mode for the same app token
- **THEN** the deployment SHALL stop the duplicate consumer before accepting production interactions so Slack can deliver each interactive envelope to exactly one active bot process

#### Scenario: Participants select overlapping slots
- **WHEN** both participants select acceptable slot sets with at least one slot in common
- **THEN** the system SHALL choose an overlapping active slot for booking

#### Scenario: Participants select non-overlapping slots
- **WHEN** both participants select acceptable slot sets but no selected slot overlaps
- **THEN** the system SHALL reject the current proposed set, keep the request proposed, and ask the scheduling agent to propose a fresh set of options with an explanation

#### Scenario: Participant requests alternatives
- **WHEN** a participant requests other options
- **THEN** the system SHALL keep the scheduling request active in the `proposed` state and SHALL attempt to propose different available slots while retaining prior preferences and rejected slots as planning context

#### Scenario: Participant provides text preference
- **WHEN** a participant submits a free-text scheduling preference for the current request
- **THEN** the system SHALL persist the text with the request and SHALL incorporate it into subsequent slot planning

#### Scenario: Participant rejects a slot
- **WHEN** a participant rejects a proposed slot with or without a reason
- **THEN** the system SHALL record the rejection, keep the scheduling request in the `proposed` state for replanning, and SHALL NOT book that slot unless both participants later accept it after a new proposal

#### Scenario: Replanning replaces the active proposal
- **WHEN** the system replans because of a rejection, alternatives request, text preference, or stale slot
- **THEN** the system SHALL keep the same scheduling request, SHALL preserve prior preferences and rejection history, and SHALL clear acceptances for slots that are no longer active candidates

#### Scenario: Participant acts on inactive slot
- **WHEN** a participant action references a slot that is no longer an active candidate for the scheduling request
- **THEN** the system SHALL NOT record acceptance for that slot, SHALL NOT create a calendar event, and SHALL respond with the current scheduling state or a refreshed proposal

#### Scenario: Participant acts after terminal scheduling state
- **WHEN** a participant clicks a scheduling action after the request is booked, manual, failed, or expired
- **THEN** the system SHALL NOT mutate the terminal scheduling state and SHALL respond with the current terminal status

### Requirement: Manual mode stops automated scheduling for the match
The system SHALL allow either participant in a matched pair to switch the scheduling request to manual mode. Manual mode SHALL stop further automated slot proposals and SHALL prevent calendar event creation for that match. Manual mode SHALL NOT close or cancel the Random Coffee match itself.

#### Scenario: One participant chooses manual mode
- **WHEN** either participant chooses to arrange the meeting themselves
- **THEN** the system SHALL mark the scheduling request as manual and SHALL stop automated scheduling for that match

#### Scenario: Other participant is notified about manual mode
- **WHEN** one participant switches the request to manual mode
- **THEN** the system SHALL notify the other participant that the pair is arranging the meeting manually

#### Scenario: Manual mode still receives coffee reminders
- **WHEN** a scheduling request is in manual mode and the associated match remains active
- **THEN** the system SHALL continue the normal Random Coffee reminder and feedback flow for that match

### Requirement: Agreement creates a bot-owned calendar event
The system SHALL create a calendar event from the bot's calendar only after both participants have selected at least one overlapping active proposed slot. Before creating the event, the system SHALL revalidate that the selected overlapping slot is still free for every participant with verified calendar access.

The event SHALL invite both participants using verified invite addresses and SHALL be associated with the scheduling request. Calendar event creation SHALL be idempotent for the accepted overlapping slot. Google free/busy reads SHOULD use only the delegated `calendar.freebusy` scope, while bot-owned event creation SHOULD use the non-impersonated service-account identity with event-write access only to the bot calendar.

#### Scenario: Both participants select an overlapping available slot
- **WHEN** both participants select acceptable proposed slots, at least one selected slot overlaps, both participants have verified invite addresses, and the final availability check confirms the overlapping slot is still free for every participant with verified calendar access
- **THEN** the system SHALL create one bot-owned calendar event for the coffee meeting and SHALL persist the provider event identifier

#### Scenario: Accepted participant lacks invite address
- **WHEN** both participants select an overlapping proposed slot but either participant has no verified invite address
- **THEN** the system SHALL NOT create a calendar event, SHALL switch the scheduling request to manual mode, and SHALL notify both participants to arrange directly

#### Scenario: Accepted slot is no longer available
- **WHEN** both participants select an overlapping proposed slot but the final availability check shows that the slot is no longer free for a participant with verified calendar access
- **THEN** the system SHALL NOT create a calendar event and SHALL attempt to propose a new available slot

#### Scenario: Event creation is retried after restart
- **WHEN** the application restarts after accepting a slot but before confirming event creation
- **THEN** the system SHALL retry idempotently and SHALL NOT create duplicate calendar events for the same scheduling request and slot

#### Scenario: Participants select concurrently
- **WHEN** both participants select overlapping active slots at nearly the same time
- **THEN** the system SHALL serialize consensus detection and event creation so at most one bot-owned calendar event is created

#### Scenario: Calendar event is created
- **WHEN** the system successfully creates the bot-owned calendar event
- **THEN** the system SHALL notify both participants with the booked date/time and SHALL mark the scheduling request as booked

### Requirement: Calendar data is minimized and protected
The system SHALL use calendar availability data only for scheduling Random Coffee meetings. The system SHALL expose only free/busy intervals and derived candidate slots to the scheduling agent. The system SHALL NOT expose calendar event titles, descriptions, locations, external attendee lists, or raw provider tokens to Slack messages or the Pi agent.

#### Scenario: Free busy data is retrieved
- **WHEN** the system reads participant calendar availability
- **THEN** the system SHALL use the availability to derive candidate slots without sending private event details to the scheduling agent

#### Scenario: Scheduling agent context is built
- **WHEN** the system prompts the scheduling agent for a recommendation
- **THEN** the context SHALL include match state, participant scheduling preferences, prior responses, and candidate slots, but SHALL NOT include raw calendar event metadata or provider credentials

#### Scenario: Scheduling data is logged
- **WHEN** the system logs scheduling, Slack, Pi, or calendar activity
- **THEN** logs SHALL NOT include provider tokens, raw calendar payloads, or full raw Slack payloads

### Requirement: Scheduling orchestration is host-environment agnostic
The system SHALL keep scheduling orchestration independent from Slack-specific delivery. The scheduling module SHALL emit host-neutral scheduling notifications and SHALL accept participant responses through a host-neutral interface. Slack SHALL be one host adapter for those notifications and responses, not a dependency of the core scheduling state machine.

#### Scenario: Mock host runs scheduling flow
- **WHEN** the scheduling module runs in a mock host environment with a fake calendar service
- **THEN** it SHALL create proposals, accept participant responses, switch to manual mode, and book events without requiring a Slack client

#### Scenario: Slack host adapts neutral notification
- **WHEN** the scheduling module emits a host-neutral scheduling notification
- **THEN** the Slack adapter SHALL translate it into Slack messages, blocks, modals, or retryable Slack notification jobs without changing core scheduling state semantics

#### Scenario: Scheduling core receives host response
- **WHEN** any supported host reports participant acceptance, rejection, alternatives request, text preference, or manual-mode selection
- **THEN** the scheduling module SHALL process the response using the same scheduling state machine regardless of host

### Requirement: Scheduling state survives restarts
The system SHALL persist scheduling requests, candidate slots, participant responses, agent conversation summaries or messages, selected slot, manual/failed/booked status, host notification references, Slack message references, and calendar event identifiers in SQLite.

#### Scenario: App restarts during active scheduling
- **WHEN** the app restarts while a scheduling request is awaiting responses
- **THEN** the system SHALL restore the request state and SHALL process later Slack actions against the restored state

#### Scenario: App restarts after manual mode
- **WHEN** the app restarts after a scheduling request was marked manual
- **THEN** the system SHALL preserve manual mode and SHALL NOT resume automated scheduling for that request

#### Scenario: App restarts after booking
- **WHEN** the app restarts after a scheduling request was booked
- **THEN** the system SHALL preserve the booked status and provider event identifier and SHALL NOT create another event for that request

### Requirement: Scheduling failures are safe and visible
The system SHALL handle calendar, Slack, and Pi agent failures without corrupting Random Coffee match state. Retryable notification failures SHALL preserve the current scheduling status and retry notification delivery. Unrecoverable planning failures SHALL transition the scheduling request according to the configured fallback mode: manual or failed. Pending scheduling planning MAY run concurrently up to a configured concurrency limit, and database writes SHALL be serialized or guarded by SQLite WAL/busy-timeout and transactions so concurrent planning cannot corrupt scheduling state. In all cases, the system SHALL leave the match active for normal reminders and feedback unless the match itself reaches a terminal outcome.

#### Scenario: Calendar availability lookup fails
- **WHEN** the system cannot read required calendar availability for a scheduling request and no retry or partial-availability proposal is available
- **THEN** the system SHALL record the failure, transition the scheduling request to manual or failed according to fallback configuration, notify participants that automated scheduling is unavailable, and SHALL keep the Random Coffee match active

#### Scenario: No shared slots are found
- **WHEN** no shared available slots are found within the configured search horizon
- **THEN** the system SHALL notify participants and SHALL offer manual mode or a way to provide additional preferences

#### Scenario: Slack scheduling notification fails
- **WHEN** sending a scheduling proposal or booking notification to Slack fails with a retryable error
- **THEN** the system SHALL preserve the current scheduling status and pending notification state so the message can be retried without duplicating already-sent messages

#### Scenario: Match closes before scheduling completes
- **WHEN** the associated Random Coffee match or cycle reaches a terminal outcome before scheduling is booked
- **THEN** the system SHALL expire the scheduling request and SHALL NOT create a calendar event for it
