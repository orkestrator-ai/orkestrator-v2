import { AGENT_ACTIVITY_STATES } from "@orkestrator/protocol/agent-activity";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_LIMITS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  isAgentInteractionSnapshot,
  type AgentInteractionApplyOutcome,
  type AgentInteractionRequest,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import {
  MAX_NATIVE_AGENT_DRIFT_KINDS,
  MAX_NATIVE_AGENT_DRIFT_KIND_LENGTH,
  NATIVE_AGENT_NOTICE_SEVERITIES,
  NATIVE_AGENT_NOTICE_SOURCES,
  type NativeAgentContextUsage,
  type NativeAgentNotice,
  type NativeAgentNoticeSeverity,
  type NativeAgentNoticeSource,
  type NativeAgentRateLimitWindow,
  type NativeAgentRuntimeDrift,
  type NativeAgentRuntimeNotice,
  type NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import type {
  ProviderActivityState,
  ProviderSessionRegistration,
} from "./agent-provider-contract.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";

export const PROVIDER_ACTIVITY_STATES: readonly ProviderActivityState[] = [
  ...AGENT_ACTIVITY_STATES,
  "missing",
];

export function isProviderActivityState(value: unknown): value is ProviderActivityState {
  return PROVIDER_ACTIVITY_STATES.includes(value as ProviderActivityState);
}

export const DEFAULT_SESSION_REGISTRATION: ProviderSessionRegistration = Object.freeze({
  origin: "interactive-native",
  interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
});
export const MAX_TRACKED_INTERACTION_SESSIONS = 1_024;
export const MAX_TRACKED_PROVIDER_INTERACTIONS = 4_096;
// This page is only a bounded positive-existence cache seed. Absence from it
// never proves deletion; only a per-session 404 may manufacture `missing`.
export const INTERACTIVE_RUNTIME_METADATA_TTL_MS = 30_000;
/** Distinct runtime notices the backend accepts from one bridge read. */
export const MAX_PROVIDER_RUNTIME_NOTICES = 32;
/** Advisories promoted into a session projection, newest kept. */
export const MAX_PROJECTION_ADVISORIES = 5;
export const INTERACTIVE_RUNTIME_METADATA_RETRY_MS = 5_000;
export function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maximumSize: number,
): void {
  if (!map.has(key) && map.size >= maximumSize) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function setBoundedSetEntry<T>(set: Set<T>, value: T, maximumSize: number): void {
  if (!set.has(value) && set.size >= maximumSize) {
    const oldest = set.values().next().value as T | undefined;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reject an SDK envelope that carries an error instead of data.
 *
 * The envelope's own error body is deliberately not interpolated: it can quote
 * a prompt, a path, or a credential, and this message reaches logs.
 */
export function assertSdkResponse(response: { error?: unknown }, operation: string): void {
  if (response.error) {
    throw new Error(`${operation} failed`);
  }
}

/**
 * Statuses that mean "ask again later" rather than "this request was wrong".
 * Callers map these to ProviderUnavailableError so bounded reconnect handling
 * runs instead of failing a session outright.
 */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function normalizeProviderContextUsage(value: unknown): NativeAgentContextUsage | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const usedTokens =
    typeof raw.usedTokens === "number" && Number.isFinite(raw.usedTokens)
      ? Math.max(0, raw.usedTokens)
      : undefined;
  const maximumTokens =
    typeof raw.totalTokens === "number" && Number.isFinite(raw.totalTokens)
      ? Math.max(0, raw.totalTokens)
      : typeof raw.maximumTokens === "number" && Number.isFinite(raw.maximumTokens)
        ? Math.max(0, raw.maximumTokens)
        : undefined;
  const percentage =
    typeof raw.percentUsed === "number" && Number.isFinite(raw.percentUsed)
      ? Math.max(0, Math.min(100, raw.percentUsed))
      : typeof raw.percentage === "number" && Number.isFinite(raw.percentage)
        ? Math.max(0, Math.min(100, raw.percentage))
        : undefined;
  if (usedTokens === undefined) return undefined;
  const usage: NativeAgentContextUsage = {
    usedTokens,
    ...(maximumTokens === undefined ? {} : { maximumTokens }),
    ...(percentage === undefined ? {} : { percentage }),
  };
  const optionalNumbers = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "lastTurnTokens",
    "sessionTokens",
    "costUsd",
    "durationMs",
    "apiDurationMs",
    "permissionDenials",
    "linesAdded",
    "linesRemoved",
  ] as const;
  for (const key of optionalNumbers) {
    const candidate = raw[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      usage[key] = candidate;
    }
  }
  if (typeof raw.modelId === "string") usage.modelId = raw.modelId.slice(0, 256);
  if (typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))) {
    usage.updatedAt = raw.updatedAt;
  }
  if (typeof raw.estimated === "boolean") usage.estimated = raw.estimated;
  if (
    raw.source === "claude" ||
    raw.source === "opencode" ||
    raw.source === "codex" ||
    raw.source === "cursor" ||
    raw.source === "grok" ||
    raw.source === "pi" ||
    raw.source === "heuristic" ||
    raw.source === "provider"
  )
    usage.source = raw.source;
  const rateLimits = normalizeProviderRateLimits(raw.rateLimits);
  if (rateLimits.length > 0) usage.rateLimits = rateLimits;
  const credits = asRecord(raw.credits);
  if (credits) {
    const normalized = {
      ...(typeof credits.hasCredits === "boolean" ? { hasCredits: credits.hasCredits } : {}),
      ...(typeof credits.unlimited === "boolean" ? { unlimited: credits.unlimited } : {}),
      ...(typeof credits.balance === "string" ? { balance: credits.balance.slice(0, 64) } : {}),
    };
    if (Object.keys(normalized).length > 0) usage.credits = normalized;
  }
  if (Array.isArray(raw.contextCategories)) {
    const categories = raw.contextCategories.slice(0, 64).flatMap((candidate) => {
      const category = asRecord(candidate);
      if (
        !category ||
        typeof category.name !== "string" ||
        typeof category.tokens !== "number" ||
        !Number.isFinite(category.tokens) ||
        category.tokens < 0
      )
        return [];
      return [
        {
          name: category.name.slice(0, 128),
          tokens: category.tokens,
          ...(typeof category.color === "string" ? { color: category.color.slice(0, 64) } : {}),
        },
      ];
    });
    if (categories.length > 0) usage.contextCategories = categories;
  }
  if (Array.isArray(raw.turns)) {
    const turns = raw.turns.slice(-20).flatMap((candidate) => {
      const turn = asRecord(candidate);
      if (!turn || typeof turn.turnId !== "string" || turn.turnId.length === 0) return [];
      const normalized: NonNullable<NativeAgentContextUsage["turns"]>[number] = {
        turnId: turn.turnId.slice(0, 256),
      };
      for (const key of [
        "costUsd",
        "rawCostUsd",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "reasoningTokens",
        "totalTokens",
        "durationMs",
        "apiDurationMs",
        "ttftMs",
        "numTurns",
        "toolCalls",
      ] as const) {
        const value = turn[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          normalized[key] = value;
      }
      if (typeof turn.requestId === "string") normalized.requestId = turn.requestId.slice(0, 256);
      if (typeof turn.modelId === "string") normalized.modelId = turn.modelId.slice(0, 256);
      return [normalized];
    });
    if (turns.length > 0) usage.turns = turns;
  }
  if (Array.isArray(raw.account)) {
    const priority = new Set(["primary", "secondary", "credits"]);
    const stable = raw.account.filter((candidate) => {
      const entry = asRecord(candidate);
      return typeof entry?.window === "string" && priority.has(entry.window);
    });
    const remainder = raw.account.filter((candidate) => {
      const entry = asRecord(candidate);
      return typeof entry?.window !== "string" || !priority.has(entry.window);
    });
    const candidates = [...stable.slice(0, 3), ...remainder.slice(-(16 - stable.length))].slice(
      0,
      16,
    );
    const account = candidates.flatMap((candidate) => {
      const window = asRecord(candidate);
      if (!window || typeof window.window !== "string" || window.window.length === 0) return [];
      const normalized: NonNullable<NativeAgentContextUsage["account"]>[number] = {
        window: window.window.slice(0, 128),
      };
      if (typeof window.label === "string") normalized.label = window.label.slice(0, 128);
      for (const key of [
        "tokens",
        "usedPercent",
        "spendUsd",
        "creditsRemaining",
        "limitUsd",
      ] as const) {
        const value = window[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          normalized[key] = value;
      }
      if (typeof window.creditBalance === "string" && window.creditBalance.length > 0) {
        normalized.creditBalance = window.creditBalance.slice(0, 64);
      }
      if (typeof window.resetsAt === "string" && Number.isFinite(Date.parse(window.resetsAt))) {
        normalized.resetsAt = window.resetsAt;
      }
      return [normalized];
    });
    if (account.length > 0) usage.account = account;
  }
  if (Array.isArray(raw.permissionDenialDetails)) {
    const details = raw.permissionDenialDetails.slice(-20).flatMap((candidate) => {
      const denial = asRecord(candidate);
      if (!denial || typeof denial.toolName !== "string" || denial.toolName.length === 0) return [];
      return [
        {
          toolName: denial.toolName.slice(0, 128),
          ...(typeof denial.toolUseId === "string"
            ? { toolUseId: denial.toolUseId.slice(0, 256) }
            : {}),
          ...(typeof denial.reason === "string" ? { reason: denial.reason.slice(0, 512) } : {}),
        },
      ];
    });
    if (details.length > 0) usage.permissionDenialDetails = details;
  }
  return usage;
}

export function normalizeProviderRateLimits(value: unknown): NativeAgentRateLimitWindow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((candidate) => {
    const limit = asRecord(candidate);
    if (!limit || typeof limit.label !== "string" || limit.label.length === 0) return [];
    const usedPercent =
      typeof limit.usedPercent === "number" &&
      Number.isFinite(limit.usedPercent) &&
      limit.usedPercent >= 0 &&
      limit.usedPercent <= 100
        ? limit.usedPercent
        : undefined;
    const windowMinutes =
      typeof limit.windowMinutes === "number" &&
      Number.isFinite(limit.windowMinutes) &&
      limit.windowMinutes >= 0
        ? limit.windowMinutes
        : undefined;
    const resetsAt =
      typeof limit.resetsAt === "string" && Number.isFinite(Date.parse(limit.resetsAt))
        ? limit.resetsAt
        : undefined;
    return [
      {
        label: limit.label.slice(0, 128),
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(windowMinutes === undefined ? {} : { windowMinutes }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ];
  });
}

/**
 * Accept a runtime summary a bridge already reports in neutral form.
 *
 * Claude's and Codex's summaries are assembled here from provider-shaped
 * responses; the ACP bridge has to normalize its own because only it can see
 * the vendor `_meta` the counts come from. Every field stays optional so a
 * bridge that knows one fact is not forced to invent the rest.
 */
export function normalizeProviderRuntimeSummary(
  value: unknown,
): NativeAgentRuntimeSummary | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const summary: NativeAgentRuntimeSummary = {};
  const counts = [
    "mcpServers",
    "plugins",
    "commands",
    "skills",
    "hooks",
    "lspServers",
    "formatters",
    "todos",
    "files",
  ] as const;
  for (const key of counts) {
    const candidate = raw[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
      summary[key] = Math.min(candidate, 10_000);
    }
  }
  if (typeof raw.state === "string" && raw.state) summary.state = raw.state.slice(0, 64);
  if (typeof raw.version === "string" && raw.version) summary.version = raw.version.slice(0, 64);
  const drift = normalizeProviderDrift(raw.drift);
  if (drift) summary.drift = drift;
  const notices = normalizeProviderRuntimeNotices(raw.notices);
  if (notices.length > 0) summary.notices = notices;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * What the bridge saw and did not understand, bounded again at this hop.
 *
 * The bridge already bounds this, but the bridge is a separate process serving
 * a JSON body: the backend must not take a count or a list on trust. Names
 * only — a payload never crosses this boundary, by construction.
 */
export function normalizeProviderDrift(value: unknown): NativeAgentRuntimeDrift | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const unknownEvents = raw.unknownEvents;
  if (typeof unknownEvents !== "number" || !Number.isSafeInteger(unknownEvents)) return undefined;
  if (unknownEvents <= 0) return undefined;
  const unknownKinds = Array.isArray(raw.unknownKinds)
    ? raw.unknownKinds
        .filter((kind): kind is string => typeof kind === "string" && kind.length > 0)
        .slice(-MAX_NATIVE_AGENT_DRIFT_KINDS)
        .map((kind) => kind.slice(0, MAX_NATIVE_AGENT_DRIFT_KIND_LENGTH))
    : [];
  return { unknownEvents: Math.min(unknownEvents, 1_000_000), unknownKinds };
}

export function normalizeProviderRuntimeNotices(value: unknown): NativeAgentRuntimeNotice[] {
  if (!Array.isArray(value)) return [];
  const notices: NativeAgentRuntimeNotice[] = [];
  for (const candidate of value.slice(-MAX_PROVIDER_RUNTIME_NOTICES)) {
    const item = asRecord(candidate);
    const message = item?.message;
    if (!item || typeof message !== "string" || message.length === 0) continue;
    const id = typeof item.id === "string" && item.id ? item.id.slice(0, 256) : undefined;
    const subject =
      typeof item.subject === "string" && item.subject ? item.subject.slice(0, 256) : undefined;
    const method = typeof item.method === "string" && item.method ? item.method : undefined;
    const count = item.count;
    const severity = NATIVE_AGENT_NOTICE_SEVERITIES.includes(
      item.severity as NativeAgentNoticeSeverity,
    )
      ? (item.severity as NativeAgentNoticeSeverity)
      : // Everything predating the field was a warning from the bridge itself.
        "warning";
    const source = NATIVE_AGENT_NOTICE_SOURCES.includes(item.source as NativeAgentNoticeSource)
      ? (item.source as NativeAgentNoticeSource)
      : "bridge";
    const occurrences = Array.isArray(item.occurrences)
      ? item.occurrences.slice(-5).flatMap((rawOccurrence) => {
          const occurrence = asRecord(rawOccurrence);
          if (!occurrence) return [];
          const detail =
            typeof occurrence.detail === "string" && occurrence.detail
              ? occurrence.detail.slice(0, 1_000)
              : undefined;
          const receivedAt =
            typeof occurrence.receivedAt === "string" && occurrence.receivedAt
              ? occurrence.receivedAt.slice(0, 64)
              : undefined;
          return detail || receivedAt
            ? [{ ...(detail ? { detail } : {}), ...(receivedAt ? { receivedAt } : {}) }]
            : [];
        })
      : [];
    notices.push({
      message: message.slice(0, 1_000),
      ...(id ? { id } : {}),
      ...(subject ? { subject } : {}),
      ...(method ? { method: method.slice(0, 128) } : {}),
      ...(typeof count === "number" && Number.isSafeInteger(count) && count > 1
        ? { count: Math.min(count, 1_000_000) }
        : {}),
      severity,
      source,
      ...(occurrences.length > 0 ? { occurrences } : {}),
    });
  }
  return notices;
}

/**
 * Provider advisories the tab should show, not only the health panel.
 *
 * Only `error` crosses. A `warning` is something the provider reported about
 * itself — a deprecation, a rerouted model, an MCP server that did not start —
 * and belongs with the rest of the runtime inventory in the health panel, where
 * it can be expanded for the occurrences behind it. Pinning it above the
 * composer put a dismissable banner in front of the transcript for a condition
 * the user cannot act on mid-turn. An `error` still crosses because it says the
 * session in front of the user is broken. Bounded to five and deduplicated by
 * stable condition identity, because these are appended to a projection a renderer holds for the
 * life of a session.
 */
export function providerAdvisoryNotices(
  notices: readonly NativeAgentRuntimeNotice[],
  limit = MAX_PROJECTION_ADVISORIES,
): NativeAgentNotice[] {
  const advisories = new Map<string, NativeAgentNotice & { kind: "advisory"; severity: "error" }>();
  for (const notice of notices) {
    if (notice.severity !== "error") continue;
    const latestOccurrence = notice.occurrences?.at(-1);
    const occurrenceId =
      notice.id ??
      (latestOccurrence?.receivedAt
        ? `${notice.source ?? "bridge"}\u0000${notice.method ?? ""}\u0000${latestOccurrence.receivedAt}\u0000${notice.count ?? 1}`
        : notice.count !== undefined
          ? `${notice.source ?? "bridge"}\u0000${notice.method ?? ""}\u0000count:${notice.count}`
          : undefined);
    const key = notice.id ?? notice.message;
    // Reinsert replacements so the bound follows the most recent occurrence.
    advisories.delete(key);
    advisories.set(key, {
      kind: "advisory" as const,
      message: notice.message,
      severity: "error",
      ...(occurrenceId ? { occurrenceId } : {}),
    });
  }
  return [...advisories.values()].slice(-limit);
}

export function providerInventoryCount(value: unknown): number {
  if (Array.isArray(value)) return Math.min(value.length, 10_000);
  const data = asRecord(value)?.data;
  if (Array.isArray(data)) {
    return Math.min(
      10_000,
      data.reduce((count, entry) => {
        const item = asRecord(entry);
        const nested = item?.skills ?? item?.hooks ?? item?.servers;
        return count + (Array.isArray(nested) ? nested.length : 1);
      }, 0),
    );
  }
  return Math.min(
    10_000,
    Object.keys(asRecord(value) ?? {}).filter((key) => key !== "error").length,
  );
}

export function boundedText(
  value: unknown,
  fallback: string,
  maximumLength: number = AGENT_INTERACTION_LIMITS.maxTextLength,
): string {
  const text = nonEmptyString(value) ?? fallback;
  if (text.length > maximumLength) {
    throw new ProviderUnavailableError("Provider interaction snapshot is oversized");
  }
  return text;
}

export function truncatedText(
  value: unknown,
  fallback: string,
  maximumLength: number = AGENT_INTERACTION_LIMITS.maxTextLength,
): string {
  const text = nonEmptyString(value) ?? fallback;
  if (text.length <= maximumLength) return text;
  return `${text.slice(0, Math.max(0, maximumLength - 1))}…`;
}

export function boundedJoinedText(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  return boundedText(lines.join("\n"), "Interaction details");
}

export function truncatedJoinedText(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  return truncatedText(lines.join("\n"), "Interaction details");
}

export function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError(`Provider returned malformed ${label}`);
  }
  if (value.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion) {
    throw new ProviderUnavailableError(`Provider returned too many ${label}`);
  }
  return value.map((entry) => {
    const text = nonEmptyString(entry);
    if (!text) {
      throw new ProviderUnavailableError(`Provider returned malformed ${label}`);
    }
    return boundedText(text, label);
  });
}

