import { createHash, randomBytes } from "node:crypto";
import {
  MAX_ACTIVE_SUBAGENTS_PER_SESSION,
  MAX_CURSOR_CHILD_PROMPT_BYTES,
  MAX_MESSAGES,
  MAX_PARTS_PER_MESSAGE,
  MAX_CURSOR_TOOL_REPLAY_PROCESSES,
  MAX_LIVE_CURSOR_TOOL_REPLAYS_PER_TURN,
  MAX_MODEL_ID_BYTES,
  MAX_REPLAY_RECONCILE_TOOLS,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_DIFF_BYTES,
  MAX_TOOL_ID_BYTES,
  MAX_TOOL_INLINE_FILE_BYTES,
  MAX_TOOL_NAME_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_PATH_BYTES,
  MAX_TOOL_TITLE_BYTES,
  MAX_TRANSCRIPT_BYTES,
  CURSOR_TOOL_REPLAY_DELAY_MS,
  RPC_TIMEOUT_MS,
  TRANSCRIPT_CHECK_INTERVAL_BYTES,
  AcpProcess,
  activeCursorToolReplays,
  adjustActiveCursorToolReplays,
  trimmedToolCalls,
  acpToolSourceStates,
  cursorToolReplayProcesses,
  isObject,
  provider,
  sessions,
  shuttingDown,
  workingDirectory,
  type ActiveSubagentDescriptor,
  type AcpReplayToolMetadata,
  type AcpToolReplayCollector,
  type AcpToolSourceState,
  type BridgeMessage,
  type BridgeMessagePart,
  type BridgeToolPart,
  type CursorTodoItem,
  type CursorTodoStatus,
  type JsonObject,
  type SessionState,
  CURSOR_TODO_STATUSES,
} from "./acp-context.js";
import {
  appendSaturating,
  boundTranscript,
  boundedString,
  boundedNullableString,
  boundedToolArguments,
  aggregateAcpToolDiffs,
  contentText,
  failTranscriptLimit,
  isTrimNotice,
  mapAcpToolState,
  trimPartsTo,
  truncateDisplayText,
  turnRequiresCompleteOutput,
  toolArgumentPath,
  toolCallContentDiffs,
  toolCallContentText,
  toolCallLocationPath,
  stringifyToolPayload,
  truncateUtf8,
} from "./acp-transcript.js";
import { schedulePersist } from "./acp-persist-writer.js";

export function pushToolPart(
  state: SessionState,
  owner: BridgeMessage,
  part: BridgeToolPart,
  isInitial: boolean,
): boolean {
  const trimmed = trimmedToolCalls.get(owner);
  if (trimmed?.has(part.toolUseId)) {
    // This call's part was dropped on purpose. Rebuilding it from one late
    // update would append an empty `Tool call` *after* the notice saying
    // those steps went, with none of the title, arguments or output the
    // original carried. A genuinely new call reusing the id still starts.
    if (!isInitial) return false;
    trimmed.delete(part.toolUseId);
  }
  if (owner.parts.length >= MAX_PARTS_PER_MESSAGE) {
    if (turnRequiresCompleteOutput(state)) {
      failTranscriptLimit(state);
      return false;
    }
    state.droppedParts += trimPartsTo(owner, MAX_PARTS_PER_MESSAGE - 1);
    state.transcriptTruncated = true;
  }
  owner.parts.push(part);
  return true;
}

/**
 * Bill the rendered part against the transcript dirty counter and persist.
 * Returns false when a structured turn had to fail because bounding dropped
 * current-message content.
 */
export function commitToolPartMutation(
  state: SessionState,
  part: BridgeToolPart,
  source: AcpToolSourceState,
): boolean {
  state.revision += 1;
  const serializedBytes = Buffer.byteLength(JSON.stringify(part));
  state.uncheckedTranscriptBytes += Math.max(0, serializedBytes - (source.chargedBytes ?? 0));
  source.chargedBytes = serializedBytes;
  const transcriptTruncated =
    state.messages.length > MAX_MESSAGES ||
    state.uncheckedTranscriptBytes >= TRANSCRIPT_CHECK_INTERVAL_BYTES
      ? boundTranscript(state)
      : false;
  if (transcriptTruncated && turnRequiresCompleteOutput(state)) {
    failTranscriptLimit(state);
    return false;
  }
  schedulePersist();
  return true;
}

export function applyToolCallUpdate(
  state: SessionState,
  update: JsonObject,
  isInitial: boolean,
): void {
  if (typeof update.toolCallId !== "string") return;
  const toolCallId = truncateUtf8(update.toolCallId, MAX_TOOL_ID_BYTES);
  if (!toolCallId) return;

  // Incremental transcript reads intentionally re-fetch only the trailing
  // message. Tool updates therefore upsert there as well; mutating an older
  // message would be authoritative in the bridge but invisible to a mounted tab.
  let owner = state.messages.at(-1);
  let part =
    owner?.role === "assistant"
      ? owner.parts.find(
          (messagePart): messagePart is BridgeToolPart =>
            messagePart.type === "tool-invocation" && messagePart.toolUseId === toolCallId,
        )
      : undefined;

  // A background child can outlive the turn and message that launched it.
  // Terminal Cursor updates must target that launch part wherever it remains,
  // while an evicted launch is settled through the authoritative registry
  // below instead of being rebuilt as a context-free ghost part.
  if (!part && state.activeSubagentToolIds.has(toolCallId)) {
    for (let index = state.messages.length - 1; index >= 0 && !part; index -= 1) {
      const candidateOwner = state.messages[index]!;
      const candidate = candidateOwner.parts.find(
        (messagePart): messagePart is BridgeToolPart =>
          messagePart.type === "tool-invocation" && messagePart.toolUseId === toolCallId,
      );
      if (candidate) {
        owner = candidateOwner;
        part = candidate;
      }
    }
    if (!part && !isInitial) {
      if (settleEvictedSubagentFromToolUpdate(state, toolCallId, update)) {
        state.revision += 1;
        schedulePersist();
      }
      return;
    }
  }

  if (!part) {
    owner = currentAssistantMessage(state);
    // Grok often emits ACP `plan` before the matching `todo_write` tool_call.
    // Retarget the synthetic plan row so the turn still has one checklist.
    if (todoToolNameFromUpdate(update)) {
      const synthetic = owner.parts.find(
        (messagePart): messagePart is BridgeToolPart =>
          messagePart.type === "tool-invocation" && messagePart.toolUseId === ACP_PLAN_TOOL_USE_ID,
      );
      if (synthetic) {
        synthetic.toolUseId = toolCallId;
        synthetic.sourcePartId = `tool:${toolCallId}`;
        part = synthetic;
      }
    }
    if (!part) {
      part = {
        type: "tool-invocation",
        content: "Tool call",
        sourcePartId: `tool:${toolCallId}`,
        sourceMessageId: owner.id,
        toolUseId: toolCallId,
        toolState: "pending",
        createdAt: new Date().toISOString(),
      };
      if (!pushToolPart(state, owner, part, isInitial)) return;
    }
  }

  let source = acpToolSourceStates.get(part);
  if (!source) {
    source = {
      title: part.toolTitle,
      explicitName: part.toolName,
      toolArgs: part.toolArgs,
      toolState: part.toolState ?? (isInitial ? "pending" : undefined),
      agentState: part.agentState,
      rawOutput: part.toolOutput,
      contentDiffs: part.toolDiff ? [part.toolDiff] : [],
    };
    acpToolSourceStates.set(part, source);
  }
  applyAcpToolSourcePatch(source, update);
  absorbCursorTodosFromToolArgs(state, source, update);
  renderAcpToolSource(part, source);
  if (part.agentState === "finished" || part.agentState === "failed") {
    stampSubagentRuntimeDuration(part);
  }
  const parentTaskUseId = acpParentTaskUseId(update);
  if (parentTaskUseId && parentTaskUseId !== toolCallId) {
    part.parentTaskUseId = parentTaskUseId;
  }
  syncActiveSubagentTool(state, part);

  if (!commitToolPartMutation(state, part, source)) return;

  // Cursor's live ACP stream intentionally reduces read/search calls to
  // generic labels such as `Read File` and `grep`. Its indexed session replay
  // already has the path, pattern, and descriptive title as soon as the call
  // settles, even while the turn keeps running. Reconcile then so a long turn
  // does not leave every completed call anonymous until the final response.
  // Hydration has the rich replay metadata already and must not recursively
  // spawn another replay process of its own, and a structured turn is excluded
  // because the join re-bounds the transcript without failing it — see
  // `applyReplayToolMetadata`.
  if (
    state.historyReplay === false &&
    state.status === "running" &&
    !turnRequiresCompleteOutput(state) &&
    isSettledToolPart(part) &&
    isGenericCursorToolPart(part)
  ) {
    scheduleCursorToolMetadataReconcile(state);
  }
}

