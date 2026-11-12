import { hostTimeZone } from "@orkestrator/protocol/schedule-time";
import { toast } from "sonner";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import type {
  AgentInteractionApplyOutcome,
  AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import type {
  AgentModel,
  NativeAgentCommandIntent,
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentDispatchOutcome,
  NativeAgentMessagePage,
  NativeAgentMessageWindow,
  NativeAgentModelSubstitution,
  NativeAgentSessionProjection,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentToolDetails,
  NativeAgentViewIdentity,
  NativeAgentDiscoverySection,
  NativeAgentDiscoveryView,
  NativeAgentLiveUpdate,
  NativeAgentSessionStateView,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "@orkestrator/protocol/native-agent-transcript-patch";
import {
  applyNativeAgentTranscriptDelta,
  DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  isNativeAgentSessionProjection,
  NATIVE_AGENT_LIVE_UPDATE_VERSION,
  nativeAgentCapabilities,
} from "@orkestrator/protocol/native-agent";
import { getNativeAgentLiveUpdate } from "@/lib/backend";
import { backendForScope } from "@/lib/backend/scope-backend";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { errorCode, ipcErrorText } from "@orkestrator/protocol/contract/ipc-error";
import {
  disableNativeLiveUpdate,
  invalidateNativeAgentSyncCapability,
  nativeLiveUpdateSupported,
  nativeObservationEventsSupported,
  nativeTranscriptPatchesSupported,
  requireNativeAgentProgressiveSync,
} from "@/lib/native-agent-sync-capabilities";
import type { PermissionRuleChoiceInput } from "@/lib/backend/permission-rules";
import { encodedValueBytes, retainedHistoryBytes } from "@/lib/native-history-accounting";
import {
  NativeDiscoveryReadSchedule,
  nativeSessionReadDemand,
} from "@/lib/native-session-read-policy";
import {
  registerNativeSessionView,
  runNativeSessionReadRound,
  type NativeSessionReadRound,
} from "@/lib/native-session-shared-reads";
import {
  nativeObservationInvalidationMatches,
  subscribeNativeObservationInvalidations,
} from "@/lib/native-observation-events";
import { nativeSessionInvalidationNamesDiscovery } from "@orkestrator/protocol/native-agent-observation";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";
import { createSessionKey } from "@/lib/utils";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import {
  evictNativeAgentHistoryCaches,
  nativeAgentHistoryBudgetBytes,
  nativeAgentHistoryBytesExcept,
  nativeAgentProjectionStore,
  useNativeAgentProjectionStore,
  type NativeAgentProjectionState,
  type NativeAgentSyncCacheEntry,
  type NativeAgentProgressiveCacheEntry,
} from "@/stores/nativeAgentProjectionStore";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { readCoordinatorFor } from "@/lib/read-coordinator";
import type { StoreApi } from "zustand/vanilla";

/** Mirrors the backend ceiling, so the button stops offering what it would clamp. */
const MAX_MESSAGE_WINDOW = 4_096;
import { preferCompleteLiveHead } from "./native-agent-live-head";

export { IDLE_PROJECTION_REFRESH_MS } from "@/lib/native-session-read-policy";
const CLIENT_HISTORY_MAX_MESSAGES = 4_096;
const CLIENT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
/** Mirrors the backend page ceiling so a request is never silently clamped. */
const HISTORY_PAGE_MAX_MESSAGES = 200;
/** Pages of already-held rows a single "load earlier" may step past. */
const MAX_DUPLICATE_PAGE_SKIPS =
  Math.ceil(CLIENT_HISTORY_MAX_MESSAGES / HISTORY_PAGE_MAX_MESSAGES) + 1;
/**
 * How often a tab re-reads the history it holds while a row too large to travel
 * as a revision keeps changing. A row holding running subagents changes with
 * every tool they call, so this is what bounds the cost of following it.
 */
export const HELD_HISTORY_RECONCILE_INTERVAL_MS = 30_000;

function messagePartCount(message: unknown): number {
  const parts = (message as { parts?: unknown })?.parts;
  return Array.isArray(parts) ? parts.length : 0;
}

/**
 * The server's revised rows, by id; the first copy of an id wins because the
 * list is ordered newest change first.
 */
function revisedMessagesById<TMessage>(
  revised: readonly TMessage[] | undefined,
): Map<string, TMessage> | undefined {
  if (!revised?.length) return undefined;
  const byId = new Map<string, TMessage>();
  for (const message of revised) {
    const id = (message as { id?: unknown })?.id;
    if (typeof id === "string" && !byId.has(id)) byId.set(id, message);
  }
  return byId.size > 0 ? byId : undefined;
}

/**
 * Lay the server's revised rows over the copies this tab holds of them.
 *
 * A row is one model response, so a background tool result or a subagent
 * report can land on a row newer ones have already pushed out of the live
 * tail. The copy this tab retained from before that is otherwise never read
 * again, and a card launched there stayed "running" until a reload. A revised
 * row is the server's whole current row, so it replaces the held copy rather
 * than merging into it. Its position is outside the window, so an id this tab
 * does not hold is never inserted; `skip` names rows the same update delivered
 * itself, which stay authoritative. Returns `held` unchanged when nothing
 * differs, so an unchanged revision list keeps object identity (and the
 * cached byte sizes keyed on it).
 */
function withRevisedMessages<TMessage>(
  held: TMessage[],
  revised: ReadonlyMap<string, TMessage> | undefined,
  skip?: ReadonlySet<string>,
): TMessage[] {
  if (!revised || held.length === 0) return held;
  let changed = false;
  const next = held.map((message) => {
    const id = (message as { id?: unknown })?.id;
    if (typeof id !== "string" || skip?.has(id)) return message;
    const replacement = revised.get(id);
    if (
      replacement === undefined ||
      replacement === message ||
      JSON.stringify(replacement) === JSON.stringify(message)
    ) {
      return message;
    }
    changed = true;
    return replacement;
  });
  return changed ? next : held;
}

/**
 * A revision the projection on screen cannot mistake for an older read.
 *
 * `revision` is one ordering within a generation, but the surfaces that mint it
 * do not share a counter: the progressive transport increments locally on every
 * applied view, while joined projections and the full projections mutations
 * answer with carry the backend's own
 * counter, which only moves when content changes. A tab that has polled for a
 * minute has therefore outrun the server's number, and `applyProjection` would
 * drop the next authoritative projection as stale.
 *
 * Only callers that have already fenced their read on sequence and operation
 * epoch may use this — ordering is established there, not here.
 */
function orderedRevision<TMessage>(
  current: NativeAgentSessionProjection<TMessage> | null,
  next: NativeAgentSessionProjection<TMessage>,
): number {
  return current && current.generation === next.generation && current.revision >= next.revision
    ? current.revision + 1
    : next.revision;
}

/**
 * Whether a click can still widen the window of a full projection (the one a
 * mutation answers with).
 *
 * Predating backends omit `canLoadEarlier`. A count (or reasonless) window
 * still responds to a larger `limit`; whole-message byte drops and part
 * trims do not, and a window already at the backend ceiling cannot grow.
 */
function effectiveCanLoadEarlier(window: NativeAgentMessageWindow): boolean {
  if (!window.truncated) return false;
  if (window.canLoadEarlier === false) return false;
  if (window.limit >= MAX_MESSAGE_WINDOW) return false;
  if (window.canLoadEarlier === true) return true;
  return window.truncationReason !== "bytes";
}

function withEffectiveLoadEarlier<TMessage>(
  projection: NativeAgentSessionProjection<TMessage>,
): NativeAgentSessionProjection<TMessage> {
  const window = projection.messageWindow;
  if (!window) return projection;
  if (!window.truncated) {
    if (window.canLoadEarlier !== true) return projection;
    return { ...projection, messageWindow: { ...window, canLoadEarlier: false } };
  }
  const canLoadEarlier = effectiveCanLoadEarlier(window);
  if (window.canLoadEarlier === canLoadEarlier) return projection;
  return { ...projection, messageWindow: { ...window, canLoadEarlier } };
}

/**
 * The load-earlier control, derived from what this client can actually fetch.
 *
 * A click can still act in two ways:
 *
 *  - a `cursor` this client holds — one click fetches a real page;
 *  - no cursor, and either the server reports earlier messages or history is
 *    not yet proven complete — the click bootstraps a joined snapshot to mint
 *    a cursor, then pages.
 *
 * Driving the button from the server's live-tail boundary alone put an inert
 * action back on screen after every poll: the server keeps reporting that
 * messages exist before the live tail long after this client has paged back to
 * the start of the conversation. `boundaryCursor` without `cursor` is exactly
 * that walked-past state, which is why it suppresses the bootstrap rather than
 * enabling it.
 *
 * An incomplete window without a cursor is only pageable while a joined
 * snapshot can still be attempted (`allowIncompleteBootstrap`). After that
 * attempt yields no cursor — or the client budget / message ceiling is
 * exhausted — the control is retired rather than left as a repeatable no-op.
 * A byte-capped tail still keeps its window so the 16 MiB notice can render.
 */
function historyMessageWindow(params: {
  messageCount: number;
  /** The cursor this client holds, if paging has one left to spend. */
  cursor?: string;
  /** The newest server-minted boundary this client has already resolved. */
  boundaryCursor?: string;
  /** Whether the server reports messages before the live tail. */
  serverCanLoadEarlier?: boolean;
  /** Server-reported completeness of the backend's own history. */
  complete: boolean;
  /** The server's own window, kept when nothing can be fetched. */
  serverWindow?: NativeAgentMessageWindow;
  /**
   * Progressive path only: offer the control so a click can mint a cursor
   * through a joined snapshot. Sync-v1 materialization omits this because it
   * already answered that question.
   */
  allowIncompleteBootstrap?: boolean;
  /** A prior bootstrap (or equivalent) already proved nothing more is fetchable. */
  unpageable?: boolean;
  /** Room remains in the client history budget for another page. */
  budgetAvailable?: boolean;
}): NativeAgentMessageWindow | undefined {
  const pageable =
    params.budgetAvailable !== false &&
    !params.unpageable &&
    params.messageCount < MAX_MESSAGE_WINDOW &&
    (Boolean(params.cursor) ||
      (params.serverCanLoadEarlier === true && !params.boundaryCursor) ||
      params.allowIncompleteBootstrap === true);
  const bytesNotice =
    params.serverWindow?.truncated === true && params.serverWindow.truncationReason === "bytes";
  const withServerFields = (canLoadEarlier: boolean): NativeAgentMessageWindow => ({
    ...(params.serverWindow ?? { limit: params.messageCount }),
    limit: params.messageCount,
    truncated: true,
    truncationReason: params.serverWindow?.truncationReason ?? "count",
    ...(params.serverWindow?.omittedMessages !== undefined
      ? { omittedMessages: params.serverWindow.omittedMessages }
      : {}),
    ...(params.serverWindow?.omittedParts !== undefined
      ? { omittedParts: params.serverWindow.omittedParts }
      : {}),
    canLoadEarlier,
  });
  if (pageable) return withServerFields(true);
  if (params.complete || params.unpageable) {
    return bytesNotice ? withServerFields(false) : undefined;
  }
  return params.serverWindow?.truncated ? withServerFields(false) : undefined;
}

/** A backend that turned out not to have the command answers both parts `pending`. */
async function readLiveUpdate<TMessage>(
  scope: NodeScope,
  send: <T>(command: string, input: object, run: () => Promise<T>) => Promise<T>,
  input: Parameters<typeof getNativeAgentLiveUpdate>[0],
): Promise<NativeAgentLiveUpdate<TMessage>> {
  try {
    return await send("live-update", input, () =>
      backendForScope(scope).getNativeAgentLiveUpdate<TMessage>(input),
    );
  } catch (error) {
    const invalidResponse =
      error instanceof Error &&
      (error.message === "Native agent live update response exceeded 20 MiB" ||
        error.message === "Invalid native agent live update response");
    if (
      !invalidResponse &&
      incompatibility(error, "get_native_agent_live_update")?.code !== "unknown-command"
    )
      throw error;
    disableNativeLiveUpdate(scope);
    const pending = { viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION, status: "pending" } as const;
    return { viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION, transcript: pending, state: pending };
  }
}

/**
 * Command rows and their catalogue state for a rebuilt projection.
 *
 * Discovery is read in parallel with transcript and state, so its snapshot can
 * land before any projection exists to carry it; a later read then answers
 * `unchanged`. Falling back to the held discovery view (for the same identity
 * only) keeps that first snapshot instead of losing the menu until it changes.
 */
function retainedCommandFields(
  current: Pick<NativeAgentSessionProjection, "slashCommands" | "slashCommandCatalogue"> | null,
  discovery: NativeAgentDiscoveryView | undefined,
  identity: NativeAgentViewIdentity,
): Pick<NativeAgentSessionProjection, "slashCommands" | "slashCommandCatalogue"> {
  const section = sameProgressiveIdentity(discovery?.identity, identity)
    ? discovery?.sections.commands
    : undefined;
  const commands = current?.slashCommands ?? section?.value;
  const catalogue = current?.slashCommandCatalogue ?? section?.catalogue;
  return {
    ...(commands ? { slashCommands: commands } : {}),
    ...(catalogue ? { slashCommandCatalogue: catalogue } : {}),
  };
}

/**
 * Discovery's models section is the platform catalogue alone. The session's
 * composer can carry a row for its selected model that the catalogue lacks,
 * such as a Codex session-held model the login does not offer. Without that
 * row the picker would fall back to the first catalogue model, which is not
 * the one the next turn runs.
 */
function withRetainedSelectedModelRow(
  models: AgentModel[],
  composer: Pick<NativeAgentComposerState, "models" | "selectedModelId">,
): AgentModel[] {
  const selected = composer.selectedModelId;
  if (!selected || models.some((model) => model.id === selected)) return models;
  const row = composer.models.find((model) => model.id === selected);
  return row ? [...models, row] : models;
}

function sameProgressiveIdentity(
  left: NativeAgentViewIdentity | undefined,
  right: NativeAgentViewIdentity,
): boolean {
  return Boolean(
    left &&
    left.backendInstanceId === right.backendInstanceId &&
    left.environmentId === right.environmentId &&
    left.platform === right.platform &&
    left.logicalSessionKey === right.logicalSessionKey &&
    left.providerSessionId === right.providerSessionId &&
    left.sourceGeneration === right.sourceGeneration,
  );
}

/**
 * A transcript token is only meaningful when this tab still holds the body it
 * describes. A state-only placeholder with `messages: []` is not that body
 * unless the transcript surface itself already proved emptiness.
 */
function hasUsableTranscriptBody<TMessage>(
  projection: NativeAgentSessionProjection<TMessage> | null | undefined,
  availability: NativeAgentProgressiveCacheEntry["transcriptAvailability"],
): boolean {
  if (!projection) return false;
  if (availability === "empty") return true;
  return projection.messages.length > 0;
}

/**
 * Rebuild the live transcript view a remount needs to apply deltas.
 *
 * The shared store keeps the projection and the token separately. Without this,
 * a remount restores `knownToken` while `lastTranscriptViewRef` stays null and
 * the first delta is discarded.
 */
function restoreTranscriptViewFromProjection<TMessage>(
  identity: NativeAgentViewIdentity | undefined,
  projection: NativeAgentSessionProjection<TMessage> | null | undefined,
  historyEpoch: string | undefined,
  availability: NativeAgentProgressiveCacheEntry["transcriptAvailability"],
  metadata?: NativeAgentProgressiveCacheEntry["transcriptHistoryMetadata"],
): NativeAgentTranscriptView<TMessage> | null {
  if (!identity || !projection || !historyEpoch) return null;
  if (!hasUsableTranscriptBody(projection, availability)) return null;
  return {
    identity,
    freshness: availability === "empty" ? "empty" : "current",
    messages: projection.messages,
    ...(projection.messageWindow ? { messageWindow: projection.messageWindow } : {}),
    ...(projection.title ? { title: projection.title } : {}),
    historyEpoch,
    historyComplete: projection.messageWindow?.canLoadEarlier !== true,
    ...metadata,
  };
}

/** A merged sync transcript computed ahead of the fence that installs it. */
interface SyncMaterializationPlan<TMessage> {
  materialized: NativeAgentSessionProjection<TMessage>;
  live: NativeAgentSessionProjection<TMessage>;
  /** Absent when the live tail came from the progressive transcript. */
  token?: string;
  /** The backend paging epoch; absent until a sync-v1 surface minted one. */
  historyEpoch?: string;
  historyCursor?: string;
  /** Server-reported first message before the live tail, for recovery. */
  boundaryCursor?: string;
  historyComplete: boolean;
  historyMessages: TMessage[];
  historyBytes: number;
  evictionGeneration: number;
}

/**
 * Forget the negotiated backend capability (the command scope's; see
 * `@/lib/native-agent-sync-capabilities`).
 *
 * The answer is cached for the life of the scope because it changes only
 * when the backend itself is replaced, and `onResourceResync` already
 * announces that. Tests are the one caller that swaps backends without an
 * announcement: a suite that advertises a different capability set has to say
 * so, or it inherits — and leaves behind — a protocol its own mocks do not
 * serve.
 */
export function resetNativeAgentSyncCapabilityForTests(): void {
  invalidateNativeAgentSyncCapability();
}

interface UseNativeAgentSessionOptions {
  platform: AgentPlatform;
  environmentId: string;
  tabId: string;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  defaultAgentModel?: string;
  defaultReasoningEffort?: string;
  initialProviderSessionId?: string;
  requireExistingResumeSession?: boolean;
  onResumeSessionReplaced?: (replacement: {
    requestedProviderSessionId: string;
    replacementProviderSessionId: string;
    logicalSessionKey: string;
  }) => Promise<void>;
  /**
   * Called when the backend created this tab's session on another model
   * because the configured one is unavailable (an OpenCode provider this login
   * has not connected). The configuration itself is unchanged.
   */
  onModelSubstituted?: (substitution: NativeAgentModelSubstitution) => void;
  initialConversationMode?: "build" | "plan";
  initialFastMode?: boolean;
  initialExecutionProfileId?: string;
  defaultFastMode?: boolean;
  /** Generic provider parameters applied only when a fresh session is created. */
  defaultParameterValues?: Record<string, string | boolean>;
  isActive?: boolean;
  /** Setup-gated tabs mount presentation without starting provider I/O. */
  enabled?: boolean;
  /**
   * The owner holds new turns: reads continue, but nothing establishes a
   * session. Adopting or ensuring one resolves a provider, which starts its
   * bridge. Reads answer from saved data while the backend holds the session.
   */
  sendingHeld?: boolean;
}

export interface NativeAgentSendOptions {
  requestId?: string;
  model?: string;
  reasoningEffort?: string;
  mode?: "build" | "plan";
  fastMode?: boolean;
  subAgent?: string;
  executionAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
  attachments?: Array<{
    type: "image" | "file";
    path: string;
    dataUrl?: string;
    filename?: string;
  }>;
  /** Command intent; absent keeps the legacy (typed) interpretation. */
  command?: NativeAgentCommandIntent;
}

/**
 * Whether adopting a session failed because the provider proved it no longer
 * exists, the one answer that may replace it. A backend that sends the code
 * (`native-agent-provider-session-missing`, over the gateway as `code` and
 * over Electron IPC as the message prefix) is read by the code alone; an older
 * backend, which sends no code, by its message's words.
 */
export function isProviderSessionMissingError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined) return code === "native-agent-provider-session-missing";
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("provider session was not found");
}

