## Context

Cafe is a Slack-first Random Coffee bot. The current flow creates scheduled cycles, resolves the participant pool from a Slack channel, creates history-aware pairs, sends each participant a DM identifying their partner, and later sends reminders/feedback buttons. The bot does not help participants find a meeting time or create calendar events.

The desired change is to add a scheduling layer after a match is created. The layer should use the Pi Agent SDK in the same style as `~/Work/paperpodcast`: an application-owned runtime wrapper selects a configured model, custom tools are exposed to the agent, built-in coding tools are disabled, and session state is persisted in the app database rather than Pi session files. `deepseek-v4-flash` is the intended default model because scheduling negotiation is small, latency-sensitive, and tool-driven.

The high-trust operations are calendar reads and calendar event creation. The LLM must not receive private calendar event details, must not create events without application-level checks, and must not be the source of truth for match/scheduling state.

## Goals / Non-Goals

**Goals:**

- Start a scheduling flow for each new Random Coffee match when calendar scheduling is enabled.
- Find shared free slots from participant calendars using free/busy data and participant preferences.
- Use a Pi scheduling agent to propose a primary slot, suggest alternatives, and incorporate accept/reject/free-text feedback from participants.
- Create a bot-owned calendar event only after both participants accept the same slot and a final application-level availability check passes.
- Always provide a manual mode: either participant can stop automated scheduling for the match, the bot notifies the other participant, and normal reminders continue.
- Persist all scheduling state needed to survive restarts and avoid duplicate calendar events or duplicate scheduling prompts.
- Keep calendar privacy boundaries explicit: free/busy in, no event titles/descriptions/attendee lists to the LLM or Slack.

**Non-Goals:**

- Replacing the existing pair-matching algorithm.
- Replacing the existing reminder/feedback outcome model.
- Full multi-provider calendar parity in the first implementation; the first production adapter is Google Calendar/Workspace, with a provider abstraction so Microsoft or other adapters can be added later.
- Letting participants edit arbitrary calendar event fields from Slack.
- Letting the LLM directly perform irreversible side effects without application-level validation.

## Decisions

### Use a provider-neutral CalendarService with free/busy-only planning

Introduce a `CalendarService` abstraction responsible for identity resolution, availability lookup, slot generation, and bot-owned event creation. Identity resolution distinguishes calendar availability identity from verified invite address; the same email may satisfy both, but event creation requires invite addresses for both participants while availability reads require per-participant opt-in. A concrete adapter supplies provider-specific API calls; tests use a fake adapter. The first production adapter is Google Calendar/Workspace because Slack user email mapping commonly aligns with Workspace accounts and Google exposes the required free/busy and bot-owned event APIs with minimal event-detail exposure. The rest of the application depends only on the interface.

Alternatives considered:
- **Call provider APIs directly from Slack handlers.** Rejected because scheduling logic would be scattered and hard to test.
- **Give the agent raw calendar API tools.** Rejected because it exposes too much data and makes side-effect boundaries unclear.

### Keep LLM authority limited to negotiation and recommendation

The scheduling agent may call read-only planning tools such as `get_scheduling_state` and `find_calendar_slots`, then return a structured recommendation/message. It does not directly write the calendar. The application handles Slack actions, records responses, checks consensus, revalidates availability, and creates the calendar event.

Alternatives considered:
- **Agent tool `create_meeting`.** Deferred. It could be added later, but only with hard guards that verify both accepted and the slot is still free.
- **No agent, simple slot picker only.** Simpler, but weaker for free-text preferences such as “next week after lunch but not Friday”.

### Model scheduling as a separate state machine from match outcome

Add a scheduling request per match. Scheduling status is independent from `matches.outcome`:

```text
pending
  ├─ proposal generated ───────────────▶ proposed
  ├─ participant/manual fallback ──────▶ manual
  └─ unrecoverable setup failure ──────▶ failed

proposed
  ├─ participant requests alternatives ─▶ proposed   (replan; same request)
  ├─ slot rejected or becomes stale ─────▶ proposed   (replan; same request)
  ├─ one participant chooses manual ─────▶ manual
  ├─ both accept same valid slot ────────▶ booked
  ├─ unrecoverable scheduling failure ───▶ failed
  └─ match/cycle closes first ───────────▶ expired
```

`manual`, `booked`, `failed`, and `expired` are terminal for scheduling only. `accepted` is not a request status; it is a participant response recorded against a slot. `replan` is not a request status; it is a transition that keeps the request `proposed`, retains prior preferences/rejections as context, and replaces or augments candidate slots. The match can remain `active`, and existing reminders/feedback continue to determine whether the coffee happened.

This avoids overloading `matches.outcome` with calendar-specific state and preserves existing reminder semantics.

### Use one scheduling agent session per match/request

A `SchedulingAgent` mirrors PaperPodcast's `CommentAgent` pattern: create or resume a session scoped to a scheduling request, seed it from stored scheduling messages/responses, expose only custom scheduling tools, and dispose idle in-memory sessions. On each participant action or text preference, the app appends a scheduling message and runs one agent turn to propose the next step.