export function collectReplayToolMetadata(
  collector: AcpToolReplayCollector,
  update: JsonObject,
  isInitial: boolean,
): void {
  const id = boundedString(update.toolCallId, MAX_TOOL_ID_BYTES)?.trim();
  if (!id) return;

  let call = collector.byId.get(id);
  if (!call && isInitial) {
    call = { id, retainedBytes: 0 };
    call.retainedBytes = replayToolMetadataBytes(call);
    while (collector.byId.size >= collector.capacity) {
      if (!evictOldestReplayTool(collector, id)) break;
    }
    if (!makeReplayToolRoom(collector, call.retainedBytes, id)) return;
    collector.retainedBytes += call.retainedBytes;
    collector.byId.set(id, call);
  }
  if (!call) return;

  const candidate: AcpReplayToolMetadata = { ...call };
  if ("title" in update) {
    candidate.title = boundedNullableString(update.title, MAX_TOOL_TITLE_BYTES);
  }
  if ("name" in update) {
    candidate.toolName = boundedNullableString(update.name, MAX_TOOL_NAME_BYTES);
  }
  if ("kind" in update && !candidate.toolName) {
    candidate.toolName = boundedNullableString(update.kind, MAX_TOOL_NAME_BYTES);
  }
  if ("rawInput" in update && isObject(update.rawInput)) {
    candidate.toolName ??= boundedString(update.rawInput._toolName, MAX_TOOL_NAME_BYTES);
    candidate.toolArgs = boundedToolArguments(update.rawInput);
  }
  if ("content" in update) {
    candidate.contentOutputHash = replayOutputHash(toolCallContentText(update.content));
  }
  if ("rawOutput" in update) {
    const rawOutput =
      update.rawOutput === null ? undefined : stringifyToolPayload(update.rawOutput);
    candidate.rawOutputHash = replayOutputHash(rawOutput);
  }
  candidate.retainedBytes = replayToolMetadataBytes(candidate);
  const growth = candidate.retainedBytes - call.retainedBytes;
  // Both bounds have to prefer the *newest* calls. Returning here without
  // evicting would keep stale older metadata and silently strip the title and
  // arguments off the call the live turn is most likely to still need.
  if (growth > 0 && !makeReplayToolRoom(collector, growth, id)) return;
  collector.retainedBytes += growth;
  Object.assign(call, candidate);
}

/**
 * Drops the oldest retained call other than `keepId`. Returns false once the
 * collector holds nothing else, so every caller's loop terminates.
 */
export function evictOldestReplayTool(collector: AcpToolReplayCollector, keepId: string): boolean {
  for (const [id, call] of collector.byId) {
    if (id === keepId) continue;
    collector.byId.delete(id);
    collector.retainedBytes -= call.retainedBytes;
    return true;
  }
  return false;
}

/** Frees room for `bytes` more, never at the expense of `keepId` itself. */
export function makeReplayToolRoom(
  collector: AcpToolReplayCollector,
  bytes: number,
  keepId: string,
): boolean {
  while (collector.retainedBytes + bytes > collector.maximumBytes) {
    if (!evictOldestReplayTool(collector, keepId)) break;
  }
  return collector.retainedBytes + bytes <= collector.maximumBytes;
}

export function replayOutputHash(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash("sha256").update(value).digest("hex");
}

export function replayToolMetadataBytes(call: AcpReplayToolMetadata): number {
  return Buffer.byteLength(
    JSON.stringify({
      id: call.id,
      title: call.title,
      toolName: call.toolName,
      toolArgs: call.toolArgs,
      contentOutputHash: call.contentOutputHash,
      rawOutputHash: call.rawOutputHash,
    }),
  );
}

export function orderedReplayTools(collector: AcpToolReplayCollector): AcpReplayToolMetadata[] {
  return [...collector.byId.values()];
}

export function transcriptToolParts(state: SessionState): BridgeToolPart[] {
  return state.messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "tool-invocation" ? [part] : [])),
  );
}