export function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function opaqueOptionId(questionIndex: number, optionIndex: number): string {
  return `q${questionIndex}:o${optionIndex}`;
}

export function requestCreatedAt(expiresAt: number | undefined, now: number): number {
  return expiresAt === undefined
    ? now
    : Math.max(0, expiresAt - AGENT_INTERACTION_DEFAULT_TIMEOUT_MS);
}

export class InteractionSnapshotTracker {
  private readonly registrations = new Map<string, ProviderSessionRegistration>();
  /**
   * Sessions whose registration came from a caller rather than from the
   * implicit default.
   *
   * {@link snapshot} registers an unknown session so it can be tracked at all,
   * and that placeholder says `interactive-native`. Without this distinction,
   * first-write-wins would let one early read permanently pin an unattended
   * provider session to the interactive policy — it would simply stop
   * auto-resolving, with nothing to show for it.
   */
  private readonly explicitRegistrations = new Set<string>();
  private readonly fingerprints = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly firstSeenAt = new Map<string, number>();
  private readonly interactionSessions = new Map<string, string>();

  register(sessionId: string, interaction?: ProviderSessionRegistration): void {
    if (
      !this.registrations.has(sessionId) &&
      this.registrations.size >= MAX_TRACKED_INTERACTION_SESSIONS
    ) {
      const oldest = this.registrations.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.registrations.delete(oldest);
        this.explicitRegistrations.delete(oldest);
        this.fingerprints.delete(oldest);
        this.revisions.delete(oldest);
        for (const [interactionId, ownerSessionId] of this.interactionSessions) {
          if (ownerSessionId !== oldest) continue;
          this.interactionSessions.delete(interactionId);
          this.firstSeenAt.delete(interactionId);
        }
      }
    }
    const existing = this.registrations.get(sessionId);
    if (existing === undefined) {
      this.registrations.set(sessionId, interaction ?? DEFAULT_SESSION_REGISTRATION);
      if (interaction) this.explicitRegistrations.add(sessionId);
      return;
    }
    if (!interaction) return;
    // The placeholder written by an early read is not a decision, so the first
    // real registration replaces it outright.
    if (!this.explicitRegistrations.has(sessionId)) {
      this.registrations.set(sessionId, interaction);
      this.explicitRegistrations.add(sessionId);
      return;
    }
    // Policy is fixed before the first request. Re-registering a restored or
    // cached provider may reassert the same metadata, but must never switch a
    // live session between interactive and unattended while a request exists.
    if (
      interaction.origin !== existing.origin ||
      interaction.interactionPolicy.mode !== existing.interactionPolicy.mode
    )
      return;
    // Same identity, so fill in metadata the first caller did not have —
    // callers differ in what they know (the activity sweep has no `phase`, the
    // reconciler does) and whichever ran first should not cost the others their
    // fields. Values already recorded are never overwritten: the fence in
    // particular identifies the generation that owns any live request.
    this.registrations.set(sessionId, {
      ...existing,
      phase: existing.phase ?? interaction.phase,
      workflowId: existing.workflowId ?? interaction.workflowId,
      provider: existing.provider ?? interaction.provider,
      fence: existing.fence ?? interaction.fence,
    });
  }

  registration(sessionId: string): ProviderSessionRegistration {
    return this.registrations.get(sessionId) ?? DEFAULT_SESSION_REGISTRATION;
  }

  firstSeen(interactionId: string, fallback = Date.now()): number {
    const existing = this.firstSeenAt.get(interactionId);
    if (existing !== undefined) return existing;
    setBoundedMapEntry(
      this.firstSeenAt,
      interactionId,
      fallback,
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    return fallback;
  }

  sessionFor(interactionId: string): string | undefined {
    return this.interactionSessions.get(interactionId);
  }

  snapshot(sessionId: string, requests: AgentInteractionRequest[]): AgentInteractionSnapshot {
    if (requests.length > AGENT_INTERACTION_LIMITS.maxPendingRequests) {
      throw new ProviderUnavailableError("Provider returned too many pending interactions");
    }
    const fingerprint = JSON.stringify(requests);
    const previous = this.fingerprints.get(sessionId);
    const revision =
      previous === fingerprint
        ? (this.revisions.get(sessionId) ?? 0)
        : (this.revisions.get(sessionId) ?? 0) + 1;
    const normalized = requests.map((request) => ({ ...request, revision }));
    const snapshot: AgentInteractionSnapshot = {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      revision,
      requests: normalized,
    };
    // Validation must precede every tracker mutation. Otherwise a rejected
    // snapshot can still retain its fingerprint and poison revision/identity
    // state for later authoritative reads.
    if (!isAgentInteractionSnapshot(snapshot)) {
      throw new ProviderUnavailableError("Provider returned a malformed interaction snapshot");
    }
    if (!this.registrations.has(sessionId)) this.register(sessionId);
    this.fingerprints.set(sessionId, fingerprint);
    this.revisions.set(sessionId, revision);
    const currentIds = new Set(normalized.map((request) => request.id));
    for (const [interactionId, ownerSessionId] of this.interactionSessions) {
      if (ownerSessionId !== sessionId || currentIds.has(interactionId)) continue;
      this.interactionSessions.delete(interactionId);
      this.firstSeenAt.delete(interactionId);
    }
    for (const request of normalized) {
      setBoundedMapEntry(
        this.interactionSessions,
        request.id,
        sessionId,
        MAX_TRACKED_PROVIDER_INTERACTIONS,
      );
    }
    return snapshot;
  }
}

export function outcome(
  result: AgentInteractionApplyOutcome["result"],
  sessionId: string,
  interactionId: string,
  revision: number,
): AgentInteractionApplyOutcome {
  return { result, sessionId, interactionId, revision };
}
