import { DateTime } from 'luxon';
import { createConfiguredPiSession } from '../piRuntime.js';
import type { RuntimeConfig, SchedulingCandidateSlot, SchedulingRequest } from '../types.js';
import type { SchedulingStore } from './store.js';

export interface SchedulingRecommendation {
  slotIds: string[];
  message: string;
  fallback?: 'manual' | 'failed' | 'none';
}

type PiAgentMessageLike = {
  role?: string;
  content?: unknown;
  errorMessage?: string;
};

function extractMessageContent(message: PiAgentMessageLike | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return message.errorMessage ?? '';
  return message.content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const b = block as { type?: string; text?: string };
    return b.type === 'text' ? b.text ?? '' : '';
  }).filter(Boolean).join('\n');
}

function findJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith('{')) return fenced;
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function messageMentionsSlot(message: string, slot: SchedulingCandidateSlot, timezone: string): boolean {
  const utc = DateTime.fromISO(slot.startsAt, { zone: 'utc' });
  const local = utc.setZone(timezone);
  const timeCandidates = [utc.toFormat('HH:mm'), local.toFormat('HH:mm'), utc.toFormat('H:mm'), local.toFormat('H:mm')];
  const dateCandidates = [slot.startsAt, local.toFormat('yyyy-MM-dd'), local.toFormat('dd LLL'), local.toFormat('LLLL d'), local.toFormat('ccc, dd LLL')];
  return message.includes(slot.id) || dateCandidates.some((value) => message.includes(value)) || timeCandidates.some((value) => message.includes(value));
}

function slotForAgent(slot: SchedulingCandidateSlot, timezone: string): SchedulingCandidateSlot & { localStart: string; localEnd: string; localWeekday: string } {
  const starts = DateTime.fromISO(slot.startsAt, { zone: 'utc' }).setZone(timezone);
  const ends = DateTime.fromISO(slot.endsAt, { zone: 'utc' }).setZone(timezone);
  return {
    ...slot,
    localStart: starts.toFormat('yyyy-MM-dd EEEE HH:mm ZZZZ'),
    localEnd: ends.toFormat('yyyy-MM-dd EEEE HH:mm ZZZZ'),
    localWeekday: starts.toFormat('EEEE'),
  };
}

export class SchedulingAgent {
  constructor(private readonly store: SchedulingStore, private readonly config: RuntimeConfig) {}

  validateRecommendation(recommendation: SchedulingRecommendation, activeSlots: SchedulingCandidateSlot[]): SchedulingRecommendation {
    const activeById = new Map(activeSlots.filter((slot) => slot.status === 'active').map((slot) => [slot.id, slot]));
    const slotIds = [...new Set(recommendation.slotIds)].filter((id) => activeById.has(id)).slice(0, 3);
    const expectedCount = Math.min(3, activeById.size);
    if (slotIds.length !== expectedCount) {
      throw new Error(`Agent recommendation must include ${expectedCount} active persisted slot id(s)`);
    }
    const message = recommendation.message.trim();
    if (message.length < 20) throw new Error('Agent recommendation message is too short');
    if (/\b(booked|created event|calendar event created)\b/i.test(message)) throw new Error('Agent recommendation must not claim the event is booked');
    if (!slotIds.some((slotId) => messageMentionsSlot(message, activeById.get(slotId)!, this.store.getConfig()?.timezone ?? 'UTC'))) {
      throw new Error('Agent recommendation message does not mention any proposed slot');
    }
    return { ...recommendation, message, slotIds };
  }

  async recommend(request: SchedulingRequest): Promise<SchedulingRecommendation> {
    const activeSlots = this.store.listCandidateSlots(request.id, 'active');
    return this.validateRecommendation(await this.recommendWithSdk(request), activeSlots);
  }

  private async recommendWithSdk(request: SchedulingRequest): Promise<SchedulingRecommendation> {
    const pi = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');
    const store = this.store;

    const getSchedulingStateTool = pi.defineTool({
      name: 'get_scheduling_state',
      label: 'Get Scheduling State',
      description: 'Return sanitized scheduling request state, candidate slots, and participant responses.',
      parameters: Type.Object({}),
      async execute() {
        const timezone = store.getConfig()?.timezone ?? 'UTC';
        const state = {
          timezone,
          request: store.getSchedulingRequest(request.id),
          match: store.getMatch(request.matchId),
          slots: store.listCandidateSlots(request.id, 'active').map((slot) => slotForAgent(slot, timezone)),
          responses: store.listSchedulingResponses(request.id),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }], details: state };
      },
    });

    const findCalendarSlotsTool = pi.defineTool({
      name: 'find_calendar_slots',
      label: 'Find Calendar Slots',
      description: 'Return already sanitized persisted candidate slots for this request. Never invent slot IDs.',
      parameters: Type.Object({}),
      async execute() {
        const timezone = store.getConfig()?.timezone ?? 'UTC';
        const slots = store.listCandidateSlots(request.id, 'active').map((slot) => slotForAgent(slot, timezone));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ timezone, slots }, null, 2) }], details: { timezone, slots } };
      },
    });

    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: pi.getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => `You schedule Random Coffee meetings. Use only the provided tools. Recommend only persisted slot IDs from find_calendar_slots/get_scheduling_state. Read participant responses as natural-language scheduling instructions and choose the best persisted candidate slots that satisfy them when possible. Treat "after lunch" / "после обеда" as 13:00 or later in the request timezone unless the participant gives a different explicit time. Propose exactly three equal options when at least three candidate slots are available. Do not invent slot IDs, do not ask the application to pre-filter natural language, and do not claim a requested time is unavailable unless no provided candidate slot matches it. In the participant-facing message, briefly explain why these options are being proposed or changed: mention relevant new participant notes, requests for other options, non-overlapping selections, or calendar availability changes when present. Return only JSON: {"slotIds":["slot_id","slot_id","slot_id"],"message":"participant-facing text explaining why these slots are proposed/changed and listing the proposed date/times, without claiming the event is booked","fallback":"none|manual|failed"}.`,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const { session } = await createConfiguredPiSession(pi, this.config, {
      sessionManager: pi.SessionManager.inMemory(process.cwd()),
      resourceLoader,
      customTools: [getSchedulingStateTool, findCalendarSlotsTool],
      noTools: 'builtin',
      thinkingLevel: 'minimal',
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('scheduling_agent_timeout')), this.config.piAgentTimeoutMs);
      });
      await Promise.race([
        session.prompt('Recommend the next scheduling proposal for this request. Call the tools first. Interpret participant responses yourself, explain in the message why the proposed options changed when there are new notes or incompatible selections, and choose among the persisted candidate slots. Return JSON only.', { expandPromptTemplates: false }),
        timeout,
      ]);
      const final = (session.messages as PiAgentMessageLike[]).filter((message) => message.role === 'assistant').at(-1);
      const text = extractMessageContent(final);
      const json = findJsonObject(text);
      if (!json) throw new Error('Agent did not return JSON');
      const parsed = JSON.parse(json) as Partial<SchedulingRecommendation>;
      return {
        slotIds: Array.isArray(parsed.slotIds) ? parsed.slotIds.map(String) : [],
        message: typeof parsed.message === 'string' ? parsed.message : 'I found Random Coffee slots.',
        fallback: parsed.fallback === 'manual' || parsed.fallback === 'failed' || parsed.fallback === 'none' ? parsed.fallback : 'none',
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      session.dispose();
    }
  }
}