export function normalizedToolKind(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function hasToolArguments(value: JsonObject | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

export function isGenericCursorToolTitle(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "read file" ||
    normalized === "read lints" ||
    normalized === "edit file" ||
    normalized === "grep" ||
    normalized === "find"
  );
}

export function isSettledToolPart(part: BridgeToolPart): boolean {
  return part.toolState === "success" || part.toolState === "failure";
}

export function isGenericCursorToolPart(part: BridgeToolPart): boolean {
  return isGenericCursorToolTitle(part.toolTitle) && !hasToolArguments(part.toolArgs);
}

/**
 * The tool parts a replay may still improve, as a *contiguous suffix* of the
 * transcript's tool calls starting at the oldest one that is still generic.
 *
 * A replay carries the whole session, and the join back onto live parts is
 * positional at heart: the collector keeps the last `capacity` replayed calls
 * and lines them up against the last `capacity` live parts. Scoping targets to
 * the current turn alone would break that alignment as soon as an earlier turn
 * went unenriched — its replayed calls would still occupy the tail while its
 * live parts were excluded. Taking the suffix keeps both sides drawn from the
 * same window, and including the already-enriched parts inside it lets them
 * consume their own replay entries instead of leaving them as false candidates.
 *
 * A live pass (`requireSettled`) drops parts that are still in flight rather
 * than refusing the whole suffix. Cursor indexes a call when it settles, so a
 * pending generic sibling has no replay entry — and used to claim a settled
 * neighbour's through the single-candidate kind fallback. Omitting it, and
 * disabling that fallback on the live join, lets completed reads keep their
 * titles while the agent still has a tool in flight. The final pass keeps the
 * unsettled parts and the fallback so the turn still ends fully enriched.
 */
export function cursorToolReplayTargets(
  state: SessionState,
  options: { requireSettled?: boolean } = {},
): BridgeToolPart[] {
  if (provider !== "cursor") return [];
  const parts = transcriptToolParts(state).slice(-MAX_REPLAY_RECONCILE_TOOLS);
  const firstGeneric = parts.findIndex((part) => isGenericCursorToolPart(part));
  if (firstGeneric === -1) return [];
  const targets = parts.slice(firstGeneric);
  if (!options.requireSettled) return targets;
  const settled = targets.filter((part) => isSettledToolPart(part));
  // A window of only already-enriched parts would spawn a child that cannot
  // apply anything, which is how the per-turn live budget burns on no-ops.
  if (!settled.some((part) => isGenericCursorToolPart(part))) return [];
  return settled;
}

export function applyReplayToolMetadata(
  state: SessionState,
  capturedTargets: readonly BridgeToolPart[],
  collector: AcpToolReplayCollector,
  options: { allowKindFallback?: boolean } = {},
): boolean {
  const liveToolParts = new Set(transcriptToolParts(state));
  const targets = capturedTargets.filter((part) => liveToolParts.has(part));
  const replayed = orderedReplayTools(collector);
  if (targets.length === 0 || replayed.length === 0) return false;
  const unused = new Set(replayed.keys());
  const allowKindFallback = options.allowKindFallback !== false;

  let changed = false;
  // Cursor replays concurrent calls in completion order, while the live stream
  // starts them in launch order. Join on a unique path or normalized output,
  // with a unique tool kind as the final safe fallback on the *final* pass;
  // ambiguous calls stay generic rather than borrowing a neighbour's filename
  // or search pattern. A live pass disables that fallback: a same-kind sibling
  // still in flight has no replay entry yet, so the settled call would look
  // like the only candidate and keep the wrong file permanently.
  for (const part of targets) {
    const targetKind = normalizedToolKind(part.toolName);
    const targetOutputHash = replayOutputHash(part.toolOutput);
    const sameKind = [...unused].filter((index) => {
      const replay = replayed[index];
      if (normalizedToolKind(replay?.toolName) !== targetKind) return false;
      // Outputs known on both sides that disagree are positive evidence of two
      // different calls, so they have to veto the last-resort single-candidate
      // fallback below too — not merely fail to support a match. Otherwise a
      // replay entry the collector dropped for space leaves its neighbour as
      // the only candidate, and the part inherits the wrong file outright.
      const replayHash = replay?.contentOutputHash ?? replay?.rawOutputHash;
      return !(
        targetOutputHash !== undefined &&
        replayHash !== undefined &&
        replayHash !== targetOutputHash
      );
    });
    const targetPath = part.toolDiff?.filePath ?? toolArgumentPath(part.toolArgs);
    const pathMatches = targetPath
      ? sameKind.filter((index) => toolArgumentPath(replayed[index]?.toolArgs) === targetPath)
      : [];
    const outputMatches = targetOutputHash
      ? sameKind.filter((index) => {
          const replay = replayed[index];
          const replayHash = replay?.contentOutputHash ?? replay?.rawOutputHash;
          return replayHash !== undefined && replayHash === targetOutputHash;
        })
      : [];
    const candidateIndexes = pathMatches.length > 0 ? pathMatches : outputMatches;
    const replayIndex =
      candidateIndexes.length === 1
        ? candidateIndexes[0]
        : allowKindFallback && sameKind.length === 1
          ? sameKind[0]
          : undefined;
    if (replayIndex === undefined) continue;
    const replay = replayed[replayIndex];
    if (!replay) continue;
    unused.delete(replayIndex);
    let partChanged = false;
    if (!part.toolName && replay.toolName) {
      part.toolName = replay.toolName;
      partChanged = true;
    }
    if (!hasToolArguments(part.toolArgs) && hasToolArguments(replay.toolArgs)) {
      part.toolArgs = replay.toolArgs;
      partChanged = true;
    }
    if (
      replay.title &&
      isGenericCursorToolTitle(part.toolTitle) &&
      replay.title !== part.toolTitle
    ) {
      const previousTitle = part.toolTitle;
      part.toolTitle = replay.title;
      if (!part.content || part.content === previousTitle) part.content = replay.title;
      partChanged = true;
    }
    if (partChanged) {
      changed = true;
      acpToolSourceStates.delete(part);
    }
  }
  // Re-bound, but never fail. Failing here would cancel and error out a
  // structured turn because some turn's *display* metadata grew, so both
  // schedulers keep `turnRequiresCompleteOutput` false while this runs: the
  // final pass because the settle handler clears `currentTurnOutput` before
  // scheduling it, and a live pass because it is neither armed nor allowed to
  // start inside a structured turn. A structured turn therefore keeps its
  // guarantee that any truncation reaches `failTranscriptLimit`.
  if (changed) boundTranscript(state);
  return changed;
}

export async function reconcileCursorToolMetadata(
  state: SessionState,
  child: AcpProcess,
  targets: readonly BridgeToolPart[],
  promptSequence: number,
  options: { allowKindFallback?: boolean } = {},
): Promise<void> {
  if (
    provider !== "cursor" ||
    shuttingDown ||
    sessions.get(state.id) !== state ||
    state.child !== child ||
    state.promptSequence !== promptSequence ||
    targets.length === 0
  )
    return;
  if (activeCursorToolReplays >= MAX_CURSOR_TOOL_REPLAY_PROCESSES) return;
  const capacity = Math.min(targets.length, MAX_REPLAY_RECONCILE_TOOLS);
  if (capacity === 0) return;
  const collector: AcpToolReplayCollector = {
    capacity,
    maximumBytes: MAX_TRANSCRIPT_BYTES,
    retainedBytes: 0,
    byId: new Map(),
  };
  adjustActiveCursorToolReplays(1);
  let replayChild: AcpProcess | undefined;
  try {
    // Cursor's live ACP process reports generic Read/Grep calls with empty
    // input. A newly attached process replays the same session with its indexed
    // path, pattern and descriptive title; the process that ran the turn does
    // not. Concurrency is capped above so simultaneous turns cannot double the
    // bridge's process count without bound.
    replayChild = new AcpProcess();
    cursorToolReplayProcesses.add(replayChild);
    replayChild.onUpdate = (params) => {
      if (params.sessionId !== state.acpSessionId || !isObject(params.update)) return;
      const update = params.update;
      const kind =
        typeof update.sessionUpdate === "string"
          ? update.sessionUpdate
          : typeof update.type === "string"
            ? update.type
            : "";
      if (kind === "tool_call" || kind === "tool_call_update") {
        collectReplayToolMetadata(collector, update, kind === "tool_call");
      }
    };
    const initialized = await replayChild.initialize();
    const capabilities = isObject(initialized.agentCapabilities)
      ? initialized.agentCapabilities
      : undefined;
    if (capabilities?.loadSession !== true) return;
    await replayChild.request("session/load", {
      cwd: workingDirectory,
      additionalDirectories: [],
      mcpServers: [],
      sessionId: state.acpSessionId,
    });
    // A turn dispatched while this replay was loading may already have been
    // persisted by the agent, in which case its tool calls are in the stream
    // above and the collector's trailing window no longer describes *this*
    // turn. Applying it would hand a later turn's path and title to an earlier
    // turn's part, which nothing afterwards can correct — the part stops
    // looking generic, so the next replay skips it. Drop this pass instead:
    // the newer turn settles into its own replay, and `cursorToolReplayTargets`
    // walks back to the oldest still-generic call, so these parts are picked up
    // there with a window that matches them again.
    if (
      !shuttingDown &&
      sessions.get(state.id) === state &&
      state.child === child &&
      state.promptSequence === promptSequence &&
      applyReplayToolMetadata(state, targets, collector, options)
    ) {
      state.revision += 1;
      schedulePersist();
    }
  } catch {
    // Display enrichment is best-effort. The completed turn remains valid even
    // when an older Cursor build cannot replay its session from a fresh child.
  } finally {
    try {
      await replayChild?.close();
    } finally {
      if (replayChild) cursorToolReplayProcesses.delete(replayChild);
      adjustActiveCursorToolReplays(-1);
    }
  }
}

/** True once this turn has spent its live replay budget. */
export function liveCursorReplayBudgetExhausted(state: SessionState): boolean {
  const used =
    state.cursorToolReplayTurn === state.promptSequence ? (state.cursorToolReplayRuns ?? 0) : 0;
  return used >= MAX_LIVE_CURSOR_TOOL_REPLAYS_PER_TURN;
}

/** Charges one started replay to the turn that is running now. */
export function recordCursorToolReplayRun(state: SessionState): void {
  if (state.cursorToolReplayTurn !== state.promptSequence) {
    state.cursorToolReplayTurn = state.promptSequence;
    state.cursorToolReplayRuns = 0;
  }
  state.cursorToolReplayRuns = (state.cursorToolReplayRuns ?? 0) + 1;
}

/**
 * Coalesces live and end-of-turn Cursor metadata reconciliation per session.
 *
 * A turn can complete several parallel tools in one stdout burst. One detached
 * replay is enough to enrich all of them, so starting a child for every status
 * update would multiply processes and race several identical transcript joins.
 * A call that settles while a replay is already running leaves the request
 * pending and receives one follow-up pass after that child closes.
 *
 * The pending request carries its own mode rather than the caller's urgency,
 * because the two differ: a follow-up scheduled from a finishing replay runs
 * immediately but may still be a *live* pass, and a live pass omits in-flight
 * parts and the kind fallback that the final pass still uses.
 */
export function scheduleCursorToolMetadataReconcile(
  state: SessionState,
  options: { final?: boolean } = {},
): void {
  if (provider !== "cursor" || shuttingDown || sessions.get(state.id) !== state) return;
  // Only live passes are rate-limited. The final pass is the completeness
  // guarantee, so a turn that spent its budget still ends fully enriched.
  if (!options.final && liveCursorReplayBudgetExhausted(state)) return;
  // `final` supersedes a pending `live`; the reverse would narrow a request
  // that was already promised the wider target window.
  if (options.final || !state.cursorToolReplayPending) {
    state.cursorToolReplayPending = options.final ? "final" : "live";
  }
  if (state.cursorToolReplayRunning) return;

  if (state.cursorToolReplayTimer) {
    if (!options.final) return;
    clearTimeout(state.cursorToolReplayTimer);
    state.cursorToolReplayTimer = undefined;
  }

  const run = () => {
    state.cursorToolReplayTimer = undefined;
    if (shuttingDown || sessions.get(state.id) !== state) return;
    const mode = state.cursorToolReplayPending;
    state.cursorToolReplayPending = undefined;
    if (!mode) return;
    // A structured turn started between arming this timer and firing it. The
    // join re-bounds the transcript without failing, which that turn forbids.
    // Dropping the pass is safe: `cursorToolReplayTargets` walks back to the
    // oldest still-generic call, so the next final pass picks these up.
    if (turnRequiresCompleteOutput(state)) return;
    const child = state.child;
    const targets = cursorToolReplayTargets(state, { requireSettled: mode === "live" });
    if (!child || targets.length === 0) return;

    const promptSequence = state.promptSequence;
    recordCursorToolReplayRun(state);
    state.cursorToolReplayRunning = true;
    void reconcileCursorToolMetadata(state, child, targets, promptSequence, {
      allowKindFallback: mode === "final",
    })
      .catch(() => undefined)
      .finally(() => {
        state.cursorToolReplayRunning = false;
        if (state.cursorToolReplayPending) {
          scheduleCursorToolMetadataReconcile(state, {
            final: state.cursorToolReplayPending === "final",
          });
        }
      });
  };

  state.cursorToolReplayTimer = setTimeout(run, options.final ? 0 : CURSOR_TOOL_REPLAY_DELAY_MS);
  state.cursorToolReplayTimer.unref();
}

export function cancelCursorToolMetadataReconcile(state: SessionState): void {
  if (state.cursorToolReplayTimer) clearTimeout(state.cursorToolReplayTimer);
  state.cursorToolReplayTimer = undefined;
  state.cursorToolReplayPending = undefined;
}

/**
 * Nested child tools name their launch call through several vendor `_meta`
 * shapes. The standard ACP schema has no parent field, so this is best-effort
 * capture of ids the frontend already groups on.
 */
export function acpParentTaskUseId(update: JsonObject): string | undefined {
  const candidates: unknown[] = [update.parentToolCallId, update.parent_tool_call_id];
  if (isObject(update._meta)) {
    candidates.push(update._meta.parentToolCallId, update._meta.parent_tool_call_id);
    const claudeCode = isObject(update._meta.claudeCode) ? update._meta.claudeCode : undefined;
    if (claudeCode) {
      candidates.push(claudeCode.parentToolUseId, claudeCode.parent_tool_use_id);
    }
  }
  for (const candidate of candidates) {
    const value = boundedString(candidate, MAX_TOOL_ID_BYTES)?.trim();
    if (value) return value;
  }
  return undefined;
}

export function applyAcpToolSourcePatch(source: AcpToolSourceState, update: JsonObject): void {
  if ("title" in update) {
    source.title = boundedNullableString(update.title, MAX_TOOL_TITLE_BYTES);
  }
  if ("name" in update) {
    source.explicitName = boundedNullableString(update.name, MAX_TOOL_NAME_BYTES);
  }
  if ("kind" in update) {
    source.kind = boundedNullableString(update.kind, MAX_TOOL_NAME_BYTES);
  }
  if ("_meta" in update && isObject(update._meta)) {
    const toolMeta = isObject(update._meta["x.ai/tool"]) ? update._meta["x.ai/tool"] : undefined;
    if (toolMeta) {
      source.metadataName = boundedString(toolMeta.name, MAX_TOOL_NAME_BYTES)?.trim();
      source.metadataKind = boundedString(toolMeta.kind, MAX_TOOL_NAME_BYTES)?.trim();
      // Grok names tools in `_meta["x.ai/tool"]`, not `name`. Promote a todo
      // tool so a synthetic ACP `plan` row (`todo_list`) becomes `todo_write`
      // when the matching call arrives, instead of keeping the plan label.
      if (isAcpTodosToolName(source.metadataName)) {
        source.explicitName = source.metadataName;
      }
    }
  }
  if ("rawInput" in update) {
    if (isObject(update.rawInput)) {
      source.inputName = boundedString(update.rawInput._toolName, MAX_TOOL_NAME_BYTES);
      source.toolArgs = preserveTaskLaunchArgs(
        source.toolArgs,
        boundedToolArguments(update.rawInput),
      );
    } else {
      source.inputName = undefined;
      source.toolArgs = undefined;
    }
  }
  if ("status" in update) {
    // `null` is ACP's explicit "clear this field". An unrecognised status — a
    // value a future protocol revision adds — is not: dropping the state there
    // would leave a part that renders no state at all and that
    // `reconcileStaleToolParts` can never settle. Keep what we already knew.
    const mapped = mapAcpToolState(update.status);
    if (mapped !== undefined) source.toolState = mapped;
    else if (update.status === null) source.toolState = undefined;
  }
  if ("content" in update) {
    source.contentOutput = toolCallContentText(update.content);
    source.contentDiffs = toolCallContentDiffs(update.content);
  }
  if ("locations" in update) {
    source.locationPath = toolCallLocationPath(update.locations);
  }
  if ("rawOutput" in update) {
    source.rawOutput =
      update.rawOutput === null ? undefined : stringifyToolPayload(update.rawOutput);
  }
}

export function renderAcpToolSource(part: BridgeToolPart, source: AcpToolSourceState): void {
  const toolName = source.explicitName ?? source.inputName ?? source.metadataName ?? source.kind;
  setOptionalPartField(part, "toolTitle", source.title);
  setOptionalPartField(part, "toolName", toolName);
  setOptionalPartField(part, "toolArgs", mergeCursorTaskArgs(source.toolArgs, source.cursorTask));
  setOptionalPartField(part, "toolState", source.toolState);
  part.content = source.title ?? toolName ?? "Tool call";

  const output = source.contentOutput ?? source.rawOutput;
  setOptionalPartField(part, "toolOutput", output);
  // Cursor puts `isBackground` in rawOutput even when it also supplies a
  // human-readable content block. That flag is launch mode, not liveness —
  // a later `status: "completed"` in the same object is the child's end.
  // Grok carries the equivalent signal in the Task input and later sends
  // separate subagent lifecycle notifications.
  source.agentState = acpSubagentState(source, source.rawOutput ?? output);
  setOptionalPartField(part, "agentState", source.agentState);
  if (source.agentState === "active") {
    omitActiveSpawnDuration(part, source);
  }
  setOptionalPartField(
    part,
    "toolError",
    source.toolState === "failure" ? (output ?? "Tool call failed") : undefined,
  );

  const diff = aggregateAcpToolDiffs(
    source.contentDiffs,
    source.locationPath ?? toolArgumentPath(source.toolArgs),
  );
  setOptionalPartField(part, "toolDiff", diff);
}

export function acpSubagentState(
  source: AcpToolSourceState,
  output: string | undefined,
): BridgeToolPart["agentState"] | undefined {
  const toolName = (source.explicitName ?? source.inputName ?? source.kind)?.trim();
  const title = source.title?.trim();
  const normalizedToolName = toolName?.toLowerCase();
  const normalizedMetadataName = source.metadataName?.toLowerCase();
  const normalizedMetadataKind = source.metadataKind?.toLowerCase();
  const variant =
    typeof source.toolArgs?.variant === "string"
      ? source.toolArgs.variant.toLowerCase()
      : undefined;
  const isSubagentTool =
    normalizedToolName === "task" ||
    normalizedToolName === "agent" ||
    normalizedMetadataName === "spawn_subagent" ||
    normalizedMetadataKind === "task" ||
    variant === "task" ||
    /\bsub[- ]?agent\b/i.test(title ?? "");
  if (!isSubagentTool && source.agentState === undefined) return undefined;
  if (source.toolState === "failure") return "failed";
  // A vendor may send a late tool projection after its dedicated lifecycle
  // notification. Terminal child state is authoritative and cannot reopen.
  if (source.agentState === "finished" || source.agentState === "failed") {
    return source.agentState;
  }

  let lifecycle: Record<string, unknown> | undefined;
  if (output) {
    try {
      const parsed = JSON.parse(output);
      if (isObject(parsed)) lifecycle = parsed;
    } catch {
      // ACP permits plain-text tool output. The tool status still supplies the
      // foreground lifecycle when no structured background hint is present.
    }
  }

  // A launch hint in the tool's *input* is checked before any status in its
  // output, because the two describe different things: the input says this call
  // detached a child, so the call completing is the launch completing, not the
  // child ending. That is Grok's shape, and Grok reports the child's real end
  // through `subagent_finished` — which lands as `source.agentState` and has
  // already returned above. Reading the launch result's status as the child's
  // would settle the card the moment the spawn succeeded.
  const backgroundLaunch =
    source.toolArgs?.background === true || source.toolArgs?.run_in_background === true;
  if (backgroundLaunch) return "active";
  const reportedState = lifecycleStatus(lifecycle);
  const terminal = terminalAgentState(reportedState);
  if (terminal) return terminal;
  // `isBackground` is launch mode, not liveness, and unlike the input hint above
  // it sits in the same object as the status that supersedes it: Cursor keeps it
  // true on a background Task even after a later update reports
  // `status: "completed"`.
  if (lifecycle?.isBackground === true) return "active";
  if (lifecycle?.isBackground === false) return "finished";
  if (source.toolState === "pending") return "active";
  if (source.toolState === "success") return "finished";
  return source.agentState;
}

/**
 * The render state for a part, rebuilt from the part itself when this process
 * never saw the frames that produced it (a restored transcript, or a vendor
 * frame arriving before any update for that call).
 */
export function ensureAcpToolSource(part: BridgeToolPart): AcpToolSourceState {
  const existing = acpToolSourceStates.get(part);
  if (existing) return existing;
  const source: AcpToolSourceState = {
    title: part.toolTitle,
    explicitName: part.toolName,
    toolArgs: part.toolArgs,
    toolState: part.toolState,
    agentState: part.agentState,
    rawOutput: part.toolOutput,
    contentDiffs: part.toolDiff ? [part.toolDiff] : [],
  };
  acpToolSourceStates.set(part, source);
  return source;
}

/**
 * Stand-in prompt for a Task Cursor has not described yet, recovered from the
 * child's own transcript. It goes to `cursorTask` rather than the part so a
 * later `rawInput` patch cannot wipe it and the real `cursor/task` prompt,
 * when it arrives, replaces it.
 */
export function recordCursorTaskPrompt(part: BridgeToolPart, prompt: string): boolean {
  const bounded = truncateUtf8(prompt.trim(), MAX_CURSOR_CHILD_PROMPT_BYTES);
  if (!bounded) return false;
  const source = ensureAcpToolSource(part);
  if (source.cursorTask?.prompt) return false;
  source.cursorTask = { ...source.cursorTask, prompt: bounded };
  renderAcpToolSource(part, source);
  return true;
}

/** Cursor Task `agentId`, from `cursor/task` args or the launch `rawOutput`. */
export function toolPartAgentId(part: BridgeToolPart): string | undefined {
  if (typeof part.toolArgs?.agentId === "string") {
    return truncateUtf8(part.toolArgs.agentId.trim(), MAX_TOOL_ID_BYTES);
  }
  if (typeof part.toolArgs?.agent_id === "string") {
    return truncateUtf8(part.toolArgs.agent_id.trim(), MAX_TOOL_ID_BYTES);
  }
  const lifecycle = toolCallLifecycle(part.toolOutput);
  if (typeof lifecycle?.agentId === "string") {
    return truncateUtf8(lifecycle.agentId.trim(), MAX_TOOL_ID_BYTES);
  }
  if (typeof lifecycle?.agent_id === "string") {
    return truncateUtf8(lifecycle.agent_id.trim(), MAX_TOOL_ID_BYTES);
  }
  return undefined;
}

export function syncActiveSubagentTool(state: SessionState, part: BridgeToolPart): void {
  if (part.agentState === "active") {
    const agentId = toolPartAgentId(part);
    const activated = activateSubagent(state, part.toolUseId, {
      ...(typeof part.toolArgs?.description === "string"
        ? { description: truncateUtf8(part.toolArgs.description.trim(), MAX_TOOL_TITLE_BYTES) }
        : {}),
      ...(typeof part.toolArgs?.subagent_type === "string"
        ? { subagentType: truncateUtf8(part.toolArgs.subagent_type.trim(), MAX_TOOL_NAME_BYTES) }
        : {}),
      ...(part.toolState ? { toolState: part.toolState } : {}),
      // An id rendered on the tool part came from Cursor's own payload, not
      // transcript-directory inference. Clear the weaker provenance so the
      // background continuation waiter can trust the now-authoritative id.
      ...(agentId ? { agentId, agentIdDiscovered: false } : {}),
    });
    if (!activated) {
      part.agentState = "failed";
      const source = acpToolSourceStates.get(part);
      if (source) source.agentState = "failed";
    }
  } else {
    settleActiveSubagent(state, part.toolUseId);
  }
}

export function indexActiveSubagentsFromTranscript(state: SessionState): void {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type === "tool-invocation" && part.agentState === "active") {
        const source = ensureAcpToolSource(part);
        omitActiveSpawnDuration(part, source);
        syncActiveSubagentTool(state, part);
      }
    }
  }
}

