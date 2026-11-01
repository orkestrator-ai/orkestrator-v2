/**
 * The json-v2 handoff carrier: the one frame every "continue this conversation
 * somewhere else" prompt uses.
 *
 * Two producers write it — the interactive "Continue in…" transfer
 * (`agent-handoff.ts`) and the build pipeline's review → address-issues
 * handoff (`apps/backend/src/core/build-pipeline-handoff.ts`) — and two readers
 * recognise it: the destination tab, which strips the carrier back out of the
 * first user message, and the pipeline transcript view, which hides it. Before
 * this module each kept its own copy of the tags, the escaping and the budget
 * arithmetic, with different limits. Browser-safe: no Node or Bun imports.
 */
import { promptCarrierJson } from "./review-evidence-frames.js";

export const AGENT_HANDOFF_JSON_FORMAT = "json-v2";
export const AGENT_HANDOFF_OPEN = `<orkestrator-handoff format="${AGENT_HANDOFF_JSON_FORMAT}">`;
export const AGENT_HANDOFF_CLOSE = "</orkestrator-handoff>";
export const AGENT_HANDOFF_METADATA_OPEN = "<orkestrator-handoff-metadata-json>";
export const AGENT_HANDOFF_METADATA_CLOSE = "</orkestrator-handoff-metadata-json>";
export const AGENT_HANDOFF_TRANSCRIPT_OPEN = "<orkestrator-handoff-transcript-json>";
export const AGENT_HANDOFF_TRANSCRIPT_CLOSE = "</orkestrator-handoff-transcript-json>";

/** Prompt budget shared by the interactive transfer and the pipeline handoff. */
export const AGENT_HANDOFF_PROMPT_BUDGET = 180_000;

/**
 * Written after a carrier by builds that sent the history on its own. Still
 * recognised (and consumed with the carrier) so old destination transcripts
 * keep rendering cleanly.
 */
export const AGENT_HANDOFF_LEGACY_FOLLOW_UP =
  "Briefly acknowledge the handoff, state the next concrete action implied by " +
  "the transcript, and continue unfinished work when it is safe to do so. " +
  "Ask the user if the transcript does not establish a safe next action.";

/** Separates a carrier from the first destination prompt it is prepended to. */
export const AGENT_HANDOFF_CURRENT_USER_MESSAGE =
  "The handoff above is prior conversation history. Respond to the user's new " +
  "message below as the latest message in that continued conversation:";

/** `"[\n"` plus `"\n]"` around the emitted transcript array. */
export const AGENT_HANDOFF_ARRAY_FRAME_OVERHEAD = 4;

/**
 * Never let a large header squeeze the transcript below this many characters:
 * a frame with no room for a single record is worse than a slightly long one.
 */
const MINIMUM_TRANSCRIPT_CHARACTERS = 1_000;

/** One rendered transcript entry inside the carrier's JSON array. */
export interface AgentHandoffTranscriptRecord {
  index: number;
  role: "user" | "assistant" | "system";
  sourceId: string;
  createdAt: string;
  body: string;
}

/**
 * JSON is the handoff's data frame, not executable prompt structure. Escaping
 * markup characters guarantees an untrusted string cannot synthesize any of
 * the structural tags the carrier parser and the destination model see.
 */
export function agentHandoffCarrierJson(value: unknown): string {
  return promptCarrierJson(value);
}

const TRUNCATION_NOTICE_ALLOWANCE = 38;

/**
 * Bounds one string, reporting how much was actually dropped. The destination
 * model reads the notice as ground truth about the evidence it is missing.
 */
export function truncateAgentHandoffText(value: string, limit: number): string {
  // Persisted parts reach here after validation, but rendering is also the last
  // step before a snapshot is handed to a model: a non-string that slipped
  // through must not throw out of an otherwise recoverable render.
  if (typeof value !== "string") return "";
  if (value.length <= limit) return value;
  const kept = Math.max(0, limit - TRUNCATION_NOTICE_ALLOWANCE);
  return `${value.slice(0, kept)}\n… [${value.length - kept} characters omitted]`;
}

/**
 * Cost of one record *inside* the emitted array frame.
 *
 * The frame is `agentHandoffCarrierJson(records)`, not the concatenation of
 * each record's own serialization: nesting adds one indent level to every line
 * of the record plus a `",\n"` separator. This upper bound charges the
 * separator to every record, including the last, so the emitted array cannot
 * overrun the budget even when it holds hundreds of short messages.
 */
export function agentHandoffRecordCost(record: AgentHandoffTranscriptRecord): number {
  const serialized = agentHandoffCarrierJson(record);
  let lines = 1;
  for (let index = 0; index < serialized.length; index += 1) {
    if (serialized.charCodeAt(index) === 10) lines += 1;
  }
  return serialized.length + lines * 2 + 2;
}

/**
 * Chooses which records fit `availableCharacters`.
 *
 * The first record carries the initiating context (the user's task, a
 * review's ticket and snapshot rules), so it is kept when it fits within a
 * third of the budget. The rest is spent from the newest record backwards,
 * because that best represents the source agent's current state. A record too
 * large for the remaining room is skipped rather than ending the scan, so one
 * huge tool result cannot crowd out smaller, older context.
 */
