/**
 * Pure helpers for `NativeAgentTranscriptProjection`: provider-reported image
 * paths, visible notices, usage merging, progress folding, progressive message
 * checks, display stripping and discovery keys. None of them hold state.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripUserCommandContext } from "@orkestrator/protocol/user-commands";
import { stripCoordinatorContext } from "@orkestrator/protocol/coordinator";
import {
  recoverBackgroundTaskLaunchId,
  type NativeAgentContextUsage,
  type NativeAgentNotice,
  type NativeAgentRetiredDispatch,
} from "@orkestrator/protocol/native-agent";
import { isGoalCarrierContent } from "@orkestrator/protocol/native-agent-goal";
import { AGENT_INTERACTION_KINDS } from "@orkestrator/protocol/agent-interactions";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import { redactArtifactGrantArgs } from "@orkestrator/protocol/transcript-artifacts";
import { BRIDGE_PAGE_OVERSIZED_ROW_MAX_BYTES } from "@orkestrator/protocol/node/bridge-transcript-summary";
import type {
  AgentInteractionKind,
  AgentModel,
  BuildPipelineAgent,
  IncompleteTurnNotice,
  NativeAgentMessageWindow,
  ProviderTranscriptSnapshot,
} from "./native-agent-service-shared.js";
import { NATIVE_HISTORY_PAGE_MAX_TARGET_BYTES } from "./native-agent-service-shared.js";
import { retiredDispatchNotice } from "./native-agent-retired-dispatch.js";
import { sessionTitleSourceText } from "./session-title-text.js";

const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);
const READ_TOOL_KEYS = new Set(["read", "readfile", "cursorread", "view", "viewfile"]);
const READ_TOOL_PATH_KEYS = ["file_path", "filePath", "path", "target_file", "file"] as const;

/**
 * The first user message a read holds that still has the user's own words,
 * and whether the read starts at the beginning of the conversation. Only then
 * is that message the conversation's first, which is what a title names.
 */
export function firstUserMessageOf(
  messages: readonly unknown[],
  window:
    Pick<NativeAgentMessageWindow, "truncated" | "omittedMessages" | "canLoadEarlier"> | undefined,
): { firstUserMessage?: string; reachesStart: boolean } {
  const reachesStart =
    !window?.truncated || ((window.omittedMessages ?? -1) === 0 && window.canLoadEarlier !== true);
  for (const candidate of messages) {
    const message = candidate as { role?: unknown; content?: unknown };
    if (message.role !== "user" || typeof message.content !== "string") continue;
    // A goal turn is the loop's text, never the user's words, even when it is
    // the first row of a new tab.
    if (isGoalCarrierContent(message.content)) continue;
    if (sessionTitleSourceText(message.content)) {
      return { firstUserMessage: message.content, reachesStart };
    }
  }
  return { reachesStart };
}

function localImagePath(reference: unknown): string | undefined {
  if (typeof reference !== "string" || /[\0\r\n]/.test(reference)) return undefined;
  let candidate = reference.trim();
  if (!candidate) return undefined;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return undefined;
    }
  }
  if (!path.isAbsolute(candidate) || !IMAGE_MIME_TYPES.has(path.extname(candidate).toLowerCase())) {
    return undefined;
  }
  return candidate;
}

export function providerReportedImagePath(part: Record<string, unknown>): string | undefined {
  if (part.type === "image") {
    return (
      localImagePath(part.fileUrl) ?? localImagePath(part.filename) ?? localImagePath(part.content)
    );
  }
  if (part.type !== "tool-invocation" || part.toolState !== "success") return undefined;
  const toolKey =
    typeof part.toolName === "string"
      ? part.toolName.trim().toLowerCase().replace(/[_-]+/g, "")
      : "";
  if (!READ_TOOL_KEYS.has(toolKey)) return undefined;
  const args =
    part.toolArgs && typeof part.toolArgs === "object" && !Array.isArray(part.toolArgs)
      ? (part.toolArgs as Record<string, unknown>)
      : undefined;
  for (const key of READ_TOOL_PATH_KEYS) {
    const candidate = localImagePath(args?.[key]);
    if (candidate) return candidate;
  }
  return localImagePath(part.toolTitle);
}

/** Tool arguments with the artifact scope grant redacted (see `redactArtifactGrantArgs`). */
export function redactArtifactGrant(
  part: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return redactArtifactGrantArgs(part.toolName, part.toolArgs, {
    toolTitle: part.toolTitle,
    mcpServerName: part.mcpServerName,
  });
}

export function imageMimeType(filePath: string): string {
  return IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "image/png";
}