/**
 * Prompt text as it should travel.
 *
 * An ordinary prompt is trimmed as it always was. A command keeps its bytes —
 * trailing spaces, tabs and newlines in its arguments included — with only
 * leading whitespace removed, which is also all the backend trims.
 */
export function nativeSubmissionText(prompt: string, command?: NativeAgentCommandIntent): string {
  return command && command.kind !== "literal" ? prompt.replace(/^\s+/, "") : prompt.trim();
}

/**
 * The session's sync and progressive cache entries, read without subscribing.
 * They only seed the state and refs of `useNativeAgentSession` when it first
 * runs, and a change of session resets from `getState()`. Subscribing would
 * re-render the whole tab for every token that hook writes back, with nothing
 * new to show.
 */
function useSessionCacheSeeds(store: StoreApi<NativeAgentProjectionState>, sessionKey: string) {
  const { syncCaches, progressiveCaches } = store.getState();
  return {
    sharedSyncCache: syncCaches.get(sessionKey),
    sharedProgressiveCache: progressiveCaches.get(sessionKey),
  };
}

/**
 * The shared native-agent lifecycle controller.
 *
 * Long-running authority stays in the backend. This hook only installs full
 * authoritative snapshots, treats resource events as invalidation hints, and
 * keeps transient button state local.
 */