Configuration mirrors PaperPodcast:

```env
PI_PROVIDER=deepseek
PI_MODEL=deepseek-v4-flash
PI_AGENT_TIMEOUT_MS=30000
```

Docker should mount Pi credentials read-only when SDK mode is enabled:

```yaml
- ${HOME}/.pi/agent:/root/.pi/agent:ro
PI_CODING_AGENT_DIR=/root/.pi/agent
```

If Pi credentials or the model are unavailable, the system follows `CALENDAR_AGENT_FALLBACK_MODE` (`manual` or `failed`): immediate manual mode or terminal scheduling failure.

### Keep scheduling core host-neutral

Scheduling orchestration should live in an independent module that depends on a scheduling store, calendar service, agent, and host environment interface instead of directly depending on Slack handlers. The host environment receives neutral scheduling notifications such as `proposal`, `manual`, and `booked`; Slack is one adapter that turns those notifications into DMs and interactive blocks, while tests can use a mock host with no Slack client at all.

Alternatives considered:
- **Embed scheduling in Slack handlers.** Rejected because the negotiation, state machine, and calendar logic should be reusable in other hosts.
- **Make Slack notification jobs the scheduling API.** Rejected as the core API because it couples the scheduler to Slack delivery. Slack jobs remain an adapter detail.

### Start with mirrored DMs and modal-based free-text input

The ideal future UX may be a multi-person DM with both participants so both see the same proposal and responses. The first Slack adapter should use mirrored DMs plus shared SQLite state because the existing bot already sends individual DMs and this avoids adding Slack message-history scopes. Button actions and modals are authoritative; free-text preference intake happens through a modal first.

### Any participant can switch to manual mode

Manual mode is a one-person veto. If either participant chooses “We’ll arrange ourselves”, the request becomes `manual`, automated slot proposal stops, no calendar event is created, and the other participant is notified. This reduces automation pressure and provides a safe fallback for hard-to-schedule pairs.

### Revalidate before event creation and use idempotency keys

When both participants accept the same proposed slot, the app rechecks free/busy for every participant with verified calendar access immediately before creating the event, verifies both participants have invite addresses, and then creates the bot-owned event. Event creation uses an idempotency key derived from the scheduling request and accepted slot so retry/restart does not create duplicates. The resulting provider event ID is persisted.

### Keep participant preferences structured, but accept free text as input

Persist structured defaults such as duration, preferred weekdays/hours, minimum notice, and auto-scheduling opt-in. The feature requires an admin/global enable flag and per-participant calendar availability opt-in; users can still choose manual mode for any match. Default preferences are 30 minutes, a 7-day search horizon, 24 hours minimum notice, and weekdays 10:00–17:00 in the configured coffee timezone unless runtime configuration overrides them. If no participant in a match has opted into calendar-backed planning, the scheduling request moves directly to manual mode. Free-text responses are stored as participant constraints for the current request and passed to the agent; the agent translates them into tool parameters for slot search where possible.

## Risks / Trade-offs

- Calendar provider credentials are high-trust → keep provider tokens outside LLM context, store only needed identifiers, document scopes, and use free/busy-only reads.
- Slack user to calendar identity mapping can be wrong or unavailable → require explicit calendar connection or verified email mapping before auto-scheduling; otherwise fall back to assisted/manual mode.
- LLM may suggest a slot that is not valid → treat agent output as advisory and only allow persisted slot IDs returned by `CalendarService` to be accepted/booked.
- Users may respond in different DMs and get out of sync → persist request state centrally and render every Slack message from database state.
- Calendar availability can change between proposal and acceptance → always revalidate before booking and replan if the accepted slot is no longer free.
- Pi SDK/model/API key may be unavailable → mark scheduling failed/manual while keeping Random Coffee pairing and reminders working.
- OAuth/provider implementation may expand scope → isolate provider adapters and keep the first adapter minimal: identity, free/busy, create bot-owned event.
- Manual mode may reduce automation completion rate → make it explicit but not dominant in UI, and continue reminders so the pair still receives follow-up.

## Migration Plan

1. Add new SQLite tables through a forward-only migration; existing cycles, matches, reminders, and feedback remain unchanged.
2. Add runtime configuration for Pi and calendar scheduling, including `CALENDAR_AGENT_FALLBACK_MODE`. Default scheduling disabled, or use `manual` fallback in environments without calendar credentials.
3. Deploy with scheduling disabled, run migration, and verify existing Random Coffee behavior is unchanged.
4. Enable scheduling for admins/test users or the configured coffee channel once calendar credentials and Slack scopes are validated.
5. Rollback by disabling scheduling configuration. Existing scheduling rows remain inert; existing Random Coffee reminders continue from current tables.

## Open Questions

- Should the first production rollout enable scheduling for all eligible channel members at once, or should admins be able to limit it to a test cohort first?