export function visibleProjectionNotices(
  agent: BuildPipelineAgent,
  notices: readonly NativeAgentNotice[] | undefined,
  incompleteTurn: IncompleteTurnNotice | undefined,
  retiredDispatch?: NativeAgentRetiredDispatch,
): NativeAgentNotice[] {
  const owned: NativeAgentNotice[] = [];
  if (incompleteTurn) {
    const label = AGENT_PLATFORM_LABELS[agent] ?? agent;
    owned.push({
      kind: "incomplete-turn",
      message:
        incompleteTurn.kind === "failed"
          ? `The previous ${label} turn ended before completion.`
          : `${label} could not complete the previous turn after recovery.`,
    });
  }
  if (retiredDispatch) owned.push(retiredDispatchNotice(retiredDispatch));
  const visible = (notices ?? [])
    .filter((notice) => notice.kind !== "error" && notice.kind !== "stopped")
    .slice(0, 512 - owned.length);
  return [...visible, ...owned];
}

/**
 * Carry sparse provider turn rows across projection reads.
 *
 * Live bridge events often contain only the newest row. The backend projection
 * is the renderer's authoritative reload source, so replacing that sparse list
 * would make older rows disappear whenever the tab remounted. Re-inserting by
 * id also moves a corrected row to the newest position while retaining the
 * strict twenty-row bound.
 */
const CUMULATIVE_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "sessionTokens",
  "costUsd",
  "durationMs",
  "apiDurationMs",
] as const;

const CUMULATIVE_USAGE_SOURCES = new Set<NativeAgentContextUsage["source"]>([
  "claude",
  "opencode",
  "codex",
]);