export function selectAgentHandoffRecords<T extends AgentHandoffTranscriptRecord>(
  records: readonly T[],
  availableCharacters: number,
): { records: T[]; omitted: number } {
  if (agentHandoffCarrierJson(records).length <= availableCharacters) {
    return { records: [...records], omitted: 0 };
  }
  const selected: Array<{ index: number; record: T }> = [];
  let used = AGENT_HANDOFF_ARRAY_FRAME_OVERHEAD;
  const first = records[0];
  const firstCost = first ? agentHandoffRecordCost(first) : 0;
  const firstSelected = Boolean(first) && used + firstCost <= availableCharacters / 3;
  if (first && firstSelected) {
    selected.push({ index: 0, record: first });
    used += firstCost;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (index === 0 && firstSelected) continue;
    const record = records[index]!;
    const cost = agentHandoffRecordCost(record);
    if (used + cost > availableCharacters) continue;
    selected.push({ index, record });
    used += cost;
  }
  selected.sort((left, right) => left.index - right.index);
  return {
    records: selected.map((entry) => entry.record),
    omitted: Math.max(0, records.length - selected.length),
  };
}

export interface AgentHandoffCarrierOptions {
  /**
   * The instructions between the opening tag and the metadata frame. Written
   * by the producer: the interactive transfer and the pipeline describe their
   * source differently.
   */
  introduction: string;
  /** Serialized into the metadata frame as escaped JSON. */
  metadata: Record<string, unknown>;
  /** Every candidate record, oldest first. */
  records: readonly AgentHandoffTranscriptRecord[];
  /**
   * Messages the source had in total, when the caller read only a window of
   * them. Omissions are reported against this, not just against `records`.
   */
  totalMessages?: number;
  /** Text written after the transcript frame when records were omitted. */
  omissionNotice: (omitted: number) => string;
  budget?: number;
}

export interface AgentHandoffCarrier {
  prompt: string;
  records: AgentHandoffTranscriptRecord[];
  /** Source messages the frame does not carry. */
  omitted: number;
}

/**
 * Builds one complete json-v2 carrier within `budget` characters.
 *
 * The omission notice is written *after* the transcript frame, so its
 * worst-case length is taken out of the budget before selection runs; leaving
 * it uncounted spends budget the frame does not have.
 */
export function buildAgentHandoffCarrier(options: AgentHandoffCarrierOptions): AgentHandoffCarrier {
  const budget = options.budget ?? AGENT_HANDOFF_PROMPT_BUDGET;
  const total = Math.max(options.totalMessages ?? 0, options.records.length);
  const header = `${AGENT_HANDOFF_OPEN}
${options.introduction.trim()}

${AGENT_HANDOFF_METADATA_OPEN}
${agentHandoffCarrierJson(options.metadata)}
${AGENT_HANDOFF_METADATA_CLOSE}
${AGENT_HANDOFF_TRANSCRIPT_OPEN}
`;
  const transcriptFooter = `\n${AGENT_HANDOFF_TRANSCRIPT_CLOSE}`;
  const carrierFooter = `\n${AGENT_HANDOFF_CLOSE}`;
  const omissionReserve = options.omissionNotice(total).length;
  const available = Math.max(
    MINIMUM_TRANSCRIPT_CHARACTERS,
    budget - header.length - transcriptFooter.length - carrierFooter.length - omissionReserve,
  );
  const selection = selectAgentHandoffRecords(options.records, available);
  const omitted = Math.max(0, total - selection.records.length);
  const notice = omitted > 0 ? options.omissionNotice(omitted) : "";
  return {
    prompt:
      `${header}${agentHandoffCarrierJson(selection.records)}${transcriptFooter}` +
      `${notice}${carrierFooter}`,
    records: selection.records,
    omitted,
  };
}

/**
 * Places a carrier before the first real destination prompt.
 *
 * The fixed separator is consumed by the carrier stripper along with the
 * carrier, leaving only `userPrompt` as the visible destination message. A
 * prompt that already starts with the carrier (an older client prepended it
 * itself) is returned unchanged, so history is never sent twice.
 */
export function prependAgentHandoffHistory(
  bootstrapPrompt: string | undefined,
  userPrompt: string,
): string {
  if (!bootstrapPrompt?.trim() || userPrompt.startsWith(bootstrapPrompt)) {
    return userPrompt;
  }
  return `${bootstrapPrompt}\n\n${AGENT_HANDOFF_CURRENT_USER_MESSAGE}\n\n${userPrompt}`;
}

/** True when `text` opens with a complete json-v2 carrier (the pipeline's first prompt). */
export function startsWithAgentHandoffCarrier(text: unknown): boolean {
  return (
    typeof text === "string" &&
    text.trimStart().startsWith(AGENT_HANDOFF_OPEN) &&
    text.includes(AGENT_HANDOFF_CLOSE)
  );
}