export function useNativeAgentSession<TMessage = unknown>({
  platform,
  environmentId,
  tabId,
  initialAgentModel,
  initialReasoningEffort,
  defaultAgentModel,
  defaultReasoningEffort,
  initialProviderSessionId,
  requireExistingResumeSession = false,
  onResumeSessionReplaced,
  onModelSubstituted,
  initialConversationMode,
  initialFastMode,
  initialExecutionProfileId,
  defaultFastMode,
  defaultParameterValues,
  isActive = true,
  enabled = true,
  sendingHeld = false,
}: UseNativeAgentSessionOptions) {
  const sessionKey = useMemo(() => createSessionKey(environmentId, tabId), [environmentId, tabId]);
  /*
   * The node this tab's session lives on: the nearest node scope (the app's
   * command scope outside a provider). Its projection store, capability
   * answers, shared reads, observation listener, change feed and read
   * coordinator are that node's, and its retained history reserves from the
   * window's shared transcripts budget under that node.
   */
  const scope = useNodeScope();
  const projectionStore = scope.store(nativeAgentProjectionStore);
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
    mode: initialConversationMode,
    fastMode: initialFastMode,
    executionProfileId: initialExecutionProfileId,
  });
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(
      initialAgentModel ||
      initialReasoningEffort ||
      initialConversationMode ||
      typeof initialFastMode === "boolean" ||
      initialExecutionProfileId,
    ),
  );
  const isInitializedRef = useRef(false);
  const lastInitTimeRef = useRef(0);
  const forkInFlightRef = useRef(false);
  const [runtimeProjection, setRuntimeProjection] =
    useState<NativeAgentSessionProjection<TMessage> | null>(null);
  const sharedProjection = useNativeAgentProjectionStore((state) =>
    state.projections.get(sessionKey),
  ) as NativeAgentSessionProjection<TMessage> | undefined;
  const { sharedSyncCache, sharedProgressiveCache } = useSessionCacheSeeds(
    projectionStore,
    sessionKey,
  );
  const matchingSharedProjection =
    sharedProjection?.platform === platform &&
    sharedProjection.environmentId === environmentId &&
    (!initialProviderSessionId || sharedProjection.sessionId === initialProviderSessionId)
      ? sharedProjection
      : undefined;
  const matchingProgressiveCache =
    sharedProgressiveCache?.identity?.environmentId === environmentId &&
    sharedProgressiveCache.identity.platform === platform &&
    sharedProgressiveCache.identity.logicalSessionKey === sessionKey &&
    (!initialProviderSessionId ||
      sharedProgressiveCache.identity.providerSessionId === initialProviderSessionId)
      ? sharedProgressiveCache
      : undefined;
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [resumeSessionReplacement, setResumeSessionReplacement] = useState<{
    requestedProviderSessionId: string;
    replacementProviderSessionId: string;
  } | null>(null);
  const [isRefreshing, setIsRefreshingState] = useState(enabled);
  /*
   * Mirrors of the two in-flight flags, so a setter that would not change the
   * value schedules no render. Background reads settle several times a second
   * during a turn; each redundant flag write used to cost the whole tab a
   * render.
   */
  const isRefreshingRef = useRef(enabled);
  const setIsRefreshing = useCallback((value: boolean) => {
    if (isRefreshingRef.current === value) return;
    isRefreshingRef.current = value;
    setIsRefreshingState(value);
  }, []);
  /**
   * Whether an authoritative read has finished for the current identity.
   *
   * A projection-less session is ambiguous on its own: an inactive tab has
   * simply never asked, while an active tab whose read came back empty has been
   * told there is nothing there. Only the second is a failure the user can act
   * on, so the connection surface needs to tell them apart rather than treating
   * every absent projection the same way.
   */
  const [hasCompletedRead, setHasCompletedRead] = useState(false);
  const [transcriptAvailability, setTranscriptAvailability] = useState<
    NativeAgentProgressiveCacheEntry["transcriptAvailability"]
  >(
    // Emptiness has to come from the transcript surface, not from an empty
    // message array. A session-state snapshot installs a projection with
    // `messages: []` before its paired transcript read resolves, so counting
    // messages would call a state-only placeholder an authoritative empty
    // transcript and suppress the shimmer for a session that still has history.
    matchingSharedProjection
      ? matchingProgressiveCache?.transcriptAvailability === "empty"
        ? "empty"
        : "cached"
      : "unavailable",
  );
  const transcriptAvailabilityRef = useRef(transcriptAvailability);
  const markTranscriptAvailability = useCallback(
    (availability: NativeAgentProgressiveCacheEntry["transcriptAvailability"]) => {
      transcriptAvailabilityRef.current = availability;
      setTranscriptAvailability(availability);
    },
    [],
  );
  const [transcriptRefreshing, setTranscriptRefreshing] = useState(enabled);
  const [transcriptError, setTranscriptError] = useState<string | null>(
    matchingProgressiveCache?.transcriptError ?? null,
  );
  /*
   * Action authority is only ever granted by a live session-state read, so a
   * remount starts unavailable even when the shared cache still holds the
   * previous mount's snapshot. The cached *transcript* is readable regardless;
   * that separation is the point of the progressive view.
   */
  const [sessionStateAvailability, setSessionStateAvailability] =
    useState<NativeAgentProgressiveCacheEntry["stateAvailability"]>("unavailable");
  const [sessionStateRefreshing, setSessionStateRefreshingState] = useState(false);
  const sessionStateRefreshingRef = useRef(false);
  const setSessionStateRefreshing = useCallback((value: boolean) => {
    if (sessionStateRefreshingRef.current === value) return;
    sessionStateRefreshingRef.current = value;
    setSessionStateRefreshingState(value);
  }, []);
  const [sessionStateError, setSessionStateError] = useState<string | null>(
    matchingProgressiveCache?.stateError ?? null,
  );
  const sessionStateAvailabilityRef = useRef(sessionStateAvailability);
  const markSessionStateAvailability = useCallback(
    (availability: NativeAgentProgressiveCacheEntry["stateAvailability"]) => {
      sessionStateAvailabilityRef.current = availability;
      setSessionStateAvailability(availability);
    },
    [],
  );
  /**
   * Begin a state read without surrendering authority.
   *
   * A refresh is not evidence that the last known state became wrong: the
   * session is still whatever the previous authoritative read said until a new
   * one contradicts it. Dropping to `refreshing` while a snapshot is already
   * held would blank pending approvals and lock the composer on every poll —
   * once every 500 ms during an active turn. Only a tab that has never had an
   * authoritative read shows `refreshing`, which is the genuine first-load
   * case the connecting state exists for.
   */
  const beginSessionStateRefresh = useCallback(
    (options?: { quiet?: boolean }) => {
      if (!options?.quiet) setSessionStateRefreshing(true);
      if (sessionStateAvailabilityRef.current !== "current") {
        markSessionStateAvailability("refreshing");
      }
      return sessionStateAvailabilityRef.current;
    },
    [markSessionStateAvailability, setSessionStateRefreshing],
  );
  const [isDispatching, setIsDispatching] = useState(false);
  /**
   * How much transcript this tab has asked for. Undefined keeps the backend
   * default; `loadEarlierMessages` raises it, and the raised value is resent on
   * every subsequent read so the window cannot silently collapse.
   */
  /** Moves whenever held history is owed a re-read; see `reconcileHeldHistory`. */
  const [heldHistoryReconcileSignal, setHeldHistoryReconcileSignal] = useState(0);
  // Seed the imperative view from the shared renderer cache. Environment
  // switches unmount this hook, but the cache survives; using it here lets the
  // remount start its authoritative transcript read immediately instead of
  // waiting for a redundant provider-adoption probe first.
  const projectionRef = useRef<NativeAgentSessionProjection<TMessage> | null>(
    matchingSharedProjection ?? null,
  );
  const syncTokenRef = useRef<string | undefined>(sharedSyncCache?.token);
  const duplicatePageSkipsRef = useRef(0);
  const matchingTranscriptView = restoreTranscriptViewFromProjection(
    matchingProgressiveCache?.identity,
    matchingSharedProjection,
    matchingProgressiveCache?.transcriptHistoryEpoch,
    matchingProgressiveCache?.transcriptAvailability ?? "unavailable",
    matchingProgressiveCache?.transcriptHistoryMetadata,
  );
  const progressiveTranscriptTokenRef = useRef(
    matchingTranscriptView ? matchingProgressiveCache?.transcriptToken : undefined,
  );
  const lastTranscriptViewRef = useRef<NativeAgentTranscriptView<TMessage> | null>(
    matchingTranscriptView,
  );
  /**
   * The history epoch of the last transcript view this session installed,
   * including the one a previous mount installed.
   *
   * `lastTranscriptViewRef` is restored from the cached projection on remount
   * when a matching transcript body is present, so a remounted tab can apply
   * deltas instead of discarding them. The epoch is still cached separately
   * because a rotation must be compared against the messages the store is
   * holding, not only the view this mount has rebuilt.
   */
  const progressiveHistoryEpochRef = useRef<string | undefined>(
    matchingProgressiveCache?.transcriptHistoryEpoch,
  );
  /**
   * The store-side history eviction counter the progressive path has honoured.
   *
   * Kept separate from `historyEvictionRef`: that one is committed by sync
   * materialization, and one transport acknowledging an eviction must not
   * silence it for the other.
   */
  const progressiveHistoryEvictionRef = useRef(
    projectionStore.getState().historyEvictions.get(sessionKey) ?? 0,
  );
  /** Never seeded from the shared cache; see the remount reset below. */
  const progressiveStateTokenRef = useRef<string | undefined>(undefined);
  const progressiveDiscoveryTokenRef = useRef(matchingProgressiveCache?.discoveryToken);
  const progressiveIdentityRef = useRef<NativeAgentViewIdentity | undefined>(
    matchingProgressiveCache?.identity,
  );
  const progressiveDiscoveryRef = useRef<NativeAgentDiscoveryView | undefined>(
    matchingProgressiveCache?.discovery,
  );
  const [discoverySchedule] = useState(() => new NativeDiscoveryReadSchedule());
  const syncLiveProjectionRef = useRef<NativeAgentSessionProjection<TMessage> | null>(
    (sharedSyncCache?.liveProjection as NativeAgentSessionProjection<TMessage> | undefined) ?? null,
  );
  const historyEpochRef = useRef<string | undefined>(sharedSyncCache?.historyEpoch);
  const historyCursorRef = useRef<string | undefined>(sharedSyncCache?.historyCursor);
  /**
   * The newest server-reported boundary between retained history and the live
   * tail. Every recovery path — a rotated epoch, a store eviction, a collapse
   * back to the bounded live view — restarts paging from here, so it must
   * survive a page load that reports only its own older cursor.
   */
  const historyBoundaryCursorRef = useRef<string | undefined>(
    sharedSyncCache?.historyBoundaryCursor,
  );
  const historyCompleteRef = useRef(sharedSyncCache?.historyComplete ?? false);
  /**
   * Whether one click could still mint a paging cursor this tab does not hold.
   *
   * Only the progressive transport reaches that state: its transcript reports
   * that earlier messages exist while the backend's paging cache — populated
   * by a different surface entirely — has never been read for this session.
   * Recorded here because a mutation answers on the legacy projection surface,
   * which knows none of this and would otherwise drop the control until the
   * next poll rebuilt it.
   */
  const historyBootstrapRef = useRef(sharedSyncCache?.historyBootstrap === true);
  const historyUnpageableRef = useRef(sharedSyncCache?.historyUnpageable === true);
  /** Rows before the live tail may be out of date until a re-read settles. */
  const heldHistoryReconcileOwedRef = useRef(false);
  const heldHistoryReconcileRunRef = useRef<object | null>(null);
  const heldHistoryReconcileStartedAtRef = useRef(0);
  const historyMessagesRef = useRef<TMessage[]>(
    (sharedSyncCache?.historyMessages as TMessage[] | undefined) ?? [],
  );
  /**
   * The store-side history eviction counter this hook has already honoured.
   *
   * The store can only evict its own copy of a retained page; the mounted hook
   * holds the same messages in `historyMessagesRef` and would write them
   * straight back on its next materialization. Observing the counter is what
   * makes a global eviction actually reclaim the bytes.
   */
  const historyEvictionRef = useRef(
    projectionStore.getState().historyEvictions.get(sessionKey) ?? 0,
  );
  const refreshSequenceRef = useRef(0);
  /** The newest history page request; an older one in flight is superseded. */
  const historyPageSequenceRef = useRef(0);
  const projectionOperationEpochRef = useRef(0);
  const refreshesInFlightRef = useRef(0);
  const reconcileAfterInFlightRef = useRef(false);
  /**
   * How many `connect()` calls are still establishing this tab's provider
   * session — that is, still inside `adopt`/`ensure`.
   *
   * A read taken inside that window is not authoritative. The backend resolves
   * a logical session key to a provider session, and until the adopt or ensure
   * that creates the mapping returns there is nothing to resolve, so the read
   * answers `null`. That is "not created yet", not "this session is gone", and
   * the two are indistinguishable at the call site. Spawning a fresh agent is
   * slow enough — seconds, for a cold ACP bridge — that ordinary background
   * refreshes land squarely in the middle of it, and one of them settling the
   * connection surface is what flashes Connection Failed on a tab that goes on
   * to connect perfectly well.
   */
  const establishingSessionRef = useRef(0);
  /**
   * Whether the last `connect()` failed to establish a session and its error is
   * still the truest thing known about this tab.
   *
   * A failed adopt/ensure leaves no provider mapping behind, so every read that
   * follows resolves to `null` — and a read that installs `null` normally clears
   * `runtimeError`, because an authoritative "no session" is not an error state.
   * That combination replaces a message the user can act on ("provider session
   * was not found", an auth failure, a bridge that would not spawn) with the
   * generic connection-failed surface, within one poll interval. The flag keeps
   * the establishment error until a read actually finds a session or a fresh
   * connect supersedes it.
   */
  const establishmentFailureRef = useRef(false);
  const backgroundRefreshEnabledRef = useRef(enabled && isActive);
  // Published at commit, before the effects that schedule background reads.
  useLayoutEffect(() => {
    backgroundRefreshEnabledRef.current = enabled && isActive;
  }, [enabled, isActive]);
  const refreshRef =
    useRef<
      (options?: {
        manual?: boolean;
        reconcileAfterInFlight?: boolean;
        round?: NativeSessionReadRound;
      }) => Promise<NativeAgentSessionProjection<TMessage> | null>
    >(null);
  /** Background-read invalidation, owned by the read coordinator below. */
  const coordinatedInvalidateRef = useRef<() => void>(() => {});
  const pendingDispatchRef = useRef<{
    prompt: string;
    requestId: string;
  } | null>(null);
  const effectiveProjection = matchingSharedProjection ?? runtimeProjection;
  const clearTabInitialAgentOptions = usePaneLayoutStore(
    (state) => state.clearTabInitialAgentOptions,
  );
  const updateTabNativeSessionId = usePaneLayoutStore((state) => state.updateTabNativeSessionId);
  const acknowledgeInitialLaunchOptions = useCallback(() => {
    if (!initialLaunchOptionsPendingRef.current) return;
    initialLaunchOptionsPendingRef.current = false;
    clearTabInitialAgentOptions(tabId, environmentId);
  }, [clearTabInitialAgentOptions, environmentId, tabId]);

  const identity = useMemo(
    () => ({ environmentId, agent: platform, logicalSessionKey: sessionKey }),
    [environmentId, platform, sessionKey],
  );

  const beginProjectionMutation = useCallback(() => {
    projectionOperationEpochRef.current += 1;
    refreshSequenceRef.current += 1;
    progressiveStateTokenRef.current = undefined;
    // The token is dropped so the next read returns a full snapshot, but the
    // state already on screen stays authoritative until that snapshot lands.
    beginSessionStateRefresh();
    return projectionOperationEpochRef.current;
  }, [beginSessionStateRefresh]);

  const applyProjection = useCallback(
    (
      next: NativeAgentSessionProjection<TMessage> | null,
      syncCache?: NativeAgentSyncCacheEntry | null,
    ) => {
      if (!next) {
        projectionRef.current = null;
        setRuntimeProjection(null);
        projectionStore.getState().setProjection(sessionKey, null, null);
        return;
      }
      const current = projectionRef.current;
      if (current && current.generation === next.generation && next.revision < current.revision)
        return;
      next = withEffectiveLoadEarlier(next);
      projectionRef.current = next;
      const stopMarker = projectionStore.getState().turnStopMarkers.get(sessionKey);
      if (stopMarker && stopMarker.sessionId !== next.sessionId) {
        projectionStore.getState().clearTurnStopped(sessionKey);
      }
      setRuntimeProjection(next);
      projectionStore
        .getState()
        .setProjection(sessionKey, next as NativeAgentSessionProjection, syncCache);
      if (next.sessionId) {
        updateTabNativeSessionId(tabId, next.sessionId, environmentId);
      }
    },
    [environmentId, sessionKey, tabId, updateTabNativeSessionId, projectionStore],
  );

  /**
   * Room left for history this tab has not fetched yet.
   *
   * Used to size the page request itself, so the server trims rather than the
   * client: a page the client has to trim on arrival leaves its older half
   * behind a cursor only the server can mint.
   */
  const historyRequestBudget = useCallback((): { messages: number; bytes: number } => {
    const otherHistoryBytes = nativeAgentHistoryBytesExcept(sessionKey, scope);
    const byteCeiling = Math.min(
      CLIENT_HISTORY_MAX_BYTES,
      Math.max(0, nativeAgentHistoryBudgetBytes(scope) - otherHistoryBytes),
    );
    const liveMessages = syncLiveProjectionRef.current?.messages.length ?? 0;
    return {
      messages: Math.max(
        0,
        CLIENT_HISTORY_MAX_MESSAGES - liveMessages - historyMessagesRef.current.length,
      ),
      // Summed from cached per-message sizes; the retained pages were measured
      // when they arrived and are not serialized again here.
      bytes: Math.max(0, byteCeiling - retainedHistoryBytes(historyMessagesRef.current)),
    };
  }, [sessionKey, scope]);

  /**
   * Compute — but do not install — the merged transcript one sync update
   * implies.
   *
   * Every ref this reads is left untouched. A read that started before a
   * mutation has to be discarded whole, and a materializer that mutated state
   * on the way to producing its answer would already have clobbered the newer
   * authoritative projection by the time the caller's fence noticed. The
   * caller commits the plan only once it has confirmed the read is still the
   * newest one for this identity.
   */
  const planSyncMaterialization = useCallback(
    (params: {
      live: NativeAgentSessionProjection<TMessage>;
      token?: string;
      historyEpoch?: string;
      /** Server-reported completeness of the backend's own history. */
      historyComplete: boolean;
      /**
       * The live tail's own boundary, as this update reported it. Present only
       * when the update actually carried one; paging omits it so the last
       * reported boundary survives, which is the cursor every recovery path
       * below has to fall back to.
       */
      boundary?: { cursor?: string };
      deletedMessageIds?: readonly string[];
      /** Explicit retained state, used by paging instead of the current refs. */
      retained?: { messages: TMessage[]; cursor?: string; complete: boolean };
    }): SyncMaterializationPlan<TMessage> => {
      const { live, token, historyEpoch, historyComplete } = params;
      const boundaryCursor = params.boundary
        ? params.boundary.cursor
        : historyBoundaryCursorRef.current;
      const store = projectionStore.getState();
      const evictionGeneration = store.historyEvictions.get(sessionKey) ?? 0;
      const evicted = evictionGeneration !== historyEvictionRef.current;
      const previousLive = syncLiveProjectionRef.current;
      const historyEpochChanged = historyEpochRef.current !== historyEpoch;
      const messageId = (message: TMessage): unknown => (message as { id?: unknown })?.id;

      let retainedMessages: TMessage[];
      let retainedCursor: string | undefined;
      let mergeAgedOut = false;
      if (params.retained) {
        retainedMessages = [...params.retained.messages];
        retainedCursor = params.retained.cursor;
      } else if (historyEpochChanged || evicted) {
        // A rotated history or a global eviction invalidates every retained
        // page. The server's own first cursor makes the same range fetchable
        // again rather than stranding it.
        retainedMessages = [];
        retainedCursor = boundaryCursor;
      } else {
        retainedMessages = historyMessagesRef.current;
        if (params.deletedMessageIds?.length) {
          const deleted = new Set(params.deletedMessageIds);
          retainedMessages = retainedMessages.filter(
            (message) => !deleted.has(messageId(message) as string),
          );
        }
        if (retainedMessages.length === 0) {
          // With no retained pages, follow the moving live boundary. Once pages
          // exist their cursor is older and remains valid across append-only
          // updates, so it must not be replaced by this first-page cursor.
          retainedCursor = boundaryCursor;
        } else {
          retainedCursor = historyCursorRef.current;
          mergeAgedOut = true;
        }
      }
      /*
       * Completeness describes the backend's history for this session, not how
       * far this client has paged, so the authoritative value always wins.
       * Accumulating it with AND made `false` absorbing: one transient
       * incomplete read left the transcript permanently marked truncated even
       * after a later snapshot proved otherwise.
       */
      const retainedComplete =
        params.retained && !historyEpochChanged ? params.retained.complete : historyComplete;

      const liveIds = new Set(
        live.messages
          .map((message) => messageId(message))
          .filter((id): id is string => typeof id === "string"),
      );
      const displayed = projectionRef.current;
      // A progressive transcript has no sync paging epoch yet. The first
      // joined snapshot establishes one, but its bounded tail must not erase
      // the older messages this tab already rendered in the same session.
      if (
        historyEpochChanged &&
        historyEpochRef.current === undefined &&
        !evicted &&
        !params.retained &&
        displayed !== null &&
        displayed.sessionId === live.sessionId &&
        displayed.generation === live.generation
      ) {
        const firstLiveId = messageId(live.messages[0] as TMessage);
        const firstLiveIndex = displayed.messages.findIndex(
          (message) => messageId(message) === firstLiveId,
        );
        if (firstLiveIndex > 0) {
          retainedMessages = displayed.messages.slice(0, firstLiveIndex);
        }
      }
      if (mergeAgedOut && previousLive) {
        const retainedIds = new Set(retainedMessages.map((message) => messageId(message)));
        const agedOut = previousLive.messages
          .filter((message) => {
            const id = messageId(message);
            return typeof id === "string" && !liveIds.has(id) && !retainedIds.has(id);
          })
          .map(
            (message) =>
              displayed?.messages.find(
                (candidate) => messageId(candidate) === messageId(message),
              ) ?? message,
          );
        if (agedOut.length > 0) retainedMessages = [...retainedMessages, ...agedOut];
      }
      retainedMessages = retainedMessages.filter(
        (message) => !liveIds.has(messageId(message) as string),
      );

      const headMerge = preferCompleteLiveHead(
        projectionRef.current?.messages ?? previousLive?.messages,
        live.messages,
        live.messageWindow?.omittedParts,
      );
      const displayLive = headMerge.messages;
      const omittedParts = live.messageWindow?.omittedParts ?? 0;
      /*
       * A part-trimmed live head sits at the start of the overlapping row. If
       * this client has no fuller copy, stitching retained pages in front of it
       * opens a hole in the middle of the timeline. Collapse to the contiguous
       * tail instead; an explicit page (`params.retained`) still wins because
       * the user asked to see that range.
       */
      if (omittedParts > 0 && !headMerge.restoredPrefix && !params.retained) {
        retainedMessages = [];
        retainedCursor = boundaryCursor;
      }

      const otherHistoryBytes = nativeAgentHistoryBytesExcept(sessionKey, scope);
      const historyTotalMaxBytes = nativeAgentHistoryBudgetBytes(scope);
      let historyBytes = retainedHistoryBytes(retainedMessages);
      let settledCursor = retainedCursor;
      if (
        retainedMessages.length + displayLive.length > CLIENT_HISTORY_MAX_MESSAGES ||
        historyBytes > CLIENT_HISTORY_MAX_BYTES ||
        historyBytes + otherHistoryBytes > historyTotalMaxBytes
      ) {
        // Eviction is an explicit collapse back to the bounded live view. The
        // server-supplied first cursor lets the same history be fetched again.
        retainedMessages = [];
        historyBytes = 0;
        settledCursor = boundaryCursor;
      }

      const seen = new Set<string>();
      const messages = [...retainedMessages, ...displayLive].filter((message) => {
        const id = messageId(message);
        if (typeof id !== "string" || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      /*
       * No bootstrap term here on purpose. A sync-v1 read always mints its own
       * boundary cursor when earlier messages exist, so an incomplete window
       * without a cursor is not a reason to offer the control — the joined
       * snapshot already answered that question. Offering it here would put
       * an inert action back on screen after every poll.
       */
      const messageWindow = historyMessageWindow({
        messageCount: messages.length,
        ...(settledCursor ? { cursor: settledCursor } : {}),
        ...(boundaryCursor ? { boundaryCursor } : {}),
        complete: retainedComplete,
        ...(historyUnpageableRef.current ? { unpageable: true } : {}),
        budgetAvailable:
          messages.length < CLIENT_HISTORY_MAX_MESSAGES &&
          historyBytes < CLIENT_HISTORY_MAX_BYTES &&
          historyBytes + otherHistoryBytes < historyTotalMaxBytes,
        ...(live.messageWindow ? { serverWindow: live.messageWindow } : {}),
      });
      return {
        materialized: {
          ...live,
          messages,
          ...(messageWindow ? { messageWindow } : { messageWindow: undefined }),
        },
        live,
        ...(token ? { token } : {}),
        ...(historyEpoch ? { historyEpoch } : {}),
        ...(settledCursor ? { historyCursor: settledCursor } : {}),
        ...(boundaryCursor ? { boundaryCursor } : {}),
        historyComplete: retainedComplete,
        historyMessages: retainedMessages,
        historyBytes,
        evictionGeneration,
      };
    },
    [sessionKey, scope, projectionStore],
  );

  /** Installs a plan. Callers must have fenced the read that produced it. */
  const commitSyncMaterialization = useCallback(
    (plan: SyncMaterializationPlan<TMessage>) => {
      const materialized: NativeAgentSessionProjection<TMessage> = {
        ...plan.materialized,
        revision: orderedRevision(projectionRef.current, plan.materialized),
      };
      historyEpochRef.current = plan.historyEpoch;
      historyCursorRef.current = plan.historyCursor;
      historyBoundaryCursorRef.current = plan.boundaryCursor;
      historyCompleteRef.current = plan.historyComplete;
      historyMessagesRef.current = plan.historyMessages;
      historyEvictionRef.current = plan.evictionGeneration;
      syncTokenRef.current = plan.token;
      syncLiveProjectionRef.current = plan.live;
      // A sync-v1 read answers the bootstrap question outright: it either
      // minted a cursor or proved there is nothing left to mint one for.
      historyBootstrapRef.current = false;
      applyProjection(materialized, {
        ...(plan.token ? { token: plan.token } : {}),
        liveProjection: plan.live as NativeAgentSessionProjection,
        ...(plan.historyEpoch ? { historyEpoch: plan.historyEpoch } : {}),
        ...(plan.historyCursor ? { historyCursor: plan.historyCursor } : {}),
        ...(plan.boundaryCursor ? { historyBoundaryCursor: plan.boundaryCursor } : {}),
        ...(historyUnpageableRef.current ? { historyUnpageable: true } : {}),
        historyComplete: plan.historyComplete,
        historyMessages: plan.historyMessages,
        historyBytes: plan.historyBytes,
      });
      return materialized;
    },
    [applyProjection],
  );

  /** The sync cache for a projection whose paging state did not move. */
  const heldHistorySyncCache = useCallback(
    (next: NativeAgentSessionProjection<TMessage>): NativeAgentSyncCacheEntry => ({
      ...(syncTokenRef.current ? { token: syncTokenRef.current } : {}),
      liveProjection: (syncLiveProjectionRef.current ?? next) as NativeAgentSessionProjection,
      ...(historyEpochRef.current ? { historyEpoch: historyEpochRef.current } : {}),
      ...(historyCursorRef.current ? { historyCursor: historyCursorRef.current } : {}),
      ...(historyBoundaryCursorRef.current
        ? { historyBoundaryCursor: historyBoundaryCursorRef.current }
        : {}),
      ...(historyUnpageableRef.current ? { historyUnpageable: true } : {}),
      historyComplete: historyCompleteRef.current,
      historyMessages: historyMessagesRef.current,
      historyBytes: retainedHistoryBytes(historyMessagesRef.current),
    }),
    [],
  );

  /**
   * Stop offering Load earlier after a click that cannot fetch.
   *
   * `sticky` is for a bootstrap (or equivalent) that already proved nothing
   * more is recoverable: later polls must not put the control back. Budget
   * and ceiling exhaustion are not sticky — another session's eviction can
   * free room, and the next materialization re-derives the flag.
   */
  const retireLoadEarlierControl = useCallback(
    (options?: { sticky?: boolean }) => {
      if (options?.sticky === true) {
        historyUnpageableRef.current = true;
        historyBootstrapRef.current = false;
        historyCompleteRef.current = true;
      }
      const current = projectionRef.current;
      if (current?.messageWindow?.canLoadEarlier !== true) return current;
      const next = {
        ...current,
        messageWindow: { ...current.messageWindow, canLoadEarlier: false },
        revision: current.revision + 1,
      };
      applyProjection(next, heldHistorySyncCache(next));
      return next;
    },
    [applyProjection, heldHistorySyncCache],
  );

  /** Forgets every sync-v1 assumption, so the next read starts from a snapshot. */
  const resetSyncState = useCallback(() => {
    syncTokenRef.current = undefined;
    syncLiveProjectionRef.current = null;
    historyMessagesRef.current = [];
    historyCursorRef.current = undefined;
    historyBoundaryCursorRef.current = undefined;
    historyEpochRef.current = undefined;
    historyCompleteRef.current = false;
    historyBootstrapRef.current = false;
    historyUnpageableRef.current = false;
  }, []);

  const updateProgressiveCache = useCallback(
    (patch: Partial<NativeAgentProgressiveCacheEntry>) => {
      const store = projectionStore.getState();
      const previous = store.progressiveCaches.get(sessionKey);
      store.setProgressiveCache(sessionKey, {
        transcriptAvailability: previous?.transcriptAvailability ?? "unavailable",
        transcriptRefreshing: previous?.transcriptRefreshing ?? false,
        stateAvailability: previous?.stateAvailability ?? "unavailable",
        ...previous,
        ...patch,
        // Every response parses a fresh identity. Keep the object an equal one
        // already holds so an unchanged poll does not look like a change.
        ...(patch.identity && sameProgressiveIdentity(previous?.identity, patch.identity)
          ? { identity: previous?.identity }
          : {}),
      });
    },
    [sessionKey, projectionStore],
  );

  /**
   * The provider session `connect` created because the tab's own was gone
   * (adoption answered "missing"). Its views belong to this tab although the
   * tab still names the missing session; installing the first one moves the
   * tab onto it (`applyProjection`), after which the tab names it itself.
   */
  const replacedProviderSessionRef = useRef<{ requested: string; replacement: string } | null>(
    null,
  );
  const identityBelongsToView = useCallback(
    (candidate: NativeAgentViewIdentity): boolean => {
      const replaced = replacedProviderSessionRef.current;
      const expected =
        replaced && replaced.requested === initialProviderSessionId
          ? replaced.replacement
          : initialProviderSessionId;
      return (
        candidate.environmentId === environmentId &&
        candidate.platform === platform &&
        candidate.logicalSessionKey === sessionKey &&
        (!expected || candidate.providerSessionId === expected)
      );
    },
    [environmentId, initialProviderSessionId, platform, sessionKey],
  );

  /** Install transcript content without inventing action authority. */
  const applyProgressiveTranscript = useCallback(
    (
      incoming: NativeAgentTranscriptView<TMessage>,
      token: string,
      delta?: {
        deletedMessageIds: readonly string[];
        /** Rows the delta upserted or patched; the rest of the view is held. */
        deliveredIds: ReadonlySet<string>;
      },
    ) => {
      if (!identityBelongsToView(incoming.identity)) return null;
      const deletedMessageIds = delta?.deletedMessageIds;
      const revised = revisedMessagesById(incoming.revisedMessages);
      /*
       * A snapshot's rows are all the server's tail. A delta's are only where
       * it upserted or patched: the rest is the view this tab held, which a
       * remount rebuilds from everything on screen, so it can still carry an
       * aged-out row the server has since revised.
       */
      const value =
        delta && revised
          ? {
              ...incoming,
              messages: withRevisedMessages(incoming.messages, revised, delta.deliveredIds),
            }
          : incoming;
      const identityChanged =
        progressiveIdentityRef.current !== undefined &&
        !sameProgressiveIdentity(progressiveIdentityRef.current, value.identity);
      const providerChanged =
        progressiveIdentityRef.current !== undefined &&
        progressiveIdentityRef.current.providerSessionId !== value.identity.providerSessionId;
      if (identityChanged) {
        progressiveStateTokenRef.current = undefined;
        progressiveDiscoveryTokenRef.current = undefined;
        progressiveDiscoveryRef.current = undefined;
        discoverySchedule.markDue();
        updateProgressiveCache({ discoveryToken: undefined, discovery: undefined });
        markSessionStateAvailability("unavailable");
        setSessionStateError(null);
      }
      const heldProjection = providerChanged ? null : projectionRef.current;
      const current =
        identityChanged && heldProjection
          ? {
              ...heldProjection,
              slashCommands: undefined,
              slashCommandCatalogue: undefined,
              runtime: undefined,
            }
          : heldProjection;
      const hasAuthoritativeState =
        !identityChanged && sessionStateAvailabilityRef.current === "current" && current !== null;
      /*
       * Progressive snapshots are the live tail (100 messages / 512 KiB), not
       * the whole conversation. Replacing the rendered list with that tail on
       * every poll — including the refresh that runs when a hidden tab becomes
       * active again — dropped every message that had aged out. Keep them unless
       * the session identity or history epoch actually rotated.
       *
       * An unknown previous epoch counts as a rotation. A mount that holds a
       * cached projection it cannot date has no way to tell aged-out messages
       * from a history the provider rewrote while nothing was watching, and
       * showing deleted messages is the worse of the two failures.
       */
      const previousEpoch =
        lastTranscriptViewRef.current?.historyEpoch ?? progressiveHistoryEpochRef.current;
      /*
       * A moved reconciliation token says a row before the tail changed and was
       * too large to travel with this view. The history itself still stands, so
       * with a direct cursor to re-read it from, the rows stay on screen until
       * the fresh copies replace them (`reconcileHeldHistory`). Dropping them
       * here instead collapsed the transcript on every change to such a row,
       * and a row holding running subagents changes with each tool they call.
       */
      const heldHistoryStale =
        heldHistoryReconcileOwedRef.current ||
        lastTranscriptViewRef.current?.historyReconciliationToken !==
          value.historyReconciliationToken;
      const historyEpochChanged =
        previousEpoch !== value.historyEpoch ||
        (heldHistoryStale && !(value.historyPaging === "direct" && value.historyCursor));
      const evictionGeneration = projectionStore.getState().historyEvictions.get(sessionKey) ?? 0;
      const evicted = evictionGeneration !== progressiveHistoryEvictionRef.current;
      const deleted = deletedMessageIds?.length ? new Set(deletedMessageIds) : undefined;
      const liveIds = new Set(
        value.messages
          .map((message) => (message as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const firstLiveId = value.messages.find(
        (message) => typeof (message as { id?: unknown })?.id === "string",
      ) as { id?: unknown } | undefined;
      const firstLiveIndex =
        current && typeof firstLiveId?.id === "string"
          ? current.messages.findIndex(
              (message) => (message as { id?: unknown })?.id === firstLiveId.id,
            )
          : -1;
      const headMerge = preferCompleteLiveHead(
        current?.messages,
        value.messages,
        value.messageWindow?.omittedParts,
      );
      const displayLive = headMerge.messages;
      const omittedParts = value.messageWindow?.omittedParts ?? 0;
      const partTruncatedHead =
        omittedParts > 0 ||
        headMerge.restoredPrefix ||
        (firstLiveIndex >= 0 &&
          current !== null &&
          messagePartCount(current.messages[firstLiveIndex]) > messagePartCount(value.messages[0]));
      /*
       * Ageing out is a suffix window: keep the prefix before the live tail.
       * A rewind or other prefix window starts at an earlier message we already
       * hold, so that prefix is empty and the omitted suffix must drop.
       *
       * A part-trimmed live head is different. The omitted content sits at the
       * start of the overlapping row, which becomes the middle of the stitched
       * timeline if we keep the prefix. Keep the prefix only when this client
       * already holds the fuller row; otherwise collapse to the contiguous tail.
       */
      const collapsedForPartTruncation =
        partTruncatedHead && !headMerge.restoredPrefix && firstLiveIndex > 0;
      let retained =
        current &&
        !identityChanged &&
        !historyEpochChanged &&
        !evicted &&
        firstLiveIndex > 0 &&
        !collapsedForPartTruncation
          ? current.messages.slice(0, firstLiveIndex).filter((message) => {
              const id = (message as { id?: unknown })?.id;
              if (typeof id !== "string") return true;
              // A delta deletes from the live tail it was diffed against, so an
              // id it removes never appears in `liveIds`. Without this the
              // retained prefix would reinstate exactly the messages the
              // provider just deleted.
              if (deleted?.has(id)) return false;
              return !liveIds.has(id);
            })
          : [];
      // Before the byte accounting below, so it measures the copies kept.
      retained = withRevisedMessages(retained, revised, liveIds);
      /*
       * Retention is a client-side buffer and gets the same explicit ceiling
       * sync materialization applies to its retained pages. Exceeding it
       * collapses back to the bounded live tail rather than growing an array
       * the shared store cannot evict — its trim loop refuses to drop the
       * session it is currently writing, so nothing else would reclaim this.
       */
      // The prefix is made of objects this renderer already holds, so their
      // sizes are cached; only the arriving live tail is ever serialized.
      let retainedBytes = retainedHistoryBytes(retained);
      const retentionCollapsed =
        retained.length > 0 &&
        (retained.length + displayLive.length > CLIENT_HISTORY_MAX_MESSAGES ||
          retainedBytes > CLIENT_HISTORY_MAX_BYTES);
      if (retentionCollapsed) {
        retained = [];
        retainedBytes = 0;
      }
      const heldHistoryReconcileOwed = heldHistoryStale && retained.length > 0;
      /*
       * The live tail no longer starts at any row this tab holds, so nothing
       * on screen can be stitched to it. A single oversized newest row does
       * this: while it streams it is the whole tail, and the next prompt
       * pushes it out of the byte window entirely. The rows on screen drop
       * with it, exactly as in the collapses above.
       */
      const tailJumpedPastHeld =
        current !== null &&
        current.messages.length > 0 &&
        typeof firstLiveId?.id === "string" &&
        firstLiveIndex < 0;
      const messages = [...retained, ...displayLive];
      const partOnlyTruncation =
        omittedParts > 0 &&
        (value.messageWindow?.omittedMessages ?? 0) === 0 &&
        value.messageWindow?.truncationReason === "bytes";
      const serverCanLoadEarlier =
        value.messageWindow?.canLoadEarlier === true && !partOnlyTruncation;
      /*
       * Whether the paging state this hook holds still describes this
       * transcript. Paging lives in the sync-v1 namespace — its cursors, its
       * epoch and its retained pages are all minted by the joined projection
       * and message-page endpoints — so the transcript view can only ever
       * invalidate that state, never re-derive it.
       *
       * In particular `value.historyEpoch` is the bridge's content epoch and
       * `historyEpochRef` is the backend's paging epoch. They are different
       * identifiers for different things and never compare equal, so comparing
       * them here would discard the cursor on every poll. The transcript's own
       * rotation is already covered by `historyEpochChanged`.
       */
      const pagingCarriesOver =
        !identityChanged &&
        !historyEpochChanged &&
        !evicted &&
        syncLiveProjectionRef.current !== null;
      /*
       * Rows this tab had on screen just dropped without the paging state
       * moving with them. Every cursor held from before was minted behind a
       * row that is now gone from the screen — the tail head it was issued
       * for, or the first page a walk already completed — so a click would
       * page past exactly the rows that dropped, and a walk that reached the
       * start would hide the control altogether. Neither describes what is
       * on screen now.
       */
      const prefixDropped = collapsedForPartTruncation || tailJumpedPastHeld;
      if (!pagingCarriesOver || prefixDropped) historyUnpageableRef.current = false;
      /*
       * A direct cursor pages this view's own epoch straight from the
       * provider, so it can seed paging without the joined snapshot that
       * otherwise has to mint one. Adopt it whenever this hook holds no
       * cursor of its own for the epoch, or retention just collapsed to the
       * live tail (an older cursor would skip the rows the collapse dropped).
       * Existing paging state otherwise wins: it already points further back.
       */
      const directHistoryCursor =
        value.historyPaging === "direct" ? value.historyCursor : undefined;
      const adoptDirectCursor =
        directHistoryCursor !== undefined &&
        (!pagingCarriesOver ||
          retentionCollapsed ||
          prefixDropped ||
          (!historyCursorRef.current && !historyBoundaryCursorRef.current));
      // Without a direct cursor the held ones are still stale: forget them so
      // a click bootstraps a boundary for the tail actually on screen.
      const discardHeldCursors = prefixDropped && !adoptDirectCursor;
      const historyBoundaryCursor = adoptDirectCursor
        ? directHistoryCursor
        : pagingCarriesOver && !discardHeldCursors
          ? historyBoundaryCursorRef.current
          : undefined;
      /*
       * A collapse discards retained pages, so the range they covered has to
       * become fetchable again. The boundary is the only cursor that still
       * describes it; the page cursor pointed further back than anything now
       * on screen.
       */
      const settledHistoryCursor = adoptDirectCursor
        ? directHistoryCursor
        : !pagingCarriesOver || discardHeldCursors
          ? undefined
          : retentionCollapsed
            ? historyBoundaryCursorRef.current
            : historyCursorRef.current;
      // A direct page answers with the view's own epoch, which is therefore
      // the paging epoch the page is checked against.
      const historyPagingEpoch = adoptDirectCursor
        ? value.historyEpoch
        : pagingCarriesOver
          ? historyEpochRef.current
          : undefined;
      /*
       * Completeness is about what this client can show, not about the window
       * the transcript happened to carry. A live tail reports itself truncated
       * for as long as messages have aged out of it, but a client that has
       * already paged those messages back in is showing the whole conversation
       * and must not keep a "not shown" banner on screen for it.
       *
       * Paging having reached the start is exactly "a boundary was resolved and
       * no cursor survived it", and only then does its completeness win.
       */
      const historyComplete = historyUnpageableRef.current
        ? true
        : pagingCarriesOver && historyBoundaryCursor && !settledHistoryCursor
          ? historyCompleteRef.current
          : value.historyComplete;
      /*
       * `historyComplete: false` can describe a short provider preview that is
       * still hydrating, not an older page. The backend distinguishes that case
       * with an explicit `canLoadEarlier: false`; overriding it mounts a
       * transient Virtuoso header that disappears with the hydrated snapshot
       * and shifts the whole transcript.
       *
       * A byte-capped incomplete tail is the exception: its live-window limit
       * cannot reveal the omitted whole messages, but a joined snapshot can
       * still mint the paging cursor that restores them. Part-only truncation
       * is not recoverable through history paging. An omitted flag remains
       * bootstrap-able for compatibility with older progressive responses.
       */
      const byteCappedMessagesOmitted =
        value.messageWindow?.truncationReason === "bytes" &&
        (value.messageWindow.omittedMessages ?? 0) > 0;
      const canBootstrapHistory =
        !historyUnpageableRef.current &&
        !historyBoundaryCursor &&
        !settledHistoryCursor &&
        (serverCanLoadEarlier ||
          (historyComplete === false &&
            (value.messageWindow?.canLoadEarlier !== false || byteCappedMessagesOmitted)));
      const budget = historyRequestBudget();
      const messageWindow = historyMessageWindow({
        messageCount: messages.length,
        ...(settledHistoryCursor ? { cursor: settledHistoryCursor } : {}),
        ...(historyBoundaryCursor ? { boundaryCursor: historyBoundaryCursor } : {}),
        serverCanLoadEarlier,
        complete: historyComplete,
        allowIncompleteBootstrap: canBootstrapHistory,
        ...(historyUnpageableRef.current ? { unpageable: true } : {}),
        budgetAvailable: budget.messages > 0 && budget.bytes > 0,
        ...(value.messageWindow ? { serverWindow: value.messageWindow } : {}),
      });
      const live: NativeAgentSessionProjection<TMessage> = {
        platform,
        environmentId,
        // An empty provider id is a session the first prompt has not created yet.
        ...(value.identity.providerSessionId
          ? { sessionId: value.identity.providerSessionId }
          : {}),
        ...(value.title || current?.title ? { title: value.title ?? current?.title } : {}),
        connection: hasAuthoritativeState ? current.connection : "connecting",
        turn: hasAuthoritativeState ? current.turn : { phase: "recovering" },
        messages: value.messages,
        ...(value.messageWindow ? { messageWindow: value.messageWindow } : {}),
        interactions: hasAuthoritativeState ? current.interactions : [],
        composerControls: hasAuthoritativeState ? current.composerControls : [],
        ...(hasAuthoritativeState && current.composer ? { composer: current.composer } : {}),
        ...(hasAuthoritativeState && current.readiness ? { readiness: current.readiness } : {}),
        capabilities: hasAuthoritativeState
          ? current.capabilities
          : nativeAgentCapabilities(platform),
        ...(hasAuthoritativeState && current.queue ? { queue: current.queue } : {}),
        ...(hasAuthoritativeState && current.asyncQuestionResponses
          ? { asyncQuestionResponses: current.asyncQuestionResponses }
          : {}),
        ...(hasAuthoritativeState && current.contextUsage
          ? { contextUsage: current.contextUsage }
          : {}),
        ...(hasAuthoritativeState && current.goal ? { goal: current.goal } : {}),
        ...(hasAuthoritativeState && current.policy ? { policy: current.policy } : {}),
        ...(hasAuthoritativeState && current.rateLimits ? { rateLimits: current.rateLimits } : {}),
        ...(current?.runtime ? { runtime: current.runtime } : {}),
        ...(current?.runtimeHealthAuthoritative === undefined
          ? {}
          : { runtimeHealthAuthoritative: current.runtimeHealthAuthoritative }),
        ...(current?.notices ? { notices: current.notices } : {}),
        ...(hasAuthoritativeState && current.recoverableDispatch
          ? { recoverableDispatch: current.recoverableDispatch }
          : {}),
        ...(hasAuthoritativeState && current.retiredDispatch
          ? { retiredDispatch: current.retiredDispatch }
          : {}),
        // Task cards are cached presentation, like the transcript itself. A
        // failed state read or remount revokes action authority, not knowledge
        // of the children: removing these makes pinned agents disappear (or
        // fall back to their launch rows) until the state read catches up.
        // Only fresh state or a different runtime identity can replace them.
        // A remount after the progressive cache was trimmed has no identity
        // ref, so `identityChanged` stays false; compare generations so a
        // retained projection cannot donate the previous runtime's cards.
        ...(!identityChanged &&
        current?.backgroundTasks &&
        (progressiveIdentityRef.current !== undefined ||
          current.generation === value.identity.sourceGeneration)
          ? { backgroundTasks: current.backgroundTasks }
          : {}),
        ...(hasAuthoritativeState && current.suggestedPrompt
          ? { suggestedPrompt: current.suggestedPrompt }
          : {}),
        ...(hasAuthoritativeState && current.completionBlockedByBackgroundTasks !== undefined
          ? { completionBlockedByBackgroundTasks: current.completionBlockedByBackgroundTasks }
          : {}),
        // How the last turn ended belongs to session state, like the turn.
        ...(hasAuthoritativeState && current.terminalMessages
          ? { terminalMessages: current.terminalMessages }
          : {}),
        ...(current?.turnBoundaries ? { turnBoundaries: current.turnBoundaries } : {}),
        ...retainedCommandFields(current, progressiveDiscoveryRef.current, value.identity),
        // Ordered after whatever is on screen, not after `current`: a new
        // provider session under the same source generation starts `current`
        // over, and a revision reset to 1 would make `applyProjection` drop
        // the new session's transcript as older than the one it replaces.
        revision: (projectionRef.current?.revision ?? 0) + 1,
        generation: value.identity.sourceGeneration,
      };
      const next: NativeAgentSessionProjection<TMessage> = {
        ...live,
        messages,
        ...(messageWindow ? { messageWindow } : { messageWindow: undefined }),
      };
      historyEpochRef.current = historyPagingEpoch;
      historyCursorRef.current = settledHistoryCursor;
      historyBoundaryCursorRef.current = historyBoundaryCursor;
      historyCompleteRef.current = historyComplete;
      historyBootstrapRef.current = canBootstrapHistory;
      historyMessagesRef.current = retained;
      historyEvictionRef.current = evictionGeneration;
      heldHistoryReconcileOwedRef.current = heldHistoryReconcileOwed;
      if (!pagingCarriesOver) syncTokenRef.current = undefined;
      syncLiveProjectionRef.current = live;
      progressiveTranscriptTokenRef.current = token;
      lastTranscriptViewRef.current = value;
      progressiveHistoryEpochRef.current = value.historyEpoch;
      progressiveHistoryEvictionRef.current = evictionGeneration;
      progressiveIdentityRef.current = value.identity;
      const availability = value.freshness === "empty" ? "empty" : "current";
      markTranscriptAvailability(availability);
      setTranscriptRefreshing(false);
      setTranscriptError(null);
      applyProjection(next, {
        ...(syncTokenRef.current ? { token: syncTokenRef.current } : {}),
        liveProjection: live as NativeAgentSessionProjection,
        ...(historyPagingEpoch ? { historyEpoch: historyPagingEpoch } : {}),
        ...(settledHistoryCursor ? { historyCursor: settledHistoryCursor } : {}),
        ...(historyBoundaryCursor ? { historyBoundaryCursor } : {}),
        ...(canBootstrapHistory ? { historyBootstrap: true } : {}),
        ...(historyUnpageableRef.current ? { historyUnpageable: true } : {}),
        historyComplete,
        historyMessages: retained,
        historyBytes: retainedBytes,
      });
      updateProgressiveCache({
        identity: value.identity,
        transcriptToken: token,
        transcriptHistoryEpoch: value.historyEpoch,
        transcriptHistoryMetadata: {
          historyCursor: value.historyCursor,
          historyPaging: value.historyPaging,
          historyComplete: value.historyComplete,
          historyReconciliationToken: value.historyReconciliationToken,
        },
        heldHistoryReconcileOwed,
        transcriptAvailability: availability,
        transcriptRefreshing: false,
        transcriptError: undefined,
        ...(identityChanged
          ? {
              stateToken: undefined,
              discoveryToken: undefined,
              stateAvailability: "unavailable",
              stateError: undefined,
              discovery: undefined,
            }
          : {}),
      });
      if (heldHistoryReconcileOwed) setHeldHistoryReconcileSignal((signal) => signal + 1);
      return next;
    },
    [
      projectionStore,
      applyProjection,
      discoverySchedule,
      environmentId,
      historyRequestBudget,
      identityBelongsToView,
      platform,
      markSessionStateAvailability,
      markTranscriptAvailability,
      sessionKey,
      updateProgressiveCache,
    ],
  );

  /** Install action-critical state while preserving the transcript array. */
  const applyProgressiveState = useCallback(
    (value: NativeAgentSessionStateView, token: string) => {
      if (!identityBelongsToView(value.identity)) return null;
      const knownIdentity = progressiveIdentityRef.current;
      const identityChanged =
        knownIdentity !== undefined && !sameProgressiveIdentity(knownIdentity, value.identity);
      if (identityChanged) {
        progressiveDiscoveryTokenRef.current = undefined;
        progressiveDiscoveryRef.current = undefined;
        discoverySchedule.markDue();
        updateProgressiveCache({ discoveryToken: undefined, discovery: undefined });
      }
      if (knownIdentity && knownIdentity.providerSessionId !== value.identity.providerSessionId) {
        applyProjection(null);
        markTranscriptAvailability("unavailable");
        progressiveTranscriptTokenRef.current = undefined;
        lastTranscriptViewRef.current = null;
        progressiveHistoryEpochRef.current = undefined;
      }
      const heldProjection = projectionRef.current;
      const current =
        identityChanged && heldProjection
          ? {
              ...heldProjection,
              slashCommands: undefined,
              slashCommandCatalogue: undefined,
              runtime: undefined,
            }
          : heldProjection;
      const next: NativeAgentSessionProjection<TMessage> = {
        platform,
        environmentId,
        // An empty provider id is a session the first prompt has not created yet.
        ...(value.identity.providerSessionId
          ? { sessionId: value.identity.providerSessionId }
          : {}),
        ...(value.title || current?.title ? { title: value.title ?? current?.title } : {}),
        ...(value.shareUrl === undefined ? {} : { shareUrl: value.shareUrl }),
        connection: value.connection,
        turn: value.turn,
        // Messages belong to the provider session they were read from. State
        // for a replacement session must not relabel the old transcript as
        // its own while the new transcript is still on its way.
        ...(current && current.sessionId && current.sessionId !== value.identity.providerSessionId
          ? { messages: [] }
          : {
              messages: current?.messages ?? [],
              ...(current?.messageWindow ? { messageWindow: current.messageWindow } : {}),
            }),
        interactions: value.interactions,
        composerControls: value.composerControls,
        ...(value.composer ? { composer: value.composer } : {}),
        ...(value.readiness ? { readiness: value.readiness } : {}),
        capabilities: value.capabilities,
        ...(value.queue ? { queue: value.queue } : {}),
        ...(value.asyncQuestionResponses
          ? { asyncQuestionResponses: value.asyncQuestionResponses }
          : {}),
        ...(value.contextUsage ? { contextUsage: value.contextUsage } : {}),
        ...(value.goal ? { goal: value.goal } : {}),
        ...(value.policy ? { policy: value.policy } : {}),
        ...(value.rateLimits ? { rateLimits: value.rateLimits } : {}),
        ...(current?.runtime ? { runtime: current.runtime } : {}),
        ...(value.runtimeHealthAuthoritative === undefined
          ? current?.runtimeHealthAuthoritative === undefined
            ? {}
            : { runtimeHealthAuthoritative: current.runtimeHealthAuthoritative }
          : { runtimeHealthAuthoritative: value.runtimeHealthAuthoritative }),
        notices: value.notices,
        ...(value.recoverableDispatch ? { recoverableDispatch: value.recoverableDispatch } : {}),
        ...(value.retiredDispatch ? { retiredDispatch: value.retiredDispatch } : {}),
        ...(value.backgroundTasks ? { backgroundTasks: value.backgroundTasks } : {}),
        ...(value.suggestedPrompt ? { suggestedPrompt: value.suggestedPrompt } : {}),
        ...(value.completionBlockedByBackgroundTasks === undefined
          ? {}
          : { completionBlockedByBackgroundTasks: value.completionBlockedByBackgroundTasks }),
        ...(value.terminalMessages?.length
          ? { terminalMessages: value.terminalMessages as TMessage[] }
          : {}),
        ...(current?.turnBoundaries ? { turnBoundaries: current.turnBoundaries } : {}),
        ...retainedCommandFields(current, progressiveDiscoveryRef.current, value.identity),
        revision: (current?.revision ?? 0) + 1,
        generation: value.identity.sourceGeneration,
      };
      progressiveStateTokenRef.current = token;
      progressiveIdentityRef.current = value.identity;
      markSessionStateAvailability("current");
      setSessionStateError(null);
      applyProjection(next);
      updateProgressiveCache({
        identity: value.identity,
        stateToken: token,
        stateAvailability: "current",
        stateError: undefined,
        ...(knownIdentity && knownIdentity.providerSessionId !== value.identity.providerSessionId
          ? {
              transcriptToken: undefined,
              transcriptHistoryEpoch: undefined,
              transcriptAvailability: "unavailable" as const,
            }
          : {}),
      });
      return next;
    },
    [
      applyProjection,
      discoverySchedule,
      environmentId,
      identityBelongsToView,
      markSessionStateAvailability,
      markTranscriptAvailability,
      platform,
      updateProgressiveCache,
    ],
  );

  const applyProgressiveDiscovery = useCallback(
    (value: NativeAgentDiscoveryView, token: string) => {
      if (!identityBelongsToView(value.identity)) return;
      const knownIdentity = progressiveIdentityRef.current;
      if (knownIdentity && !sameProgressiveIdentity(knownIdentity, value.identity)) return;
      progressiveDiscoveryTokenRef.current = token;
      progressiveDiscoveryRef.current = value;
      const current = projectionRef.current;
      if (current) {
        const models = value.sections.models?.value;
        const commands = value.sections.commands?.value;
        const commandCatalogue = value.sections.commands?.catalogue;
        const mcp = value.sections.mcp?.value;
        const runtime = value.sections.runtime?.value;
        const next: NativeAgentSessionProjection<TMessage> = {
          ...current,
          ...(models
            ? {
                composer: current.composer
                  ? {
                      ...current.composer,
                      models: withRetainedSelectedModelRow(models, current.composer),
                    }
                  : {
                      models,
                      fastModeEnabled: null,
                      fastModeAvailable: false,
                      modes: [],
                    },
              }
            : {}),
          ...(commands ? { slashCommands: commands } : {}),
          ...(commandCatalogue ? { slashCommandCatalogue: commandCatalogue } : {}),
          ...(runtime || mcp
            ? {
                runtime: {
                  ...current.runtime,
                  // A runtime section is the only source of steer occupancy,
                  // so its absence there retires a retained saturated value.
                  ...(runtime ? { steer: undefined } : {}),
                  ...runtime?.summary,
                  ...(runtime ? { notices: runtime.notices } : {}),
                  ...(mcp ? { mcp, mcpServers: mcp.length } : {}),
                },
              }
            : {}),
          revision: current.revision + 1,
        };
        applyProjection(next);
      }
      updateProgressiveCache({
        identity: value.identity,
        discoveryToken: token,
        discovery: value,
      });
    },
    [applyProjection, identityBelongsToView, updateProgressiveCache],
  );

  /**
   * Install an authoritative projection returned by a mutation.
   *
   * Mutations answer on the legacy full-projection surface, whose transcript
   * window is unrelated to the sync live tail. Applying one verbatim would
   * drop every page this tab had loaded until a later poll happened to rebuild
   * them. Merge it over the retained history instead, and leave the sync token
   * and live projection alone — they describe the base the backend will diff
   * its next delta against, and a legacy window is not that base.
   */
  const applyMutationProjection = useCallback(
    (next: NativeAgentSessionProjection<TMessage> | null) => {
      progressiveStateTokenRef.current = undefined;
      markSessionStateAvailability(next ? "current" : "unavailable");
      setSessionStateRefreshing(false);
      setSessionStateError(null);
      const live = syncLiveProjectionRef.current;
      const retained = historyMessagesRef.current;
      /*
       * A tab with no retained pages still owns a load-earlier decision the
       * legacy window cannot express, so only an identity mismatch short
       * circuits here. The merge below is a no-op when `retained` is empty.
       */
      if (!next || !live || next.platform !== platform || next.environmentId !== environmentId) {
        const ordered = next
          ? { ...next, revision: orderedRevision(projectionRef.current, next) }
          : null;
        applyProjection(ordered);
        return ordered;
      }
      const nextIds = new Set(
        next.messages
          .map((message) => (message as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const messages = [
        ...retained.filter((message) => !nextIds.has((message as { id?: unknown })?.id as string)),
        ...next.messages,
      ];
      const budget = historyRequestBudget();
      const messageWindow = historyMessageWindow({
        messageCount: messages.length,
        ...(historyCursorRef.current ? { cursor: historyCursorRef.current } : {}),
        ...(historyBoundaryCursorRef.current
          ? { boundaryCursor: historyBoundaryCursorRef.current }
          : {}),
        serverCanLoadEarlier: historyBootstrapRef.current,
        complete: historyCompleteRef.current,
        allowIncompleteBootstrap: historyBootstrapRef.current,
        ...(historyUnpageableRef.current ? { unpageable: true } : {}),
        budgetAvailable: budget.messages > 0 && budget.bytes > 0,
        ...(next.messageWindow ? { serverWindow: next.messageWindow } : {}),
      });
      const merged = {
        ...next,
        messages,
        ...(messageWindow ? { messageWindow } : { messageWindow: undefined }),
        revision: orderedRevision(projectionRef.current, next),
      } as NativeAgentSessionProjection<TMessage>;
      applyProjection(merged);
      return merged;
    },
    [
      applyProjection,
      environmentId,
      historyRequestBudget,
      markSessionStateAvailability,
      platform,
      setSessionStateRefreshing,
    ],
  );

  /**
   * Run the trailing reconciliation a coalesced invalidation asked for, once
   * nothing is left that would make its read stale or premature.
   */
  const flushPendingReconcile = useCallback(() => {
    if (!reconcileAfterInFlightRef.current) return;
    if (refreshesInFlightRef.current > 0 || establishingSessionRef.current > 0) return;
    reconcileAfterInFlightRef.current = false;
    if (!backgroundRefreshEnabledRef.current) return;
    // Through the read coordinator, so the trailing read joins/defers like
    // every other background read (e.g. waits for a hidden document).
    queueMicrotask(() => coordinatedInvalidateRef.current());
  }, []);

  const refresh = useCallback(
    async (options?: {
      manual?: boolean;
      reconcileAfterInFlight?: boolean;
      /** A shared background round: identical requests of sibling views join. */
      round?: NativeSessionReadRound;
    }) => {
      if (!enabled) return null;
      const background = options?.manual === false;
      const round = background ? options.round : undefined;
      const send = <T>(command: string, input: object, run: () => Promise<T>): Promise<T> =>
        round ? round.request(command, input, run) : run();
      // A background read is never worth issuing while the session is still
      // being established: it cannot resolve to anything but `null`, and the
      // per-environment invalidation that triggers most of them fires for every
      // sibling tab in the environment, so a second agent tab makes this the
      // common case rather than a rare race.
      if (background && (refreshesInFlightRef.current > 0 || establishingSessionRef.current > 0)) {
        if (options.reconcileAfterInFlight) {
          reconcileAfterInFlightRef.current = true;
        }
        return projectionRef.current;
      }
      refreshesInFlightRef.current += 1;
      const sequence = ++refreshSequenceRef.current;
      const operationEpoch = projectionOperationEpochRef.current;
      // The in-flight flags only feed the connection surface, which ignores
      // them while the tab holds an authoritative session state. A background
      // poll over such a view keeps its in-flight state in the refs above and
      // leaves the flags alone, instead of raising and clearing both on every
      // tick. A read that loses that authority settles the surface itself
      // (projection, availability, `hasCompletedRead`).
      const quiet =
        background &&
        sessionStateAvailabilityRef.current === "current" &&
        projectionRef.current !== null;
      if (!quiet) setIsRefreshing(true);
      // Background polls confirm a view this tab already holds. Raising the
      // skeleton on every 500–1500 ms tick would flicker the indicator and the
      // live region even when the displayed transcript cannot change.
      if (!background) {
        setTranscriptRefreshing(true);
      }
      try {
        // The only read path: a backend without it is reported, never read
        // through a full projection (`NativeAgentSyncUnsupportedError`).
        await requireNativeAgentProgressiveSync(scope);
        setTranscriptError(null);
        const retainedStateAvailability = beginSessionStateRefresh({ quiet });
        setSessionStateError(null);
        updateProgressiveCache({
          ...(background ? {} : { transcriptRefreshing: true }),
          transcriptError: undefined,
          stateAvailability: retainedStateAvailability,
          stateError: undefined,
        });

        const stillCurrent = () =>
          sequence === refreshSequenceRef.current &&
          operationEpoch === projectionOperationEpochRef.current;
        let transcriptMissing = false;
        let stateMissing = false;
        const requestTranscript = (forceSnapshot: boolean) => {
          const input = {
            ...identity,
            viewVersion: 1 as const,
            liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
            ...(nativeTranscriptPatchesSupported(scope)
              ? { patchVersion: NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION }
              : {}),
            ...(forceSnapshot
              ? { forceSnapshot: true }
              : progressiveTranscriptTokenRef.current
                ? { knownToken: progressiveTranscriptTokenRef.current }
                : {}),
            ...(options?.manual === true ? { forceSnapshot: true } : {}),
          };
          return send("transcript", input, () =>
            backendForScope(scope).getNativeAgentTranscriptUpdate<TMessage>(input),
          );
        };
        /*
         * A background round over tokens this view already holds asks for both
         * in one request. Everything else (a first read, a manual read, a
         * recovery after a part was lost) reads them apart, so a cold transcript
         * never holds session state back. A part the backend could not answer
         * in time comes back `pending` and is read on its own below, as is
         * everything if this backend turns out not to have the command.
         */
        const liveTranscriptToken = progressiveTranscriptTokenRef.current;
        const liveStateToken = progressiveStateTokenRef.current;
        const liveUpdate =
          background && liveTranscriptToken && liveStateToken && nativeLiveUpdateSupported(scope)
            ? readLiveUpdate<TMessage>(scope, send, {
                ...identity,
                viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION,
                liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
                transcriptToken: liveTranscriptToken,
                stateToken: liveStateToken,
                ...(nativeTranscriptPatchesSupported(scope)
                  ? { patchVersion: NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION }
                  : {}),
              })
            : null;
        const applyTranscriptUpdate = (
          update: NativeAgentTranscriptUpdate<TMessage>,
          requestedWithToken: boolean,
        ): "applied" | "retry-snapshot" | "missing" | "failed" => {
          if (update.status === "snapshot") {
            applyProgressiveTranscript(
              update.value as NativeAgentTranscriptView<TMessage>,
              update.token,
            );
            return "applied";
          }
          if (update.status === "delta") {
            const current = lastTranscriptViewRef.current;
            if (
              current &&
              progressiveTranscriptTokenRef.current === update.baseToken &&
              sameProgressiveIdentity(current.identity, update.identity)
            ) {
              const merged = applyNativeAgentTranscriptDelta(current, update.delta);
              if (merged) {
                applyProgressiveTranscript(merged, update.token, {
                  deletedMessageIds: update.delta.deletedMessageIds,
                  deliveredIds: new Set(
                    [
                      ...update.delta.messageUpserts.map(
                        (message) => (message as { id?: unknown })?.id,
                      ),
                      ...(update.delta.messagePatches ?? []).map((patch) => patch.id),
                    ].filter((id): id is string => typeof id === "string"),
                  ),
                });
                return "applied";
              }
            }
            progressiveTranscriptTokenRef.current = undefined;
            lastTranscriptViewRef.current = null;
            markTranscriptAvailability(projectionRef.current ? "cached" : "unavailable");
            return "retry-snapshot";
          }
          if (update.status === "unchanged") {
            const previousAvailability = transcriptAvailabilityRef.current;
            const hasLocalView = lastTranscriptViewRef.current != null;
            const hasBody = hasUsableTranscriptBody(projectionRef.current, previousAvailability);
            if (!hasLocalView && !hasBody) {
              progressiveTranscriptTokenRef.current = undefined;
              lastTranscriptViewRef.current = null;
              // A tokened `unchanged` cannot rehydrate a body we no longer
              // hold. Ask once for a snapshot. An untokened `unchanged` is
              // just "nothing new" and must not start a retry loop.
              if (requestedWithToken) return "retry-snapshot";
              const availability = previousAvailability === "empty" ? "empty" : "unavailable";
              markTranscriptAvailability(availability);
              setTranscriptRefreshing(false);
              setTranscriptError(null);
              updateProgressiveCache({
                transcriptToken: undefined,
                transcriptAvailability: availability,
                transcriptRefreshing: false,
                transcriptError: undefined,
              });
              return "applied";
            }
            progressiveTranscriptTokenRef.current = update.token;
            const availability = previousAvailability === "empty" ? "empty" : "current";
            markTranscriptAvailability(availability);
            setTranscriptRefreshing(false);
            setTranscriptError(null);
            updateProgressiveCache({
              identity: update.identity,
              transcriptToken: update.token,
              transcriptAvailability: availability,
              transcriptRefreshing: false,
              transcriptError: undefined,
            });
            return "applied";
          }
          if (update.status === "missing") {
            transcriptMissing = true;
            setTranscriptRefreshing(false);
            return "missing";
          }
          const message = update.error ?? "Transcript is temporarily unavailable";
          setTranscriptRefreshing(false);
          setTranscriptError(message);
          updateProgressiveCache({
            transcriptRefreshing: false,
            transcriptError: message,
          });
          return "failed";
        };
        const firstTranscript = liveUpdate
          ? liveUpdate.then(({ transcript }) =>
              transcript.status === "pending" ? requestTranscript(false) : transcript,
            )
          : requestTranscript(false);
        const transcriptRead = firstTranscript
          .then(async (update) => {
            if (!stillCurrent()) return;
            let result = applyTranscriptUpdate(
              update,
              progressiveTranscriptTokenRef.current !== undefined && update.status !== "snapshot",
            );
            if (result === "retry-snapshot") {
              // A delta that no longer applies (a trimmed long turn, a moved
              // base) is routine mid-turn. The held messages stay on screen
              // until the snapshot replaces them, so a background read must
              // not flash the skeleton under them on every fallback.
              if (!background) {
                setTranscriptRefreshing(true);
                updateProgressiveCache({ transcriptRefreshing: true });
              }
              const snapshot = await requestTranscript(true);
              if (!stillCurrent()) return;
              result = applyTranscriptUpdate(snapshot, false);
              if (result === "retry-snapshot") {
                setTranscriptRefreshing(false);
                const availability = projectionRef.current ? "cached" : "unavailable";
                markTranscriptAvailability(availability);
                updateProgressiveCache({
                  transcriptToken: undefined,
                  transcriptAvailability: availability,
                  transcriptRefreshing: false,
                });
              }
            }
          })
          .catch((error) => {
            if (!stillCurrent()) return;
            const message = error instanceof Error ? error.message : String(error);
            setTranscriptRefreshing(false);
            setTranscriptError(message);
            updateProgressiveCache({ transcriptRefreshing: false, transcriptError: message });
          });

        const stateInput = {
          ...identity,
          viewVersion: 1 as const,
          ...(progressiveStateTokenRef.current
            ? { knownToken: progressiveStateTokenRef.current }
            : {}),
          ...(options?.manual === true ? { forceSnapshot: true } : {}),
        };
        const requestState = () =>
          send("session-state", stateInput, () =>
            backendForScope(scope).getNativeAgentSessionStateUpdate(stateInput),
          );
        const firstState = liveUpdate
          ? liveUpdate.then(({ state }) => (state.status === "pending" ? requestState() : state))
          : requestState();
        const stateRead = firstState
          .then((update) => {
            if (!stillCurrent()) return;
            if (update.status === "snapshot") {
              applyProgressiveState(update.value, update.token);
            } else if (update.status === "unchanged") {
              progressiveStateTokenRef.current = update.token;
              markSessionStateAvailability("current");
              setSessionStateError(null);
              updateProgressiveCache({
                identity: update.identity,
                stateToken: update.token,
                stateAvailability: "current",
                stateError: undefined,
              });
            } else if (update.status === "missing") {
              stateMissing = true;
              // A quiet read no longer holds authority. Keep the connection
              // pending until the independent transcript read also settles.
              if (quiet) setIsRefreshing(true);
              progressiveStateTokenRef.current = undefined;
              markSessionStateAvailability("unavailable");
              updateProgressiveCache({ stateToken: undefined, stateAvailability: "unavailable" });
            } else {
              const message = update.error ?? "Session state is temporarily unavailable";
              if (quiet) setIsRefreshing(true);
              // Transcript reads may discard action-critical fields while
              // state is unavailable. Recovery must reinstall those fields,
              // not accept an `unchanged` reply against the old token.
              progressiveStateTokenRef.current = undefined;
              markSessionStateAvailability("unavailable");
              setSessionStateError(message);
              updateProgressiveCache({
                stateToken: undefined,
                stateAvailability: "unavailable",
                stateError: message,
              });
            }
          })
          .catch((error) => {
            if (!stillCurrent()) return;
            const message = error instanceof Error ? error.message : String(error);
            if (quiet) setIsRefreshing(true);
            progressiveStateTokenRef.current = undefined;
            markSessionStateAvailability("unavailable");
            setSessionStateError(message);
            updateProgressiveCache({
              stateToken: undefined,
              stateAvailability: "unavailable",
              stateError: message,
            });
          });

        const turnPhase = projectionRef.current?.turn.phase;
        let readDiscovery = true;
        if (background) readDiscovery = discoverySchedule.claim(Date.now(), turnPhase);
        else discoverySchedule.claimExplicit(Date.now(), turnPhase);
        if (readDiscovery) {
          const discoveryInput = {
            ...identity,
            viewVersion: 1 as const,
            sections: [
              "models",
              "commands",
              "mcp",
              "runtime",
            ] satisfies NativeAgentDiscoverySection[],
            ...(progressiveDiscoveryTokenRef.current
              ? { knownToken: progressiveDiscoveryTokenRef.current }
              : {}),
            ...(options?.manual === true ? { forceSnapshot: true } : {}),
          };
          void send("discovery", discoveryInput, () =>
            backendForScope(scope).getNativeAgentDiscoveryUpdate(discoveryInput),
          )
            .then((update) => {
              // Nothing else re-reads a discarded or failed answer soon.
              if (!stillCurrent()) {
                discoverySchedule.markDue();
                return;
              }
              if (update.status === "snapshot") {
                applyProgressiveDiscovery(update.value, update.token);
                if (progressiveDiscoveryRef.current !== update.value) {
                  discoverySchedule.markDue();
                }
              } else if (update.status === "unchanged") {
                progressiveDiscoveryTokenRef.current = update.token;
              } else {
                discoverySchedule.markDue();
              }
              discoverySchedule.observe(progressiveDiscoveryRef.current);
            })
            .catch(() => discoverySchedule.markDue());
        }

        await Promise.allSettled([transcriptRead, stateRead]);
        // A superseding refresh owns the flag from here on; clearing it would
        // report that tab as settled while its newer read is still running.
        if (stillCurrent()) setSessionStateRefreshing(false);
        if (
          stillCurrent() &&
          transcriptMissing &&
          stateMissing &&
          establishingSessionRef.current === 0
        ) {
          /*
           * The session is gone, so is the history a page in flight was
           * fetched behind. A history page survives an ordinary poll, so this
           * read has to retire it explicitly: invalidate the page and forget
           * the paging state it would otherwise merge into, or its late answer
           * reinstalls the projection this read just removed.
           */
          historyPageSequenceRef.current += 1;
          resetSyncState();
          applyProjection(null);
          markTranscriptAvailability("unavailable");
          setTranscriptRefreshing(false);
          updateProgressiveCache({
            transcriptAvailability: "unavailable",
            transcriptRefreshing: false,
            stateAvailability: "unavailable",
          });
        }
        if (stillCurrent()) {
          if (projectionRef.current) establishmentFailureRef.current = false;
          if (projectionRef.current || !establishmentFailureRef.current) setRuntimeError(null);
        }
        return projectionRef.current;
      } catch (error) {
        if (
          sequence === refreshSequenceRef.current &&
          operationEpoch === projectionOperationEpochRef.current
        ) {
          setRuntimeError(error instanceof Error ? error.message : String(error));
          setTranscriptRefreshing(false);
        }
        return null;
      } finally {
        refreshesInFlightRef.current = Math.max(0, refreshesInFlightRef.current - 1);
        if (
          sequence === refreshSequenceRef.current &&
          operationEpoch === projectionOperationEpochRef.current &&
          // Nothing this read saw is settled while the session it describes is
          // still being created. `connect` owns the connection surface for that
          // window and reads authoritatively once the provider mapping exists.
          establishingSessionRef.current === 0
        ) {
          setIsRefreshing(false);
          // Settled, whatever it returned. A read that resolves to null is an
          // authoritative "no session", not a pending one.
          setHasCompletedRead(true);
        }
        flushPendingReconcile();
      }
    },
    [
      scope,
      applyProjection,
      applyProgressiveDiscovery,
      applyProgressiveState,
      applyProgressiveTranscript,
      beginSessionStateRefresh,
      discoverySchedule,
      enabled,
      flushPendingReconcile,
      identity,
      markSessionStateAvailability,
      markTranscriptAvailability,
      resetSyncState,
      setIsRefreshing,
      setSessionStateRefreshing,
      updateProgressiveCache,
    ],
  );

  useEffect(() => {
    refreshRef.current = refresh;
    return () => {
      if (refreshRef.current === refresh) refreshRef.current = null;
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    if (!enabled) {
      setIsRefreshing(false);
      return null;
    }
    setIsRefreshing(true);
    // Leave the previous identity's failure behind so Retry is not stuck on
    // Connection Failed for the whole reconnect, and a later platform cannot
    // inherit a completed read it never made.
    setRuntimeError(null);
    setHasCompletedRead(false);
    establishmentFailureRef.current = false;
    if (sendingHeld) {
      try {
        return await refresh();
      } finally {
        flushPendingReconcile();
      }
    }
    // Held only for as long as the provider mapping is genuinely missing, so
    // the reads that follow the adopt/ensure below still settle normally and a
    // session that really is gone is still reported as one.
    establishingSessionRef.current += 1;
    let establishing = true;
    const settleEstablishing = () => {
      if (!establishing) return;
      establishing = false;
      establishingSessionRef.current = Math.max(0, establishingSessionRef.current - 1);
    };
    const cached = projectionRef.current;
    const cachedSessionMatches = Boolean(
      initialProviderSessionId &&
      cached?.platform === platform &&
      cached.sessionId === initialProviderSessionId,
    );
    // On an environment remount the durable mapping has already been adopted.
    // Start the transcript read alongside the liveness/adoption check so the
    // common path pays the slower operation once, not both in series.
    const cachedSessionRefresh = cachedSessionMatches ? refresh() : null;
    try {
      if (initialProviderSessionId) {
        try {
          await backendForScope(scope).adoptNativeAgentSession({
            ...identity,
            providerSessionId: initialProviderSessionId,
            ...(initialAgentModel ? { model: initialAgentModel } : {}),
            ...(initialReasoningEffort ? { reasoningEffort: initialReasoningEffort } : {}),
            ...(initialConversationMode ? { sessionMode: initialConversationMode } : {}),
            ...(typeof initialFastMode === "boolean" ? { fastMode: initialFastMode } : {}),
            ...(initialExecutionProfileId ? { executionProfileId: initialExecutionProfileId } : {}),
          });
        } catch (error) {
          if (!isProviderSessionMissingError(error)) throw error;
          if (requireExistingResumeSession) throw error;
          // A restored pane may point at a rollout deleted outside
          // Orkestrator. Only an authoritative provider "missing" result may
          // replace it; transport failures remain retryable and never create a
          // surprise second session.
          const replacement = await backendForScope(scope).ensureNativeAgentSession({
            ...identity,
            title:
              platform === "cursor"
                ? "Cursor Agent"
                : platform === "grok"
                  ? "Grok Build"
                  : "Agent Session",
            model: initialAgentModel ?? defaultAgentModel,
            modelSource: initialAgentModel ? "explicit" : "default",
            reasoningEffort: initialReasoningEffort ?? defaultReasoningEffort,
            sessionMode: initialConversationMode,
            fastMode: initialFastMode ?? defaultFastMode,
            executionProfileId: initialExecutionProfileId,
            parameterValues: defaultParameterValues,
          });
          if (replacement.modelSubstitution) onModelSubstituted?.(replacement.modelSubstitution);
          replacedProviderSessionRef.current = {
            requested: initialProviderSessionId,
            replacement: replacement.providerSessionId,
          };
          await onResumeSessionReplaced?.({
            requestedProviderSessionId: initialProviderSessionId,
            replacementProviderSessionId: replacement.providerSessionId,
            logicalSessionKey: replacement.logicalSessionKey,
          });
          setResumeSessionReplacement({
            requestedProviderSessionId: initialProviderSessionId,
            replacementProviderSessionId: replacement.providerSessionId,
          });
        }
      } else {
        const ensured = await backendForScope(scope).ensureNativeAgentSession({
          ...identity,
          title:
            platform === "cursor"
              ? "Cursor Agent"
              : platform === "grok"
                ? "Grok Build"
                : "Agent Session",
          model: initialAgentModel ?? defaultAgentModel,
          modelSource: initialAgentModel ? "explicit" : "default",
          reasoningEffort: initialReasoningEffort ?? defaultReasoningEffort,
          sessionMode: initialConversationMode,
          fastMode: initialFastMode ?? defaultFastMode,
          executionProfileId: initialExecutionProfileId,
          parameterValues: defaultParameterValues,
        });
        if (ensured.modelSubstitution) onModelSubstituted?.(ensured.modelSubstitution);
      }
      isInitializedRef.current = true;
      lastInitTimeRef.current = Date.now();
      acknowledgeInitialLaunchOptions();
      establishmentFailureRef.current = false;
      setRuntimeError(null);
      // The provider mapping now exists, so every read from here on is
      // authoritative again — including the two below.
      settleEstablishing();
      if (cachedSessionRefresh) {
        const hydrated = await cachedSessionRefresh;
        if (
          hydrated?.connection === "connected" &&
          hydrated.platform === platform &&
          hydrated.sessionId === initialProviderSessionId
        ) {
          return hydrated;
        }
      }
      return await refresh();
    } catch (error) {
      // A failed adopt/ensure is a real, reportable failure: close the window
      // first so this error actually reaches the connection surface, and mark it
      // so the reads that follow — the trailing reconcile below, then the poll
      // loop — report the same failure rather than overwriting it.
      settleEstablishing();
      establishmentFailureRef.current = true;
      // A coded error from desktop IPC leads with `[code] `; show its own text.
      setRuntimeError(ipcErrorText(error instanceof Error ? error.message : String(error)));
      setIsRefreshing(false);
      setTranscriptRefreshing(false);
      markSessionStateAvailability("unavailable");
      setSessionStateRefreshing(false);
      setHasCompletedRead(true);
      return null;
    } finally {
      // Backstop for a path that returned before the settle above, and the
      // point where a reconciliation coalesced during establishment is run.
      settleEstablishing();
      flushPendingReconcile();
    }
  }, [
    scope,
    acknowledgeInitialLaunchOptions,
    defaultAgentModel,
    defaultFastMode,
    defaultParameterValues,
    defaultReasoningEffort,
    identity,
    initialAgentModel,
    initialConversationMode,
    initialFastMode,
    initialExecutionProfileId,
    initialProviderSessionId,
    initialReasoningEffort,
    markSessionStateAvailability,
    requireExistingResumeSession,
    onModelSubstituted,
    onResumeSessionReplaced,
    enabled,
    flushPendingReconcile,
    platform,
    refresh,
    sendingHeld,
    setIsRefreshing,
    setSessionStateRefreshing,
  ]);

  // A new identity, or a session this hook is no longer allowed to read, has
  // nothing settled about it yet. Without this reset a completed read would
  // keep vouching for a platform or environment it never covered — a deferred
  // tab resolves its platform after mount, which is exactly that case.
  useEffect(() => {
    // The reset is one unit with the ref and shared projection-cache reads
    // below, which only an effect may touch: the restored availability and
    // errors come from that external cache, so they cannot be derived while
    // rendering, and resetting the state half earlier would split the unit.
    // oxlint-disable-next-line react/set-state-in-effect
    setHasCompletedRead(false);
    setResumeSessionReplacement(null);
    // For the same reason: one identity's creation failure must not keep
    // suppressing another identity's authoritative reads.
    establishmentFailureRef.current = false;
    resetSyncState();
    const store = projectionStore.getState();
    historyEvictionRef.current = store.historyEvictions.get(sessionKey) ?? 0;
    progressiveHistoryEvictionRef.current = store.historyEvictions.get(sessionKey) ?? 0;
    const cached = store.syncCaches.get(sessionKey);
    if (
      cached &&
      cached.liveProjection.platform === platform &&
      cached.liveProjection.environmentId === environmentId
    ) {
      syncTokenRef.current = cached.token;
      syncLiveProjectionRef.current =
        cached.liveProjection as NativeAgentSessionProjection<TMessage>;
      historyEpochRef.current = cached.historyEpoch;
      historyCursorRef.current = cached.historyCursor;
      historyBoundaryCursorRef.current = cached.historyBoundaryCursor;
      historyCompleteRef.current = cached.historyComplete;
      historyBootstrapRef.current = cached.historyBootstrap === true;
      historyUnpageableRef.current = cached.historyUnpageable === true;
      historyMessagesRef.current = cached.historyMessages as TMessage[];
    }
    const progressive = store.progressiveCaches.get(sessionKey);
    if (
      progressive?.identity?.environmentId === environmentId &&
      progressive.identity.platform === platform &&
      progressive.identity.logicalSessionKey === sessionKey &&
      (!initialProviderSessionId ||
        progressive.identity.providerSessionId === initialProviderSessionId)
    ) {
      progressiveIdentityRef.current = progressive.identity;
      const restoredView = restoreTranscriptViewFromProjection(
        progressive.identity,
        projectionRef.current,
        progressive.transcriptHistoryEpoch,
        progressive.transcriptAvailability,
        progressive.transcriptHistoryMetadata,
      );
      lastTranscriptViewRef.current = restoredView;
      heldHistoryReconcileOwedRef.current = progressive.heldHistoryReconcileOwed === true;
      // Old cache entries may lack the direct cursor. Owed reads still request
      // a snapshot so recovery also works across cache schema changes.
      progressiveTranscriptTokenRef.current =
        restoredView && !heldHistoryReconcileOwedRef.current
          ? progressive.transcriptToken
          : undefined;
      progressiveHistoryEpochRef.current = progressive.transcriptHistoryEpoch;
      /*
       * The shared cache carries tokens, not the session-state value they
       * validate. Replaying the token would let the backend answer `unchanged`
       * and grant this mount authority over controls it never read, so the
       * first state read after a remount always asks for a full snapshot.
       */
      progressiveStateTokenRef.current = undefined;
      progressiveDiscoveryTokenRef.current = progressive.discoveryToken;
      progressiveDiscoveryRef.current = progressive.discovery;
      discoverySchedule.markDue();
      markTranscriptAvailability(
        progressive.transcriptAvailability === "empty"
          ? "empty"
          : projectionRef.current
            ? "cached"
            : "unavailable",
      );
      setTranscriptError(progressive.transcriptError ?? null);
      markSessionStateAvailability("unavailable");
      setSessionStateError(null);
    } else {
      progressiveIdentityRef.current = undefined;
      progressiveTranscriptTokenRef.current = undefined;
      lastTranscriptViewRef.current = null;
      heldHistoryReconcileOwedRef.current = false;
      progressiveHistoryEpochRef.current = undefined;
      progressiveStateTokenRef.current = undefined;
      progressiveDiscoveryTokenRef.current = undefined;
      progressiveDiscoveryRef.current = undefined;
      discoverySchedule.markDue();
      // No matching transcript metadata, so a retained or foreign projection is
      // only ever `cached` here: its message count cannot prove the transcript
      // read ever came back empty.
      markTranscriptAvailability(projectionRef.current ? "cached" : "unavailable");
      setTranscriptError(null);
      markSessionStateAvailability("unavailable");
      setSessionStateError(null);
    }
  }, [
    projectionStore,
    discoverySchedule,
    enabled,
    environmentId,
    identity,
    initialProviderSessionId,
    markSessionStateAvailability,
    markTranscriptAvailability,
    platform,
    resetSyncState,
    sessionKey,
  ]);

  useEffect(() => {
    if (!enabled || !isActive) {
      // Connecting is the external system this effect owns, and its indicators
      // start and stop with it: `connect()` raises them synchronously, so going
      // inactive clears them here rather than in a separate render-time path.
      setIsRefreshing(false);
      // oxlint-disable-next-line react/set-state-in-effect
      setTranscriptRefreshing(false);
      return;
    }
    void connect().then(() => undefined);
  }, [connect, enabled, isActive, setIsRefreshing]);

  /*
   * Background reads — the 500/1,500 ms cadence, resource-change hints, resync
   * and trailing reconciles — are scheduled by the shared read coordinator:
   * one timer, joined reads with a single dirty flag, paused while the
   * document is hidden, and reconciled first (critical) on return.
   * The key is the session, so every mounted view of it shares that schedule:
   * one coordinated read refreshes each view that wants background reads,
   * and identical requests within it are sent once
   * (`native-session-shared-reads.ts`). Each view still applies answers into
   * its own fenced state (sequence/epoch, conditional tokens). Explicit and
   * post-mutation reads stay direct `refresh()` calls, as do connect/adopt
   * reads, and are never joined.
   */
  const sharedReadTarget = `${environmentId}\u0000${platform}\u0000${sessionKey}`;
  useEffect(() => {
    if (!enabled) return;
    return registerNativeSessionView(
      sharedReadTarget,
      {
        wantsBackgroundRead: () => backgroundRefreshEnabledRef.current,
        refresh: async (context, round) => {
          // A resume or reconnect may have missed any announcement.
          if (context.reason !== "interval" && context.reason !== "invalidate") {
            discoverySchedule.markDue();
          }
          return (
            refreshRef.current?.(
              context.reason === "interval"
                ? { manual: false, round }
                : { manual: false, reconcileAfterInFlight: true, round },
            ) ?? null
          );
        },
      },
      scope,
    );
  }, [discoverySchedule, enabled, scope, sharedReadTarget]);
  const { invalidate: coordinatedInvalidate } = useCoordinatedRead({
    key: {
      resource: "native-agent-session",
      target: sharedReadTarget,
      view: "session",
    },
    enabled,
    readOnSubscribe: false,
    retainOnDispose: false,
    coordinator: readCoordinatorFor(scope),
    demand: nativeSessionReadDemand(platform, runtimeProjection?.turn.phase, {
      active: enabled && isActive,
      observationEvents: nativeObservationEventsSupported(scope),
      quietObservation: runtimeProjection?.turn.quietObservation === true,
    }),
    read: async (context) => {
      await runNativeSessionReadRound(sharedReadTarget, context, scope);
    },
  });
  useLayoutEffect(() => {
    coordinatedInvalidateRef.current = coordinatedInvalidate;
  }, [coordinatedInvalidate]);

  useEffect(() => {
    const unsubscribeChange = onResourceChanged(
      "native-agent-session",
      (change) => {
        if (
          change.id !== environmentId ||
          (change.agent !== undefined &&
            (change.agent !== platform || change.logicalSessionKey !== sessionKey))
        ) {
          return;
        }
        if (nativeSessionInvalidationNamesDiscovery(change.cause)) discoverySchedule.markDue();
        if (enabled && isActive) coordinatedInvalidate();
      },
      scope,
    );
    const unsubscribeResync = onResourceResync(() => {
      invalidateNativeAgentSyncCapability(scope);
      discoverySchedule.markDue();
      if (enabled && isActive) coordinatedInvalidate();
    }, scope);
    /*
     * The backend observer announces every activity transition, stamped: a
     * turn starting or ending, a question or approval parking the turn. This
     * is what lets a qualified idle view read less often — it is told when it
     * must read. A missed announcement (stamp gap) or a new observer lifetime
     * re-reads every view.
     */
    const unsubscribeObservation = subscribeNativeObservationInvalidations((invalidation) => {
      if (invalidation.kind === "all") discoverySchedule.markDue();
      if (
        enabled &&
        isActive &&
        nativeObservationInvalidationMatches(invalidation, {
          environmentId,
          agent: platform,
          logicalSessionKey: sessionKey,
        })
      ) {
        coordinatedInvalidate();
      }
    }, scope);
    return () => {
      unsubscribeChange();
      unsubscribeResync();
      unsubscribeObservation();
    };
  }, [
    coordinatedInvalidate,
    discoverySchedule,
    enabled,
    environmentId,
    isActive,
    platform,
    scope,
    sessionKey,
  ]);

  const send = useCallback(
    async (
      prompt: string,
      options: NativeAgentSendOptions = {},
    ): Promise<NativeAgentDispatchOutcome> => {
      const text = nativeSubmissionText(prompt, options.command);
      if (!text.trim()) return { outcome: "rejected", error: "Prompt must not be blank" };
      const pending = pendingDispatchRef.current;
      const requestId =
        options.requestId ?? (pending?.prompt === text ? pending.requestId : crypto.randomUUID());
      pendingDispatchRef.current = { prompt: text, requestId };
      beginProjectionMutation();
      setIsDispatching(true);
      try {
        const outcome = await backendForScope(scope).dispatchNativeAgentIntent({
          ...identity,
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
          title:
            platform === "cursor"
              ? "Cursor Agent"
              : platform === "grok"
                ? "Grok Build"
                : "Agent Session",
          prompt: text,
          requestId,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          mode: options.mode,
          fastMode: options.fastMode,
          subAgent: options.subAgent,
          executionAgent: options.executionAgent,
          includeLocalSettings: options.includeLocalSettings,
          promptSuggestions: options.promptSuggestions,
          attachments: options.attachments,
          ...(options.command ? { command: options.command } : {}),
        });
        if (outcome.outcome !== "unknown") pendingDispatchRef.current = null;
        if (outcome.outcome === "accepted") {
          projectionStore.getState().clearTurnStopped(sessionKey);
        }
        await refresh();
        return outcome;
      } catch (error) {
        // Keep the stable request id. If the transport failed after acceptance,
        // an explicit retry is deduplicated by the backend/provider journal.
        await refresh();
        return {
          outcome: "unknown",
          requestId,
          // The RPC itself failed, so the backend never opened its at-most-once
          // window and no recoverable record can exist for this request id.
          // Marking it lets the renderer surface the failure instead of leaving
          // the optimistic prompt looking delivered with no feedback at all.
          origin: "transport",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        setIsDispatching(false);
      }
    },
    [scope, beginProjectionMutation, identity, platform, refresh, sessionKey, projectionStore],
  );

  const stop = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const stoppedSessionId = projectionRef.current?.sessionId;
    const next = await backendForScope(scope).stopNativeAgentSession<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
    if (stoppedSessionId) {
      projectionStore.getState().markTurnStopped(sessionKey, stoppedSessionId);
    }
    return next;
  }, [
    scope,
    applyMutationProjection,
    beginProjectionMutation,
    identity,
    sessionKey,
    projectionStore,
  ]);

  const stopBackgroundTask = useCallback(
    async (taskId: string) => {
      const operationEpoch = beginProjectionMutation();
      const next = await backendForScope(scope).stopNativeAgentBackgroundTask<TMessage>({
        ...identity,
        taskId,
      });
      if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
      return next;
    },
    [scope, applyMutationProjection, beginProjectionMutation, identity],
  );

  const dismissSuggestedPrompt = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const next = await backendForScope(scope).dismissNativeAgentSuggestedPrompt<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
    return next;
  }, [scope, applyMutationProjection, beginProjectionMutation, identity]);

  const updateControls = useCallback(
    async (update: NativeAgentControlUpdate) => {
      const operationEpoch = beginProjectionMutation();
      const next = await backendForScope(scope).updateNativeAgentControls<TMessage>({
        ...identity,
        update,
      });
      if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
      return next;
    },
    [scope, applyMutationProjection, beginProjectionMutation, identity],
  );

  useEffect(() => {
    if (!matchingSharedProjection || matchingSharedProjection === projectionRef.current) return;
    const current = projectionRef.current;
    if (
      current &&
      current.generation === matchingSharedProjection.generation &&
      matchingSharedProjection.revision < current.revision
    )
      return;
    projectionRef.current = matchingSharedProjection;
    setRuntimeProjection(matchingSharedProjection);
  }, [matchingSharedProjection]);

  const resolveInteraction = useCallback(
    async (
      interactionId: string,
      resolution: AgentInteractionResolution,
    ): Promise<AgentInteractionApplyOutcome> => {
      const outcome = await backendForScope(scope).resolveNativeAgentInteraction({
        ...identity,
        interactionId,
        resolution,
      });
      await refresh();
      return outcome;
    },
    [scope, identity, refresh],
  );

  // A pause moves the deadline where the agent enforces it; the refresh brings
  // the moved deadline back, so every client shows the same state.
  const holdInteraction = useCallback(
    async (interactionId: string, held: boolean): Promise<AgentInteractionApplyOutcome> => {
      const outcome = await backendForScope(scope).holdNativeAgentInteraction({
        ...identity,
        interactionId,
        held,
      });
      await refresh();
      return outcome;
    },
    [scope, identity, refresh],
  );

  // "Approve and remember" (todo 0723): one approval, then the rule is saved
  // by the backend. The refresh drops the answered card.
  const approveInteractionAndRemember = useCallback(
    async (
      interactionId: string,
      choice: PermissionRuleChoiceInput,
    ): Promise<AgentInteractionApplyOutcome> => {
      const { outcome, ruleSaveWarning } = await backendForScope(
        scope,
      ).approveNativeAgentInteractionAndRemember({
        ...identity,
        interactionId,
        ...choice,
      });
      if (ruleSaveWarning) toast.warning(ruleSaveWarning);
      await refresh();
      return outcome;
    },
    [scope, identity, refresh],
  );

  const queueKey = useMemo(() => `${platform}\0${sessionKey}`, [platform, sessionKey]);
  const enqueue = useCallback(
    async (prompt: string, options: NativeAgentSendOptions = {}) => {
      const text = nativeSubmissionText(prompt, options.command);
      if (!text.trim()) throw new Error("Prompt must not be blank");
      await backendForScope(scope).enqueuePromptQueueMessage(queueKey, environmentId, {
        id: options.requestId ?? crypto.randomUUID(),
        text,
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.fastMode === undefined ? {} : { fastMode: options.fastMode }),
        ...(options.subAgent ? { agent: options.subAgent } : {}),
        ...(options.executionAgent ? { executionAgent: options.executionAgent } : {}),
        ...(options.includeLocalSettings === undefined
          ? {}
          : { includeLocalSettings: options.includeLocalSettings }),
        ...(options.promptSuggestions === undefined
          ? {}
          : { promptSuggestions: options.promptSuggestions }),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        // Revalidated by the backend at dequeue, never rebound by name.
        ...(options.command ? { command: options.command } : {}),
        // A coordinator records the user's zone from the prompt the user sent.
        clientTimeZone: hostTimeZone(),
      });
      return refresh();
    },
    [scope, environmentId, queueKey, refresh],
  );
  const removeQueued = useCallback(
    async (messageId: string) => {
      await backendForScope(scope).removePromptQueueMessage(queueKey, environmentId, messageId);
      return refresh();
    },
    [scope, environmentId, queueKey, refresh],
  );
  // Ownership and recovery live in the backend; a lost renderer response must
  // never restore a possibly delivered prompt or abandon its durable source.
  const steerQueued = useCallback(
    async (messageId: string): Promise<NativeAgentSessionActionOutcome | null> => {
      try {
        return await backendForScope(scope).steerNativeAgentQueuedPrompt({
          ...identity,
          messageId,
        });
      } finally {
        await refresh();
      }
    },
    [scope, identity, refresh],
  );
  const moveQueued = useCallback(
    async (messageId: string, direction: "up" | "down") => {
      await backendForScope(scope).movePromptQueueMessage(
        queueKey,
        environmentId,
        messageId,
        direction,
      );
      return refresh();
    },
    [scope, environmentId, queueKey, refresh],
  );
  const retryQueue = useCallback(async () => {
    await backendForScope(scope).retryPromptQueueDispatch(queueKey);
    return refresh();
  }, [scope, queueKey, refresh]);
  const retryRecoverableDispatch = useCallback(async () => {
    const requestId = projectionRef.current?.recoverableDispatch?.requestId;
    if (!requestId) {
      return { outcome: "rejected" as const, error: "There is no recoverable dispatch" };
    }
    beginProjectionMutation();
    setIsDispatching(true);
    try {
      const outcome = await backendForScope(scope).retryNativeAgentDispatch({
        ...identity,
        requestId,
      });
      if (outcome.outcome !== "unknown") pendingDispatchRef.current = null;
      await refresh();
      return outcome;
    } finally {
      setIsDispatching(false);
    }
  }, [scope, beginProjectionMutation, identity, refresh]);
  /**
   * Stop a parked dispatch from blocking the session without re-sending it.
   *
   * The prompt may still have run at the provider, which is exactly why it was
   * parked; discarding says the user accepts that and wants the composer back.
   */
  const discardRecoverableDispatch = useCallback(async () => {
    const requestId = projectionRef.current?.recoverableDispatch?.requestId;
    if (!requestId) return { discarded: false };
    beginProjectionMutation();
    setIsDispatching(true);
    try {
      const outcome = await backendForScope(scope).discardNativeAgentDispatch({
        ...identity,
        requestId,
      });
      pendingDispatchRef.current = null;
      await refresh();
      return outcome;
    } finally {
      setIsDispatching(false);
    }
  }, [scope, beginProjectionMutation, identity, refresh]);
  const listResumable = useCallback(
    (options?: { includeArchived?: boolean }) =>
      backendForScope(scope).listNativeAgentResumableSessions({ ...identity, ...options }),
    [scope, identity],
  );
  const setResumableArchived = useCallback(
    async (resumableSessionId: string, archived: boolean) => {
      await backendForScope(scope).setNativeAgentResumableSessionArchived({
        ...identity,
        resumableSessionId,
        archived,
      });
    },
    [scope, identity],
  );
  const resume = useCallback(
    async (providerSessionId: string, controls?: NativeAgentControlUpdate) => {
      const operationEpoch = beginProjectionMutation();
      const next = await backendForScope(scope).resumeNativeAgentSession<TMessage>({
        ...identity,
        providerSessionId,
        controls,
      });
      if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
      return next;
    },
    [scope, applyMutationProjection, beginProjectionMutation, identity],
  );
  const fork = useCallback(
    (messageId?: string) =>
      backendForScope(scope).forkNativeAgentSession({ ...identity, messageId }),
    [scope, identity],
  );
  const performAction = useCallback(
    async (action: NativeAgentSessionAction) => {
      const outcome = await backendForScope(scope).performNativeAgentSessionAction({
        ...identity,
        action,
      });
      await refresh();
      return outcome;
    },
    [scope, identity, refresh],
  );
  const refreshModels = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const next = await backendForScope(scope).refreshNativeAgentModels<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
    return next;
  }, [scope, applyMutationProjection, beginProjectionMutation, identity]);
  /**
   * Ask the backend to re-read (or reload) this session's command list.
   * The outcome says what actually happened; the projection carries the
   * resulting catalogue state, so the menu renders from authority.
   */
  const refreshCommands = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const result = await backendForScope(scope).refreshNativeAgentCommands<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current && result.projection) {
      applyMutationProjection(result.projection);
    }
    return result;
  }, [scope, applyMutationProjection, beginProjectionMutation, identity]);
  const loadToolDetails = useCallback(
    (detailRef: string): Promise<NativeAgentToolDetails> =>
      backendForScope(scope).getNativeAgentToolDetails({ ...identity, detailRef }),
    [scope, identity],
  );
  /**
   * Widen the transcript window, then reconcile.
   *
   * Grows from whatever the backend actually returned rather than from a local
   * counter, so repeated clicks cannot outrun the provider or ask for a window
   * the session never had.
   *
   * `automatic` is a page nobody clicked for (the tab opening, the reader
   * scrolling near the top). It is served only from a direct cursor the
   * provider pages cheaply, and resolves null without reading anything
   * otherwise: minting a joined cursor, or paging one, reads the whole
   * transcript, which stays behind the button.
   */
  const canLoadEarlierAutomatically = useCallback(
    () =>
      Boolean(historyCursorRef.current) &&
      lastTranscriptViewRef.current?.historyPaging === "direct",
    [],
  );
  const loadEarlierMessages = useCallback(
    async function loadEarlierMessagesPage(options?: {
      automatic?: boolean;
    }): Promise<NativeAgentSessionProjection<TMessage> | null> {
      if (options?.automatic && !canLoadEarlierAutomatically()) return null;
      const requestedOperationEpoch = projectionOperationEpochRef.current;
      await requireNativeAgentProgressiveSync(scope);
      if (!historyCursorRef.current) {
        if (historyUnpageableRef.current) return projectionRef.current;
        /*
         * No direct cursor to page from. With 0232 a pageable provider names one
         * when the byte-bounded view retains a usable whole-message boundary.
         * Joined paging still serves an OpenCode view keeping only a failed
         * message's error row (its main row was byte-omitted), a cursor too
         * long to wrap, a backend before 0232, or a source with no direct pages
         * (the Claude bridge's `/messages` fallback, 0050). It mints a joined
         * cursor from the sync-v1 projection, a whole transcript read, which runs
         * only on a click. A click is the request to mint one even when the
         * live tail reported that it could not page — the joined snapshot is
         * what turns "not shown" into a page. Retirement: version-compatibility.md.
         */
        const update = await backendForScope(scope).getNativeAgentProjectionUpdate<TMessage>({
          ...identity,
          syncVersion: 1,
          liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
          forceSnapshot: true,
        });
        /*
         * Fence before committing, not after. A mutation that landed while the
         * snapshot was in flight owns the transcript now, and installing this
         * plan would rewrite the paging refs from a pre-mutation live tail.
         */
        if (requestedOperationEpoch !== projectionOperationEpochRef.current) {
          return projectionRef.current;
        }
        if (update.status === "snapshot") {
          const live = update.projection;
          if (
            isNativeAgentSessionProjection(live) &&
            live.platform === platform &&
            live.environmentId === environmentId &&
            update.historyCursor
          ) {
            commitSyncMaterialization(
              planSyncMaterialization({
                live,
                token: update.token,
                historyEpoch: update.historyEpoch,
                historyComplete: update.historyComplete,
                boundary: { cursor: update.historyCursor },
              }),
            );
          }
        }
        if (!historyCursorRef.current) {
          /*
           * The joined snapshot could not mint a cursor, and no other read can
           * restore the omitted content, so retire the control on this
           * transcript instead of leaving a repeatable no-op on screen.
           */
          return retireLoadEarlierControl({ sticky: true });
        }
      }
      if (requestedOperationEpoch !== projectionOperationEpochRef.current) {
        return projectionRef.current;
      }
      const before = historyCursorRef.current;
      // A read that landed while the joined snapshot was in flight may have
      // settled the cursor; there is nothing left to page from.
      if (!before) return projectionRef.current;
      /*
       * Free room from inactive identities first, then ask for a page that
       * fits what is left. Bounding the request is what keeps acceptance
       * all-or-nothing: a page trimmed on arrival would strand its older half
       * behind a cursor only the server can mint.
       */
      evictNativeAgentHistoryCaches(
        sessionKey,
        retainedHistoryBytes(historyMessagesRef.current),
        nativeAgentHistoryBudgetBytes(scope),
        scope,
      );
      const budget = historyRequestBudget();
      if (budget.messages <= 0 || budget.bytes <= 0) {
        return retireLoadEarlierControl();
      }
      const pageSequence = ++historyPageSequenceRef.current;
      // A read already in flight answers for the tail before this page; drop it
      // and let the next poll read the tail afresh.
      refreshSequenceRef.current += 1;
      const rowIdentity = (message: TMessage): unknown => (message as { id?: unknown }).id;
      // The held rows as this page found them. A poll that lands while the page
      // is in flight can revise one of them (`revisedMessages`); that copy is
      // newer than the page's, which was read before it.
      const heldAtStart = new Map(
        historyMessagesRef.current.map((message) => [rowIdentity(message), message]),
      );
      const page = await backendForScope(scope).getNativeAgentMessagePage<TMessage>({
        ...identity,
        syncVersion: 1,
        before,
        limit: Math.min(budget.messages, HISTORY_PAGE_MAX_MESSAGES),
        targetBytes: budget.bytes,
      });
      /*
       * A mutation that landed while the page was in flight owns the transcript
       * now, and a later page supersedes this one. Installing it would merge
       * history into a live tail it no longer describes.
       *
       * A poll that landed meanwhile does not retire the page. The page is
       * merged below into whatever live tail is current, and a poll keeps the
       * paging state while the history it describes stands; when it does not
       * (a rotated epoch, a collapse to the live tail), the poll replaced the
       * cursor this page was fetched behind, and that is what fences it.
       * Retiring the page on every poll lost each page slower than the
       * 500–1500 ms cadence, so on a busy host a click on "Load earlier
       * messages" did nothing and automatic paging stalled (flakes 0483, 1602).
       */
      if (
        pageSequence !== historyPageSequenceRef.current ||
        requestedOperationEpoch !== projectionOperationEpochRef.current ||
        historyCursorRef.current !== before
      ) {
        return projectionRef.current;
      }
      const syncLive = syncLiveProjectionRef.current;
      const token = syncTokenRef.current;
      /*
       * `historyEpochRef` and `page.historyEpoch` are both the backend's paging
       * epoch, so a mismatch means the history this cursor described has been
       * rewritten. The token is deliberately not required: a progressive tail
       * pages without ever holding a joined-projection token.
       */
      if (page.historyEpoch !== historyEpochRef.current || !syncLive) {
        resetSyncState();
        await refresh({ manual: true });
        return projectionRef.current;
      }
      const current = projectionRef.current;
      const live =
        current &&
        current.platform === syncLive.platform &&
        current.environmentId === syncLive.environmentId &&
        current.sessionId === syncLive.sessionId &&
        current.generation === syncLive.generation
          ? {
              ...current,
              messages: syncLive.messages,
              ...(syncLive.messageWindow
                ? { messageWindow: syncLive.messageWindow }
                : { messageWindow: undefined }),
            }
          : syncLive;
      const pageMessageId = (message: TMessage): unknown => (message as { id?: unknown }).id;
      const liveIds = new Set(live.messages.map(pageMessageId));
      const held = new Map(
        historyMessagesRef.current.map((message) => [pageMessageId(message), message]),
      );
      /*
       * Holding a row's id is not holding the row. A retained copy is
       * whatever this tab last saw before the row left the live tail: a
       * part-trimmed head, or a launch row whose tasks have since settled.
       * Dropping the page's copy as a duplicate froze that copy for good,
       * so lay it over the held one exactly as a live head is laid over
       * its local copy — whichever carries more of the row wins. The live
       * tail itself stays authoritative for the rows it covers.
       */
      const refreshed = new Map<unknown, TMessage>();
      const newMessages: TMessage[] = [];
      for (const message of page.messages) {
        const id = pageMessageId(message);
        if (liveIds.has(id)) continue;
        const heldCopy = held.get(id);
        if (heldCopy === undefined) {
          newMessages.push(message);
          continue;
        }
        // Revised (or first held) while the page was in flight: the held copy
        // is the newer one, as `reconcileHeldHistory` also rules.
        if (heldAtStart.get(id) !== heldCopy) continue;
        const merged = preferCompleteLiveHead([heldCopy], [message]).messages[0]!;
        if (merged !== heldCopy && JSON.stringify(merged) !== JSON.stringify(heldCopy)) {
          refreshed.set(id, merged);
        }
      }
      /*
       * A direct cursor adopted after messages aged out of the live tail
       * points at the tail's head, so its first pages can hold only rows
       * this client kept on screen. Step past them instead of spending a
       * click on a page that shows nothing; bounded by what the client can
       * retain, so it cannot loop.
       */
      if (
        newMessages.length === 0 &&
        refreshed.size === 0 &&
        page.messages.length > 0 &&
        page.nextCursor &&
        page.nextCursor !== before &&
        duplicatePageSkipsRef.current < MAX_DUPLICATE_PAGE_SKIPS
      ) {
        duplicatePageSkipsRef.current += 1;
        historyCursorRef.current = page.nextCursor;
        return loadEarlierMessagesPage();
      }
      duplicatePageSkipsRef.current = 0;
      const retained = historyMessagesRef.current.map(
        (message) => refreshed.get(pageMessageId(message)) ?? message,
      );
      const accepted: TMessage[] = [];
      const messageBudget = Math.max(0, CLIENT_HISTORY_MAX_MESSAGES - live.messages.length);
      let acceptedBytes = 0;
      for (let index = newMessages.length - 1; index >= 0; index -= 1) {
        if (accepted.length + retained.length >= messageBudget) break;
        const message = newMessages[index]!;
        // Element size plus its separating comma. Measured once: planning
        // and the store reuse the cached size of every accepted message.
        const bytes = encodedValueBytes(message) + 1;
        if (acceptedBytes + bytes > budget.bytes) break;
        accepted.unshift(message);
        acceptedBytes += bytes;
      }
      // One message larger than the whole remaining byte budget would otherwise
      // make the control permanently inert. Take it anyway: the plan below
      // still enforces the retained-history ceiling, and a click must always
      // either show more or stop offering to.
      if (accepted.length === 0 && newMessages.length > 0 && retained.length < messageBudget) {
        accepted.push(newMessages[newMessages.length - 1]!);
      }
      const acceptedWholePage = accepted.length === newMessages.length;
      /*
       * A partially accepted page keeps the cursor it was fetched with.
       * Advancing to `nextCursor` would acknowledge messages that were never
       * retained, and clearing the cursor entirely — the previous behaviour —
       * made them unreachable until the history epoch rotated.
       */
      const plan = planSyncMaterialization({
        live,
        ...(token ? { token } : {}),
        historyEpoch: page.historyEpoch,
        historyComplete: page.complete,
        retained: {
          messages: [...accepted, ...retained],
          ...(acceptedWholePage
            ? page.nextCursor
              ? { cursor: page.nextCursor }
              : {}
            : { cursor: before }),
          complete: page.complete,
        },
      });
      return commitSyncMaterialization(plan);
    },
    [
      scope,
      canLoadEarlierAutomatically,
      commitSyncMaterialization,
      historyRequestBudget,
      identity,
      planSyncMaterialization,
      environmentId,
      platform,
      refresh,
      resetSyncState,
      retireLoadEarlierControl,
      sessionKey,
    ],
  );

  /**
   * Re-read the rows held before the live tail and replace the copies that
   * changed, without taking anything off screen.
   *
   * Walks back from the tail's own cursor until every held row was seen. A poll
   * landing meanwhile keeps authority over any held copy it revises. The walk
   * replaces only unchanged held copies outside the live tail. The debt is settled
   * only if the token did not move during the walk; otherwise, and after a
   * failed read, the rows stay as they are and the next interval tries again.
   */
  const reconcileHeldHistory = useCallback(async () => {
    const view = lastTranscriptViewRef.current;
    const held = projectionRef.current?.messages;
    if (heldHistoryReconcileRunRef.current || !view?.historyCursor || !held) return;
    if (view.historyPaging !== "direct" || progressiveTranscriptTokenRef.current === undefined)
      return;
    // An owed remount requests a fresh snapshot before walking. Its temporary
    // delta base includes held rows, so it cannot yet identify the live tail.
    const run = {};
    heldHistoryReconcileRunRef.current = run;
    heldHistoryReconcileStartedAtRef.current = Date.now();
    const operationEpoch = projectionOperationEpochRef.current;
    const stillCurrent = () =>
      backgroundRefreshEnabledRef.current &&
      heldHistoryReconcileRunRef.current === run &&
      operationEpoch === projectionOperationEpochRef.current &&
      lastTranscriptViewRef.current !== null &&
      sameProgressiveIdentity(lastTranscriptViewRef.current.identity, view.identity) &&
      lastTranscriptViewRef.current.historyEpoch === view.historyEpoch;
    const rowId = (message: TMessage): unknown => (message as { id?: unknown })?.id;
    const liveIds = new Set(view.messages.map(rowId));
    const heldAtStart = new Map(held.map((message) => [rowId(message), message]));
    const unseen = new Set(held.map(rowId).filter((id) => !liveIds.has(id)));
    const fresh = new Map<string, TMessage>();
    const visited = new Set<string>();
    let freshBytes = 0;
    let overflow = false;
    try {
      let before: string | undefined = view.historyCursor;
      // A byte-limited page may contain only one row. The held contiguous
      // prefix bounds the walk by rows, rather than assuming 200 per page.
      for (let pages = 0; before && unseen.size > 0 && pages <= held.length; pages++) {
        if (visited.has(before)) break;
        visited.add(before);
        const page: NativeAgentMessagePage<TMessage> = await backendForScope(
          scope,
        ).getNativeAgentMessagePage<TMessage>({
          ...identity,
          syncVersion: 1,
          before,
          limit: HISTORY_PAGE_MAX_MESSAGES,
          targetBytes: CLIENT_HISTORY_MAX_BYTES,
        });
        if (!stillCurrent() || page.historyEpoch !== view.historyEpoch) return;
        for (const message of page.messages) {
          const id = rowId(message);
          if (typeof id !== "string" || !unseen.delete(id)) continue;
          // A truncated page cannot prove which leading parts were removed.
          // Preserve the held copy instead of replacing it with a content tail.
          if (page.truncated) continue;
          freshBytes += encodedValueBytes(message) + 1;
          if (freshBytes > CLIENT_HISTORY_MAX_BYTES) {
            overflow = true;
            break;
          }
          fresh.set(id, message);
        }
        before = page.nextCursor;
        if (overflow) break;
      }
      const current = projectionRef.current;
      const latest = lastTranscriptViewRef.current;
      if (!current || !latest || !stillCurrent()) return;
      const latestLiveIds = new Set(latest.messages.map(rowId));
      const skip = new Set(
        current.messages
          .filter(
            (message) =>
              latestLiveIds.has(rowId(message)) || heldAtStart.get(rowId(message)) !== message,
          )
          .map(rowId)
          .filter((id): id is string => typeof id === "string"),
      );
      // A delivered revision or a page installed during this walk owns its
      // newer copy, even if the reconciliation token stayed unchanged.
      const retained = overflow ? [] : withRevisedMessages(historyMessagesRef.current, fresh, skip);
      const plan = planSyncMaterialization({
        live: {
          ...current,
          messages: current.messages.filter((message) => latestLiveIds.has(rowId(message))),
          messageWindow: syncLiveProjectionRef.current?.messageWindow,
        },
        token: syncTokenRef.current,
        historyEpoch: historyEpochRef.current,
        historyComplete: historyCompleteRef.current,
        retained: {
          messages: retained,
          cursor: overflow ? historyBoundaryCursorRef.current : historyCursorRef.current,
          complete: historyCompleteRef.current,
        },
      });
      commitSyncMaterialization(plan);
      const settled =
        (plan.historyMessages.length === 0 || !before || unseen.size === 0) &&
        latest.historyReconciliationToken === view.historyReconciliationToken;
      if (settled) {
        heldHistoryReconcileOwedRef.current = false;
        updateProgressiveCache({ heldHistoryReconcileOwed: false });
      }
    } catch {
      // Owed still; the next interval reads again.
    } finally {
      if (heldHistoryReconcileRunRef.current === run) {
        heldHistoryReconcileRunRef.current = null;
        if (heldHistoryReconcileOwedRef.current) {
          setHeldHistoryReconcileSignal((signal) => signal + 1);
        }
      }
    }
  }, [scope, commitSyncMaterialization, identity, planSyncMaterialization, updateProgressiveCache]);

  useEffect(() => {
    if (!enabled || !isActive || !heldHistoryReconcileOwedRef.current) return;
    const timer = setTimeout(
      () => void reconcileHeldHistory(),
      Math.max(
        0,
        heldHistoryReconcileStartedAtRef.current + HELD_HISTORY_RECONCILE_INTERVAL_MS - Date.now(),
      ),
    );
    return () => clearTimeout(timer);
  }, [enabled, heldHistoryReconcileSignal, isActive, reconcileHeldHistory]);

  // A walk begun for a hidden, replaced or unmounted view must not install rows
  // over what its successor has since read.
  useEffect(
    () => () => {
      heldHistoryReconcileRunRef.current = null;
    },
    [enabled, isActive, reconcileHeldHistory],
  );

  return {
    sessionKey,
    projection: effectiveProjection,
    runtimeProjection: effectiveProjection,
    runtimeError,
    resumeSessionReplacement,
    isRefreshing,
    hasCompletedRead,
    transcriptAvailability,
    transcriptRefreshing,
    transcriptError,
    sessionStateAvailability,
    sessionStateRefreshing,
    sessionStateError,
    isDispatching,
    refresh,
    connect,
    send,
    stop,
    stopBackgroundTask,
    dismissSuggestedPrompt,
    updateControls,
    resolveInteraction,
    holdInteraction,
    approveInteractionAndRemember,
    enqueue,
    removeQueued,
    steerQueued,
    moveQueued,
    retryQueue,
    retryRecoverableDispatch,
    discardRecoverableDispatch,
    listResumable,
    setResumableArchived,
    resume,
    fork,
    performAction,
    refreshModels,
    refreshCommands,
    loadToolDetails,
    loadEarlierMessages,
    canLoadEarlierAutomatically,
    initialLaunchOptionsRef,
    initialLaunchOptionsPendingRef,
    acknowledgeInitialLaunchOptions,
    isInitializedRef,
    lastInitTimeRef,
    forkInFlightRef,
  };
}