export function activateSubagent(
  state: SessionState,
  toolUseId: string,
  descriptor: ActiveSubagentDescriptor,
): boolean {
  if (state.subagentLimitExceeded) return false;
  if (
    !state.activeSubagentToolIds.has(toolUseId) &&
    state.activeSubagentToolIds.size >= MAX_ACTIVE_SUBAGENTS_PER_SESSION
  ) {
    state.subagentLimitExceeded = true;
    failAllActiveSubagents(state);
    state.status = "error";
    state.error = `${provider} exceeded the active sub-agent limit`;
    state.child?.notify("session/cancel", { sessionId: state.acpSessionId });
    return false;
  }
  const previous = state.activeSubagentDescriptors.get(toolUseId);
  state.activeSubagentToolIds.add(toolUseId);
  state.activeSubagentDescriptors.set(toolUseId, {
    ...previous,
    ...descriptor,
    agentId: descriptor.agentId ?? previous?.agentId,
    description: descriptor.description ?? previous?.description,
    subagentType: descriptor.subagentType ?? previous?.subagentType,
    toolState: descriptor.toolState ?? previous?.toolState,
  });
  return true;
}

export function settleActiveSubagent(state: SessionState, toolUseId: string): void {
  state.activeSubagentToolIds.delete(toolUseId);
  state.activeSubagentDescriptors.delete(toolUseId);
  for (const [subagentId, mappedToolUseId] of state.subagentToolIds) {
    if (mappedToolUseId === toolUseId) state.subagentToolIds.delete(subagentId);
  }
}