function isCumulativeUsageSource(source: NativeAgentContextUsage["source"]): boolean {
  return source !== undefined && CUMULATIVE_USAGE_SOURCES.has(source);
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

export function mergeContextUsageTurns(
  previous: NativeAgentContextUsage | undefined,
  current: NativeAgentContextUsage | undefined,
): NativeAgentContextUsage | undefined {
  if (!current) return previous;
  const turns = new Map((previous?.turns ?? []).map((turn) => [turn.turnId, turn]));
  for (const turn of current.turns ?? []) {
    turns.delete(turn.turnId);
    turns.set(turn.turnId, turn);
  }
  const mergedTurns = [...turns.values()].slice(-20);
  const merged: NativeAgentContextUsage = {
    ...current,
    ...(mergedTurns.length > 0 ? { turns: mergedTurns } : {}),
  };
  if (!previous) return merged;
  // Lifetime spend can only grow for providers whose top-level counters are
  // cumulative. A later OpenCode or Claude snapshot that only sees the live
  // transcript tail would otherwise walk session/cache/cost backwards.
  // ACP-backed cursor, grok, and pi publish those same fields as the current
  // turn, so clamping them would freeze the panel on the largest turn ever
  // seen. Context occupancy (`usedTokens`) is always left on `current` so
  // compaction can shrink the gauge.
  if (isCumulativeUsageSource(current.source)) {
    for (const key of CUMULATIVE_USAGE_KEYS) {
      const value = maxDefined(previous[key], current[key]);
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * Provider-owned mid-turn items are already accepted. Keep those first and
 * consume at most one backend-queue counterpart for each, so a Pi follow-up
 * does not appear twice after both layers observed it. Distinct backend rows
 * stay distinct even when they share text.
 */
export function mergeNativeAgentQueueItems(
  providerItems: readonly unknown[],
  backendItems: readonly unknown[],
): unknown[] {
  const fields = (item: unknown) => {
    const record =
      item && typeof item === "object" ? (item as { text?: unknown; id?: unknown }) : {};
    return {
      text: typeof record.text === "string" ? record.text.trim() : "",
      id: typeof record.id === "string" ? record.id.trim() : "",
    };
  };
  const remaining = [...backendItems];
  const consumeCounterpart = (item: unknown) => {
    const { text, id } = fields(item);
    const index = remaining.findIndex((candidate) => {
      const other = fields(candidate);
      return (id !== "" && other.id === id) || (text !== "" && other.text === text);
    });
    if (index >= 0) remaining.splice(index, 1);
  };
  const merged: unknown[] = [];
  for (const item of providerItems) {
    merged.push(item);
    consumeCounterpart(item);
  }
  merged.push(...remaining);
  return merged;
}

/**
 * Fill the context-window denominator a provider omitted.
 *
 * Several providers report occupancy (`usedTokens`) without the model's context
 * size, which leaves the panel unable to show used-versus-total or a
 * percentage. The selected model knows the window, so the projection supplies
 * it and derives the percentage. An explicitly reported maximum or percentage
 * always wins; this only fills what the provider left absent.
 *
 * `fallback` is the previously projected usage for the same session. A
 * progressive state read carries no model list, so on a cold catalogue it
 * cannot resolve the selected model's window; without the fallback it would
 * replace the filled gauge from the last full projection with a bare total.
 * A resolved window still takes precedence, so a model change is not masked
 * when the catalogue actually knows the new model.
 */
export function withProviderContextWindow(
  usage: NativeAgentContextUsage | undefined,
  contextWindow: number | undefined,
  fallback?: NativeAgentContextUsage,
): NativeAgentContextUsage | undefined {
  if (!usage) return usage;
  const maximumTokens =
    usage.maximumTokens ??
    (contextWindow !== undefined && contextWindow > 0 ? contextWindow : undefined) ??
    fallback?.maximumTokens;
  return {
    ...usage,
    ...(usage.maximumTokens === undefined && maximumTokens !== undefined ? { maximumTokens } : {}),
    // A non-positive denominator is not a usable window: dividing by it would
    // report a bogus 100%. Keep whatever the provider reported and omit the
    // percentage, matching the truthiness check this replaced.
    ...(usage.percentage === undefined && maximumTokens !== undefined && maximumTokens > 0
      ? {
          percentage: Math.max(0, Math.min(100, (usage.usedTokens / maximumTokens) * 100)),
        }
      : {}),
  };
}

/**
 * Preserve only the opaque launch id before the full result moves behind a
 * detail reference.
 *
 * This is the renderer's only chance to see the text: `projectionPart` strips
 * `toolOutput` from every part it sends. The recovery rule itself lives in
 * `@orkestrator/protocol` so both sides of the boundary agree on which rows
 * own a task — a command backgrounded with Ctrl+B or by a foreground timeout
 * carries no `run_in_background` argument, and would otherwise be invisible.
 */
export function backgroundTaskIdFromProjectedLaunch(
  part: Record<string, unknown>,
): string | undefined {
  if (part.type !== "tool-invocation") return undefined;
  return recoverBackgroundTaskLaunchId(part);
}

/**
 * Fold `progress` parts onto the tool rows they describe.
 *
 * A provider reports progress as its own event, so an adapter can only emit it
 * as a loose part; but a progress line beside a tool row rather than on it
 * reads as a second thing happening. Matching by `toolUseId` here means the
 * renderer receives a tool row with a `progress` field and needs no notion of
 * a progress part at all.
 *
 * Only the newest report per call survives — progress is a hint over the
 * authoritative `toolState`, so a backlog of superseded lines is noise. A
 * progress part naming a call this message does not contain is dropped rather
 * than kept as an orphan row: it belongs to a tool the transcript no longer
 * holds, and there is nothing for a reader to relate it to.
 */
export function attachProgressToToolRows(parts: unknown[]): unknown[] {
  const progressByToolUseId = new Map<string, Record<string, unknown>>();
  for (const candidate of parts) {
    const part = progressRecord(candidate);
    if (part?.type !== "progress") continue;
    const toolUseId = part.toolUseId;
    if (typeof toolUseId !== "string" || !toolUseId) continue;
    progressByToolUseId.set(toolUseId, {
      content: typeof part.content === "string" ? part.content : "",
      ...(typeof part.elapsedMs === "number" &&
      Number.isFinite(part.elapsedMs) &&
      part.elapsedMs >= 0
        ? { elapsedMs: part.elapsedMs }
        : {}),
      ...(typeof part.createdAt === "string" ? { createdAt: part.createdAt } : {}),
    });
  }
  // Nothing to fold *and* nothing to drop: return the same array so the common
  // case allocates nothing.
  const hasProgressPart = parts.some((candidate) => progressRecord(candidate)?.type === "progress");
  if (!hasProgressPart) return parts;
  return parts.flatMap((candidate) => {
    const part = progressRecord(candidate);
    if (part?.type === "progress") return [];
    const toolUseId = part?.toolUseId;
    if (typeof toolUseId !== "string") return [candidate];
    const progress = progressByToolUseId.get(toolUseId);
    return progress ? [{ ...part, progress }] : [candidate];
  });
}

function progressRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A session's own report of what it can raise, bounded and validated.
 *
 * Absent means "not reported", which leaves the platform table standing.
 * Present-and-empty is a real answer — "this session never asks" — and is the
 * whole reason the two are distinguished.
 */
export function normalizeInteractionKinds(value: unknown): AgentInteractionKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds = value.filter((kind): kind is AgentInteractionKind =>
    (AGENT_INTERACTION_KINDS as readonly string[]).includes(kind as string),
  );
  return [...new Set(kinds)];
}

export function isNormalizedProgressiveMessage(value: unknown): value is {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: unknown[];
  createdAt: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const role = message.role;
  return (
    typeof message.id === "string" &&
    (role === "user" || role === "assistant" || role === "system") &&
    typeof message.content === "string" &&
    Array.isArray(message.parts) &&
    typeof message.createdAt === "string"
  );
}

export function normalizedProgressiveMessages(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || !value.every(isNormalizedProgressiveMessage)) return null;
  return value;
}

/**
 * Remove server-authored preambles from a user row for display: the
 * coordinator block (coordinator conversations only), then the block telling
 * the agent what the user ran with `!` (shown as its own cards instead).
 */
export function displayMessage<T>(raw: T, coordinator: boolean): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const message = raw as Record<string, unknown>;
  if (message.role !== "user") return raw;
  const strip = (text: string) =>
    stripUserCommandContext(coordinator ? stripCoordinatorContext(text) : text);
  const projected: Record<string, unknown> = { ...message };
  if (typeof message.content === "string") {
    projected.content = strip(message.content);
  }
  if (Array.isArray(message.parts)) {
    let stripped = false;
    projected.parts = message.parts.map((rawPart) => {
      if (stripped || !rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) {
        return rawPart;
      }
      const part = rawPart as Record<string, unknown>;
      if (part.type !== "text" || typeof part.content !== "string") return rawPart;
      const content = strip(part.content);
      if (content === part.content) return rawPart;
      stripped = true;
      return { ...part, content };
    });
  }
  return projected as T;
}

/** The provider cursor before the oldest of `rows` that can name one. */
export function firstNamedCursor(
  rows: readonly unknown[],
  cursorBefore: ProviderTranscriptSnapshot["historyCursorBefore"],
): string | undefined {
  if (!cursorBefore) return undefined;
  for (const row of rows) {
    const id = (row as { id?: unknown } | null)?.id;
    const cursor = typeof id === "string" ? cursorBefore(id) : undefined;
    if (cursor) return cursor;
  }
  return undefined;
}

export function progressiveHydrationToken(snapshot: ProviderTranscriptSnapshot): string {
  if (snapshot.sourceToken) return snapshot.sourceToken;
  const first = snapshot.messages[0] as { id?: unknown } | undefined;
  const last = snapshot.messages.at(-1) as { id?: unknown } | undefined;
  return [
    snapshot.revision ?? "",
    snapshot.complete === false ? "0" : "1",
    snapshot.messages.length,
    typeof first?.id === "string" ? first.id : "",
    typeof last?.id === "string" ? last.id : "",
  ].join(":");
}

export const PROGRESSIVE_HYDRATION_MAX_ATTEMPTS = 3;
export const PROGRESSIVE_HYDRATION_RETRY_BASE_MS = 25;
/** One row of a direct history page: a bridge's oversized-row ceiling plus projection slack. */
export const DIRECT_PAGE_ROW_MAX_BYTES =
  Math.max(NATIVE_HISTORY_PAGE_MAX_TARGET_BYTES, BRIDGE_PAGE_OVERSIZED_ROW_MAX_BYTES) + 64 * 1024;

/**
 * What a discovery section's value means to a view, for deciding whether a
 * change is worth announcing (see `storeProgressiveDiscovery`). Drops the
 * runtime drift counter and orders its unknown kinds; everything else is the
 * value itself.
 */
export function discoveryAnnouncementKey(value: unknown): string {
  return JSON.stringify(value, (key, inner: unknown) => {
    if (key !== "drift" || !inner || typeof inner !== "object" || Array.isArray(inner)) {
      return inner;
    }
    const {
      unknownEvents: _count,
      unknownKinds,
      ...rest
    } = inner as {
      unknownEvents?: unknown;
      unknownKinds?: unknown;
    };
    return {
      ...rest,
      ...(Array.isArray(unknownKinds) ? { unknownKinds: [...unknownKinds].sort() } : {}),
    };
  });
}

/**
 * A model catalogue as a view shows it, independent of the order the
 * discovery fan-out happened to answer in.
 */
export function modelCatalogKey(models: readonly AgentModel[]): string {
  return JSON.stringify(
    [...models].sort((a, b) =>
      a.platform === b.platform
        ? a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
        : a.platform < b.platform
          ? -1
          : 1,
    ),
  );
}