export const MAX_CURSOR_TASK_PROMPT_BYTES = 64 * 1024;
export const TASK_LAUNCH_ARG_KEYS = [
  "description",
  "prompt",
  "subagent_type",
  "subagentType",
  "model",
  "agentId",
  "agent_id",
] as const;

/**
 * Cursor's background Task `toolCallCompleted` echoes the spawn wall-clock as
 * `durationMs` on the same `cursor/task` frame that carries launch metadata.
 * That is not child completion: the child is still running, and a later
 * `cursor/task` (or the continuation wrapper) reports the real end with a
 * different duration. Grok never sends `cursor/task`.
 */
export function isCursorBackgroundSpawnDuration(
  source: { toolArgs?: JsonObject; rawOutput?: unknown; contentOutput?: string },
  durationMs: number,
): boolean {
  const lifecycle = isObject(source.rawOutput)
    ? source.rawOutput
    : toolCallLifecycle(source.rawOutput ?? source.contentOutput);
  // Cursor keeps `isBackground: true` on the terminal result. Once that same
  // payload reports a terminal lifecycle, its duration is the child's real
  // runtime rather than the launch tool's spawn wall-clock.
  if (terminalAgentState(lifecycleStatus(lifecycle)) !== undefined) return false;
  const background =
    source.toolArgs?.background === true ||
    source.toolArgs?.run_in_background === true ||
    lifecycle?.isBackground === true;
  if (!background) return false;
  const launchDuration = boundedDurationMs(lifecycle?.durationMs);
  return launchDuration === durationMs;
}

function omitDurationMsField<T extends object>(value: T): Omit<T, "durationMs"> {
  const { durationMs: _durationMs, ...rest } = value as T & { durationMs?: unknown };
  return rest as Omit<T, "durationMs">;
}

/**
 * Cursor echoes spawn wall-clock as `durationMs` on the launch `cursor/task`.
 * That must not become the card's runtime while the child is still active —
 * later `cursor/task` (or `stampSubagentRuntimeDuration`) writes the real end.
 */
export function omitActiveSpawnDuration(
  part: BridgeToolPart,
  source: AcpToolSourceState = ensureAcpToolSource(part),
): void {
  if (part.agentState !== "active" && source.agentState !== "active") return;
  const durationMs = boundedDurationMs(source.cursorTask?.durationMs ?? part.toolArgs?.durationMs);
  if (durationMs === undefined) return;
  if (
    !isCursorBackgroundSpawnDuration(
      {
        toolArgs: source.toolArgs ?? part.toolArgs,
        rawOutput: source.rawOutput ?? part.toolOutput,
        contentOutput: source.contentOutput,
      },
      durationMs,
    )
  )
    return;
  if (source.cursorTask) source.cursorTask = omitDurationMsField(source.cursorTask);
  if (source.toolArgs) source.toolArgs = omitDurationMsField(source.toolArgs);
  if (part.toolArgs) {
    const rest = omitDurationMsField(part.toolArgs);
    setOptionalPartField(part, "toolArgs", Object.keys(rest).length > 0 ? rest : undefined);
  }
}

/**
 * Wall-clock from the backend launch timestamp to now. Used when Cursor did
 * not report a real completion duration (or only echoed spawn time). A vendor
 * duration that is not the spawn echo is the child's own runtime and is kept.
 */
export function stampSubagentRuntimeDuration(part: BridgeToolPart, now = Date.now()): void {
  const source = ensureAcpToolSource(part);
  const projectedDuration = boundedDurationMs(
    source.cursorTask?.durationMs ?? part.toolArgs?.durationMs,
  );
  const lifecycle = toolCallLifecycle(source.rawOutput ?? source.contentOutput);
  const existing = projectedDuration ?? boundedDurationMs(lifecycle?.durationMs);
  const spawnEcho =
    existing !== undefined &&
    isCursorBackgroundSpawnDuration(
      {
        toolArgs: source.toolArgs ?? part.toolArgs,
        rawOutput: source.rawOutput ?? part.toolOutput,
        contentOutput: source.contentOutput,
      },
      existing,
    );
  if (existing !== undefined && !spawnEcho) {
    if (projectedDuration === undefined) {
      source.cursorTask = { ...source.cursorTask, durationMs: existing };
      source.toolArgs = { ...source.toolArgs, durationMs: existing };
      renderAcpToolSource(part, source);
    }
    return;
  }
  const startedAt = part.createdAt ? Date.parse(part.createdAt) : Number.NaN;
  if (!Number.isFinite(startedAt) || startedAt < 0) return;
  const elapsed = Math.max(0, Math.floor(now - startedAt));
  source.cursorTask = { ...source.cursorTask, durationMs: elapsed };
  source.toolArgs = { ...source.toolArgs, durationMs: elapsed };
  renderAcpToolSource(part, source);
}

/**
 * `durationMs` is the one `cursor/task` field that decides lifecycle once a
 * named state is absent: a present value settles the sub-agent as finished
 * unless it is the background spawn echo (see `isCursorBackgroundSpawnDuration`).
 * A bare `Number()` would coerce `null`, `false`, `""` and `[]` to `0`, so a
 * vendor encoding "not finished yet" as `null` would report a live background
 * child as complete and drop it out of `activeSubagentToolIds`. Only a real
 * number — or a numeric string, which the renderer also accepts — counts as a
 * reported duration.
 */
export function boundedDurationMs(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.floor(numeric);
}

export function cursorSubagentTypeLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return boundedString(value, MAX_TOOL_NAME_BYTES)?.trim();
  }
  if (isObject(value) && typeof value.custom === "string") {
    return boundedString(value.custom, MAX_TOOL_NAME_BYTES)?.trim();
  }
  return undefined;
}

/**
 * Cursor's Task `rawInput` is often just `{ _toolName: "task" }`. A later
 * status patch must not erase the description/prompt that `cursor/task` added.
 */
export function preserveTaskLaunchArgs(
  previous: JsonObject | undefined,
  next: JsonObject,
): JsonObject {
  const merged: JsonObject = { ...next };
  if (!previous) return merged;
  for (const key of TASK_LAUNCH_ARG_KEYS) {
    if (merged[key] == null && typeof previous[key] === "string" && previous[key].trim()) {
      merged[key] = previous[key];
    }
  }
  if (
    merged.durationMs == null &&
    typeof previous.durationMs === "number" &&
    Number.isFinite(previous.durationMs) &&
    previous.durationMs >= 0
  ) {
    merged.durationMs = previous.durationMs;
  }
  // Cursor's live `updateTodos` tool_call is typically `{ _toolName: "updateTodos" }`.
  // The list arrives on `cursor/update_todos`; a later empty rawInput must not
  // wipe it the way a later Task status patch must not wipe `cursor/task`.
  const incomingHasTodos = Array.isArray(merged.todos);
  if (!incomingHasTodos && Array.isArray(previous.todos)) {
    merged.todos = previous.todos;
  }
  // Inherit merge only with that preserved list. A Grok `todo_write` that omits
  // merge after an ACP plan stamped `merge: false` must keep Grok's default
  // (merge) rather than replacing the plan with the write's delta.
  if (merged.merge == null && typeof previous.merge === "boolean" && !incomingHasTodos) {
    merged.merge = previous.merge;
  }
  return merged;
}

export function mergeCursorTaskArgs(
  toolArgs: JsonObject | undefined,
  cursorTask: AcpToolSourceState["cursorTask"],
): JsonObject | undefined {
  if (!cursorTask) return toolArgs;
  const merged: JsonObject = { ...toolArgs };
  if (cursorTask.description) merged.description = cursorTask.description;
  if (cursorTask.prompt) merged.prompt = cursorTask.prompt;
  if (cursorTask.subagentType) merged.subagent_type = cursorTask.subagentType;
  if (cursorTask.durationMs !== undefined) merged.durationMs = cursorTask.durationMs;
  if (cursorTask.model) merged.model = cursorTask.model;
  if (cursorTask.agentId) merged.agentId = cursorTask.agentId;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export const MAX_CURSOR_TODOS = 200;

/** Upper bound on entries examined per list, so parsing stays bounded too. */
export const MAX_CURSOR_TODO_CANDIDATES = MAX_CURSOR_TODOS * 8;

/** Synthetic tool call id for an ACP `plan` / `plan_update` with no matching todo tool. */
export const ACP_PLAN_TOOL_USE_ID = "acp-plan";

const CURSOR_TODO_STATUS_SET = new Set<string>(CURSOR_TODO_STATUSES);

export function acpToolSourceName(
  source: Pick<AcpToolSourceState, "explicitName" | "inputName" | "metadataName" | "kind">,
): string | undefined {
  return source.explicitName ?? source.inputName ?? source.metadataName ?? source.kind;
}

export function isCursorTodosToolName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "updatetodos" || normalized === "update_todos";
}

export function isGrokTodoWriteToolName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "todo_write" || normalized === "todowrite";
}

export function isAcpTodosToolName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    isCursorTodosToolName(value) || isGrokTodoWriteToolName(value) || normalized === "todo_list"
  );
}

function mergeFlagForTodoTool(toolName: string | undefined, merge: unknown): boolean {
  if (isGrokTodoWriteToolName(toolName)) return merge !== false;
  return merge === true;
}

function todoToolNameFromUpdate(update: JsonObject): string | undefined {
  if (typeof update.name === "string" && isAcpTodosToolName(update.name)) return update.name;
  if (
    isObject(update.rawInput) &&
    typeof update.rawInput._toolName === "string" &&
    isAcpTodosToolName(update.rawInput._toolName)
  ) {
    return update.rawInput._toolName;
  }
  if (isObject(update._meta) && isObject(update._meta["x.ai/tool"])) {
    const name = update._meta["x.ai/tool"].name;
    if (typeof name === "string" && isAcpTodosToolName(name)) return name;
  }
  if (isObject(update.rawInput) && Array.isArray(update.rawInput.todos)) return "todo_write";
  return undefined;
}

function defaultTodoToolTitle(toolName: string | undefined): string {
  if (isGrokTodoWriteToolName(toolName)) return "Todo Write";
  if (toolName?.trim().toLowerCase() === "todo_list") return "Todo List";
  return "Update TODOs";
}

export function parseCursorTodos(value: unknown): CursorTodoItem[] {
  if (!Array.isArray(value)) return [];
  const parsed: Array<{ id?: string; content: string; status: CursorTodoStatus }> = [];
  for (const candidate of value) {
    // The output is capped at `MAX_CURSOR_TODOS`, but ids have to be reserved
    // before any fallback is allocated, so the candidate pass is bounded too
    // rather than materialising a whole 4MB frame's worth of entries. The
    // headroom leaves room for later entries that overwrite an earlier id.
    if (parsed.length >= MAX_CURSOR_TODO_CANDIDATES) break;
    if (!isObject(candidate)) continue;
    const content = boundedString(candidate.content, MAX_TOOL_TITLE_BYTES)?.trim();
    const status = typeof candidate.status === "string" ? candidate.status : "";
    if (!content || !CURSOR_TODO_STATUS_SET.has(status)) continue;
    const id = boundedString(candidate.id, MAX_TOOL_ID_BYTES)?.trim();
    parsed.push({
      ...(id ? { id } : {}),
      content,
      status: status as CursorTodoStatus,
    });
  }
  // Reserve explicit ids first so a missing id cannot reuse `items.length + 1`
  // and overwrite a neighbour (ACP plan entries often have no id).
  const taken = new Set<string>();
  for (const item of parsed) {
    if (item.id) taken.add(item.id);
  }
  const indexes = new Map<string, number>();
  const items: CursorTodoItem[] = [];
  let nextFallback = 1;
  const allocateFallbackId = (): string => {
    while (taken.has(String(nextFallback))) nextFallback += 1;
    const id = String(nextFallback);
    nextFallback += 1;
    taken.add(id);
    return id;
  };
  for (const candidate of parsed) {
    const id = candidate.id ?? allocateFallbackId();
    const item: CursorTodoItem = {
      id,
      content: candidate.content,
      status: candidate.status,
    };
    const existing = indexes.get(id);
    if (existing !== undefined) {
      items[existing] = item;
      continue;
    }
    if (items.length >= MAX_CURSOR_TODOS) continue;
    indexes.set(id, items.length);
    items.push(item);
  }
  return items;
}

/**
 * ACP v1 `sessionUpdate: "plan"` carries `entries[]`. v2 `plan_update` nests
 * them at `plan.entries`. Both are a full replace of the current plan.
 */
export function parseAcpPlanEntries(update: JsonObject): CursorTodoItem[] | undefined {
  const entries = Array.isArray(update.entries)
    ? update.entries
    : isObject(update.plan) && Array.isArray(update.plan.entries)
      ? update.plan.entries
      : undefined;
  if (entries === undefined) return undefined;
  return parseCursorTodos(entries);
}

export function mergeCursorTodos(
  current: readonly CursorTodoItem[],
  incoming: readonly CursorTodoItem[],
  merge: boolean,
): CursorTodoItem[] {
  if (!merge) return incoming.slice(0, MAX_CURSOR_TODOS);
  const byId = new Map(current.map((item) => [item.id, item]));
  const order = current.map((item) => item.id);
  for (const item of incoming) {
    if (!byId.has(item.id)) order.push(item.id);
    byId.set(item.id, item);
  }
  return order
    .flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    })
    .slice(0, MAX_CURSOR_TODOS);
}

export function restoreCursorTodosFromMessages(
  messages: readonly BridgeMessage[],
): CursorTodoItem[] {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex]!.parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]!;
      if (part.type !== "tool-invocation" || !Array.isArray(part.toolArgs?.todos)) continue;
      // Match what the live path absorbs. `stampCursorTodos` forces a todo tool
      // name onto every part it writes, so anything else carrying a `todos`
      // argument is a different tool whose list must not seed this session.
      if (!isAcpTodosToolName(part.toolName)) continue;
      const parsed = parseCursorTodos(part.toolArgs.todos);
      if (parsed.length > 0 || part.toolArgs.merge === false) return parsed;
    }
  }
  return [];
}

export function stampCursorTodos(
  source: AcpToolSourceState,
  state: SessionState,
  merge: boolean,
): void {
  source.toolArgs = {
    ...source.toolArgs,
    todos: state.cursorTodos,
    merge,
  };
  if (!isAcpTodosToolName(acpToolSourceName(source))) {
    source.explicitName = "updateTodos";
  }
  if (!source.title) source.title = defaultTodoToolTitle(acpToolSourceName(source));
}

/**
 * Absorb only a list this update actually carried on the wire. `toolArgs` also
 * holds the snapshot `stampCursorTodos` wrote onto this part, and a later
 * status-only patch re-absorbing that snapshot would merge an older list back
 * over a newer one — reverting statuses and rewriting the older row to show
 * todos it never had.
 */
export function absorbCursorTodosFromToolArgs(
  state: SessionState,
  source: AcpToolSourceState,
  update: JsonObject,
): void {
  if (!isObject(update.rawInput) || !Array.isArray(update.rawInput.todos)) return;
  const toolName = acpToolSourceName(source);
  if (!isAcpTodosToolName(toolName) || !Array.isArray(source.toolArgs?.todos)) return;
  const incoming = parseCursorTodos(source.toolArgs.todos);
  const merge = mergeFlagForTodoTool(toolName, source.toolArgs.merge);
  if (incoming.length === 0 && merge) return;
  state.cursorTodos = mergeCursorTodos(state.cursorTodos, incoming, merge);
  stampCursorTodos(source, state, merge);
}

/**
 * Cursor reports the todo list through `cursor/update_todos`, not the live
 * `updateTodos` tool_call. That call's `rawInput` is typically just
 * `{ _toolName: "updateTodos" }` with title `Update TODOs`, which is why the
 * renderer used to show a generic wrench row and no tasks.
 *
 * Observed contract (Cursor ACP docs, `cursor/update_todos`):
 *
 * - Documented as a notification. Cursor's `extMethod` helper still sends
 *   `cursor/task` as a request, so this method is acknowledged the same way
 *   when it arrives as one.
 * - Payload is `toolCallId`, `todos[]` (`id`, `content`, `status`), `merge`.
 * - `merge: true` updates matching ids and appends new ones. `merge: false`
 *   replaces the whole list, including an empty replacement.
 */
export function applyCursorUpdateTodos(state: SessionState, params: JsonObject): void {
  if (state.historyReplay === "ignore") return;
  if (params.sessionId !== undefined && params.sessionId !== state.acpSessionId) return;
  const payload = isObject(params.update) ? params.update : params;
  const toolCallId = boundedString(payload.toolCallId, MAX_TOOL_ID_BYTES)?.trim();
  if (!toolCallId || !Array.isArray(payload.todos)) return;

  const incoming = parseCursorTodos(payload.todos);
  const merge = payload.merge === true;
  if (incoming.length === 0 && merge && state.cursorTodos.length === 0) return;
  state.cursorTodos = mergeCursorTodos(state.cursorTodos, incoming, merge);

  let found = findToolPart(state, toolCallId);
  if (!found) {
    const owner = currentAssistantMessage(state);
    const part: BridgeToolPart = {
      type: "tool-invocation",
      content: "Update TODOs",
      sourcePartId: `tool:${toolCallId}`,
      sourceMessageId: owner.id,
      toolUseId: toolCallId,
      toolName: "updateTodos",
      toolTitle: "Update TODOs",
      toolState: "success",
    };
    if (!pushToolPart(state, owner, part, false)) return;
    found = { owner, part };
  }

  const { part } = found;
  let source = acpToolSourceStates.get(part);
  if (!source) {
    source = {
      title: part.toolTitle,
      explicitName: part.toolName,
      toolArgs: part.toolArgs,
      toolState: part.toolState ?? "success",
      agentState: part.agentState,
      rawOutput: part.toolOutput,
      contentDiffs: part.toolDiff ? [part.toolDiff] : [],
    };
    acpToolSourceStates.set(part, source);
  }
  stampCursorTodos(source, state, merge);
  if (source.toolState === undefined) source.toolState = "success";
  renderAcpToolSource(part, source);
  commitToolPartMutation(state, part, source);
}

function isCurrentTodoToolPart(part: BridgeMessagePart): part is BridgeToolPart {
  if (part.type !== "tool-invocation") return false;
  if (part.toolUseId === ACP_PLAN_TOOL_USE_ID) return true;
  if (isAcpTodosToolName(part.toolName)) return true;
  const source = acpToolSourceStates.get(part);
  return source !== undefined && isAcpTodosToolName(acpToolSourceName(source));
}

function findCurrentAcpTodoPart(
  state: SessionState,
): { owner: BridgeMessage; part: BridgeToolPart } | undefined {
  const owner = state.messages.at(-1);
  if (!owner || owner.role !== "assistant") return undefined;
  for (let index = owner.parts.length - 1; index >= 0; index -= 1) {
    const part = owner.parts[index]!;
    if (isCurrentTodoToolPart(part)) return { owner, part };
  }
  return undefined;
}

/**
 * ACP `plan` / `plan_update` is the agent's current execution plan. Unlike
 * Cursor `cursor/update_todos`, it is always a full replace and entries often
 * have no `id`. Stamp onto the trailing assistant message's existing todo part
 * when one exists so a Grok `todo_write` plus plan in the same turn is one row.
 */
export function applyAcpPlanUpdate(state: SessionState, update: JsonObject): void {
  if (state.historyReplay === "ignore") return;
  const incoming = parseAcpPlanEntries(update);
  if (incoming === undefined) return;
  state.cursorTodos = incoming;

  let found = findCurrentAcpTodoPart(state);
  if (!found) {
    if (incoming.length === 0) {
      state.revision += 1;
      schedulePersist();
      return;
    }
    const owner = currentAssistantMessage(state);
    const part: BridgeToolPart = {
      type: "tool-invocation",
      content: "Todo List",
      sourcePartId: `tool:${ACP_PLAN_TOOL_USE_ID}`,
      sourceMessageId: owner.id,
      toolUseId: ACP_PLAN_TOOL_USE_ID,
      toolName: "todo_list",
      toolTitle: "Todo List",
      toolState: "success",
    };
    if (!pushToolPart(state, owner, part, false)) return;
    found = { owner, part };
  }

  const { part } = found;
  let source = acpToolSourceStates.get(part);
  if (!source) {
    source = {
      title: part.toolTitle ?? "Todo List",
      explicitName: isAcpTodosToolName(part.toolName) ? part.toolName : "todo_list",
      toolArgs: part.toolArgs,
      toolState: part.toolState ?? "success",
      agentState: part.agentState,
      rawOutput: part.toolOutput,
      contentDiffs: part.toolDiff ? [part.toolDiff] : [],
    };
    acpToolSourceStates.set(part, source);
  }
  stampCursorTodos(source, state, false);
  if (source.toolState === undefined) source.toolState = "success";
  renderAcpToolSource(part, source);
  commitToolPartMutation(state, part, source);
}

export function findToolPart(
  state: SessionState,
  toolUseId: string,
): { owner: BridgeMessage; part: BridgeToolPart } | undefined {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const owner = state.messages[index]!;
    const part = owner.parts.find(
      (messagePart): messagePart is BridgeToolPart =>
        messagePart.type === "tool-invocation" && messagePart.toolUseId === toolUseId,
    );
    if (part) return { owner, part };
  }
  return undefined;
}

/**
 * Cursor reports sub-agent identity through `cursor/task`, not nested ACP
 * tool_calls. The live Task tool is typically titled "Task: Subagent task"
 * with empty input; this notification is what carries description, prompt,
 * type, and duration.
 *
 * Observed in `cursor-agent` 2026.08.11-e8db854 (`src/acp/agent-session.ts`,
 * `src/acp/types.ts`):
 *
 * - It is sent through `extMethod`, which is `sendRequest` — so on the wire it
 *   is a **request**, despite Cursor naming its own helper
 *   `sendNonBlockingExtensionNotification`. `extNotification` sits beside it
 *   unused. The notification form is still accepted here because that naming
 *   says which way Cursor intends to move, and a notification costs nothing.
 * - Cursor discards the response: the helper only `.catch()`es, and the SDK
 *   does not validate the result. Even a `-32601` is just a debug log there.
 * - The payload is `toolCallId`, `description`, `prompt`, `subagentType`,
 *   `model`, `agentId`, `durationMs`. There is **no status or outcome field**,
 *   and `durationMs` is populated only when the tool result case is `success`.
 * - The one send site is `toolCallCompleted`, immediately after the
 *   `status: "completed"` tool call update. A frame with no duration and no
 *   named state is still launch metadata, not an ending. `durationMs` is the
 *   observed completion field *except* when it equals the background launch
 *   tool's own `durationMs` — that is spawn time, not the child's end. The
 *   launch tool itself resolves with `isBackground: true` still set, which is
 *   why that flag cannot be read as liveness.
 *
 * The status/outcome handling below is therefore forward-compatibility, not an
 * observed contract: it is written so that a future Cursor which does start
 * reporting a state cannot be read as an ending unless it says so. A named
 * non-terminal state is a progress report and must not settle a live child.
 */
export function applyCursorTask(state: SessionState, params: JsonObject): void {
  if (params.sessionId !== undefined && params.sessionId !== state.acpSessionId) return;
  const payload = isObject(params.update) ? params.update : params;
  const toolCallId = boundedString(payload.toolCallId, MAX_TOOL_ID_BYTES)?.trim();
  if (!toolCallId) return;

  const description = boundedString(payload.description, MAX_TOOL_TITLE_BYTES)?.trim();
  const prompt = boundedString(payload.prompt, MAX_CURSOR_TASK_PROMPT_BYTES)?.trim();
  const subagentType = cursorSubagentTypeLabel(payload.subagentType ?? payload.subagent_type);
  const model = boundedString(payload.model, MAX_TOOL_NAME_BYTES)?.trim();
  const agentId = boundedString(payload.agentId ?? payload.agent_id, MAX_TOOL_ID_BYTES)?.trim();
  const durationMs = boundedDurationMs(payload.durationMs);
  const namedState = cursorTaskNamedState(payload);
  if (
    !description &&
    !prompt &&
    !subagentType &&
    !model &&
    !agentId &&
    durationMs === undefined &&
    namedState === undefined
  ) {
    return;
  }

  const isProgress = namedState === "progress";
  let agentState: "finished" | "failed" | undefined = isProgress ? undefined : namedState;

  let found = findToolPart(state, toolCallId);
  const sourcePeek = found?.part ? acpToolSourceStates.get(found.part) : undefined;
  const spawnEcho =
    durationMs !== undefined &&
    isCursorBackgroundSpawnDuration(
      {
        toolArgs: sourcePeek?.toolArgs ?? found?.part?.toolArgs,
        rawOutput: sourcePeek?.rawOutput ?? found?.part?.toolOutput,
      },
      durationMs,
    );
  if (!agentState && !isProgress && durationMs !== undefined && !spawnEcho) {
    agentState = "finished";
  }
  if (!found) {
    if (state.activeSubagentToolIds.has(toolCallId)) {
      if (agentState) finishSubagentTool(state, toolCallId, agentState);
      return;
    }
    // A terminal or progress frame for an id that is not a live child must not
    // invent a launch part while other children are running.
    if ((agentState || isProgress) && state.activeSubagentToolIds.size > 0) return;

    const owner = currentAssistantMessage(state);
    const part: BridgeToolPart = {
      type: "tool-invocation",
      content: description ?? "Task",
      sourcePartId: `tool:${toolCallId}`,
      sourceMessageId: owner.id,
      toolUseId: toolCallId,
      toolName: "task",
      toolState: agentState === "finished" ? "success" : "pending",
      agentState: agentState ?? "active",
      createdAt: new Date().toISOString(),
    };
    // Not an initial `tool_call`: a late `cursor/task` for a trimmed id must
    // not rebuild the evicted launch as a context-free ghost part.
    if (!pushToolPart(state, owner, part, false)) {
      if (agentState) finishSubagentTool(state, toolCallId, agentState);
      return;
    }
    found = { owner, part };
  } else if (
    !state.activeSubagentToolIds.has(toolCallId) &&
    found.part.agentState === undefined &&
    (agentState || isProgress)
  ) {
    // Only a call that was never a sub-agent launch is rejected here. "Already
    // settled" cannot be the test: Cursor sends this frame *after* the tool
    // call update that completes the launch, so a foreground Task — where the
    // tool spans the child's whole life — is always finished by the time its
    // description, prompt and `agentId` arrive. Dropping those left the card
    // permanently anonymous and, with no `agentId`, unable to find the
    // transcript the child had already written. The settled state itself is
    // still protected: the terminal check below refuses to reopen or reverse it.
    return;
  }

  const { part } = found;
  const source = ensureAcpToolSource(part);
  source.cursorTask = {
    ...source.cursorTask,
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(subagentType ? { subagentType } : {}),
    // Spawn wall-clock is not child runtime. Keep it off the card until settle
    // stamps launch-to-end, or a later frame reports a different duration.
    ...(durationMs !== undefined && !spawnEcho ? { durationMs } : {}),
    ...(model ? { model } : {}),
    ...(agentId ? { agentId } : {}),
  };
  if (agentState && source.agentState !== "finished" && source.agentState !== "failed") {
    source.agentState = agentState;
    if (
      agentState === "finished" &&
      (source.toolState === "pending" || source.toolState === undefined)
    ) {
      source.toolState = "success";
    }
  }
  renderAcpToolSource(part, source);
  if (part.agentState === "finished" || part.agentState === "failed") {
    stampSubagentRuntimeDuration(part);
  }
  syncActiveSubagentTool(state, part);
  commitToolPartMutation(state, part, source);
}

export function failAllActiveSubagents(state: SessionState): void {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation" || !state.activeSubagentToolIds.has(part.toolUseId))
        continue;
      part.agentState = "failed";
      const source = acpToolSourceStates.get(part);
      if (source) source.agentState = "failed";
      stampSubagentRuntimeDuration(part);
    }
  }
  state.activeSubagentToolIds.clear();
  state.activeSubagentDescriptors.clear();
  state.subagentToolIds.clear();
}

export function settleEvictedSubagentFromToolUpdate(
  state: SessionState,
  toolUseId: string,
  update: JsonObject,
): boolean {
  const toolState = mapAcpToolState(update.status);
  if (toolState === "failure") {
    settleActiveSubagent(state, toolUseId);
    return true;
  }
  const lifecycle = isObject(update.rawOutput)
    ? update.rawOutput
    : toolCallLifecycle(update.rawOutput ?? update.content);
  const reportedState = lifecycleStatus(lifecycle);
  if (lifecycle?.isBackground === true && terminalAgentState(reportedState) === undefined) {
    return false;
  }
  if (lifecycle?.isBackground === false || terminalAgentState(reportedState) !== undefined) {
    settleActiveSubagent(state, toolUseId);
    return true;
  }
  return false;
}

export function toolCallLifecycle(value: unknown): JsonObject | undefined {
  const text = stringifyToolPayload(value);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function applySubagentSpawned(state: SessionState, update: JsonObject): void {
  const subagentId = boundedString(update.subagent_id, MAX_TOOL_ID_BYTES)?.trim();
  if (!subagentId || state.subagentToolIds.has(subagentId)) return;

  const claimedToolIds = new Set(state.subagentToolIds.values());
  const description = boundedString(update.description, MAX_TOOL_TITLE_BYTES)?.trim();
  const subagentType = boundedString(update.subagent_type, MAX_TOOL_NAME_BYTES)?.trim();
  const candidates = [...state.activeSubagentDescriptors.entries()].filter(
    ([toolUseId]) => !claimedToolIds.has(toolUseId),
  );
  const matched = candidates.find(
    ([, descriptor]) =>
      (!description || descriptor.description === description) &&
      (!subagentType || descriptor.subagentType === subagentType),
  );
  // With metadata present, a mismatch is not permission to claim an unrelated
  // child. Metadata-free events are safe only when exactly one candidate exists.
  const selected =
    matched ??
    (!description && !subagentType && candidates.length === 1 ? candidates[0] : undefined);

  if (selected) state.subagentToolIds.set(subagentId, selected[0]);
}

export function applySubagentFinished(state: SessionState, update: JsonObject): void {
  const subagentId = boundedString(update.subagent_id, MAX_TOOL_ID_BYTES)?.trim();
  if (!subagentId) return;
  const toolUseId = state.subagentToolIds.get(subagentId);
  if (!toolUseId) return;
  finishSubagentTool(
    state,
    toolUseId,
    terminalAgentState(typeof update.status === "string" ? update.status : undefined) ?? "finished",
  );
}

export function finishSubagentTool(
  state: SessionState,
  toolUseId: string,
  agentState: "finished" | "failed",
): void {
  const part = findToolPart(state, toolUseId)?.part;
  if (part && part.agentState !== "finished" && part.agentState !== "failed") {
    part.agentState = agentState;
    const source = acpToolSourceStates.get(part);
    if (source) source.agentState = agentState;
    stampSubagentRuntimeDuration(part);
  }
  settleActiveSubagent(state, toolUseId);
  state.revision += 1;
  schedulePersist();
}

export function lifecycleStatus(lifecycle: JsonObject | undefined): string | undefined {
  if (typeof lifecycle?.status === "string") return lifecycle.status;
  if (typeof lifecycle?.state === "string") return lifecycle.state;
  return undefined;
}

export function terminalAgentState(status: string | undefined): "finished" | "failed" | undefined {
  if (!status) return undefined;
  if (/^(failed|killed|cancelled|canceled|error|rejected|aborted|abort)$/i.test(status))
    return "failed";
  if (/^(completed|finished|done|success)$/i.test(status)) return "finished";
  return undefined;
}

/**
 * Named status/outcome on a `cursor/task` frame.
 *
 * Cursor today sends neither field — `durationMs` is the observed completion
 * signal except for the background spawn echo (see `applyCursorTask`). A
 * *present* but non-terminal state is a progress report and must be
 * distinguishable from an absent one, or it would settle a running child.
 * That is why this cannot default to `"finished"` the way the
 * by-definition-terminal `subagent_finished` notification does.
 */
export function cursorTaskNamedState(
  payload: JsonObject,
): "finished" | "failed" | "progress" | undefined {
  const outcome =
    typeof payload.outcome === "string"
      ? payload.outcome
      : isObject(payload.outcome) && typeof payload.outcome.outcome === "string"
        ? payload.outcome.outcome
        : undefined;
  const status = typeof payload.status === "string" ? payload.status : undefined;
  if (outcome === undefined && status === undefined) return undefined;
  return terminalAgentState(outcome) ?? terminalAgentState(status) ?? "progress";
}

export function setOptionalPartField<TKey extends keyof BridgeToolPart>(
  part: BridgeToolPart,
  key: TKey,
  value: BridgeToolPart[TKey] | undefined,
): void {
  if (value === undefined) delete part[key];
  else part[key] = value;
}

export function currentAssistantMessage(state: SessionState): BridgeMessage {
  let message = state.messages.at(-1);
  // A hydrating replay is idle by definition, so requiring "running" here would
  // open a fresh, empty assistant message for every tool call in the history.
  if (
    !message ||
    message.role !== "assistant" ||
    (state.status !== "running" && state.historyReplay !== "hydrate")
  ) {
    const modelId = boundedModelId(state.sessionConfig.composer.selectedModelId);
    message = {
      id: randomBytes(12).toString("hex"),
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date().toISOString(),
      ...(modelId ? { modelId } : {}),
    };
    state.messages.push(message);
  }
  return message;
}

/**
 * A model id is an identifier, not display text, so an oversized or non-string
 * value is dropped rather than truncated — exactly as `session-config.ts`
 * rejects an over-long `selectedModelId` instead of shortening it. A truncated
 * id would match no catalogue entry and would render as a plausible-looking
 * model the agent never actually ran; absent renders as "no model recorded".
 */
export function boundedModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > MAX_MODEL_ID_BYTES) return undefined;
  return trimmed;
}

/**
 * Whether losing transcript content has to fail the turn.
 *
 * A structured turn is worth exactly its complete output, so any loss must
 * fail: the caller would otherwise parse a truncated answer as a whole one. An
 * interactive turn is a conversation, and trimming its oldest steps to stay
 * inside the display budget is routine housekeeping. Failing the session there
 * strands the *entire* conversation behind a "Connection Failed" screen —
 * `HttpBridgeProvider.status()` turns any bridge error status into a thrown
 * command — and the failure is persisted, so Retry only reads it back.
 */
