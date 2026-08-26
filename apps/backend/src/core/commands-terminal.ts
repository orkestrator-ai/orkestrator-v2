import { existsSync, path, createHash } from "./commands-dependencies.js";
import type {
  ClientEnvironment,
  Environment,
  PersistedLoopedReviewWorkflow,
} from "./commands-dependencies.js";
import {
  terminalProcesses,
  terminalSessionConfigs,
  terminalOutputBuffers,
  terminalOutputRevisions,
  terminalOutputGenerations,
  terminalOutputDeltas,
  terminalOutputDeltaBytes,
  terminalOutputTruncated,
  terminalOutputRetentionTimers,
  terminalSessionIdsByStableKey,
  terminalStableKeysBySessionId,
  orphanedTerminalMissingSince,
  terminalActivityTimers,
  terminalActivityArmed,
  terminalActivityGenerations,
  terminalActivityCompletions,
  terminalActivityCompletionStates,
  deletingLocalServerEnvironments,
  MAX_TERMINAL_OUTPUT_BUFFER_CHARS,
  getTerminalOutputRetentionMs,
  resetTerminalOutputRetentionMs,
  nextTerminalActivityGenerationValue,
  MAX_RETAINED_TERMINAL_OUTPUT_BUFFERS,
  TERMINAL_ACTIVITY_SETTLE_MS,
} from "./commands-runtime-state.js";
import { containerIdMatches } from "./commands-review.js";
import type {
  TerminalSessionConfig,
  TerminalOutputBuffer,
  EnvironmentSetupStartResult,
  ClientEnvironmentSetupStartResult,
} from "./commands-runtime-state.js";
import type { CommandContext, BackendEmit } from "./commands-context.js";

/**
 * Every key `ClientEnvironment` omits must be destructured away here.
 *
 * TypeScript will not catch a miss: excess-property checking does not apply to
 * spread properties, so a field left in `client` is returned to the renderer
 * while the declared return type says it was removed. The
 * `get_environment_snapshots` case in
 * `tests/unit/electron/commands-registry-environments.test.ts` asserts the
 * absence of each one, because that is the only place the drift shows up.
 */
export function toClientEnvironment(environment: Environment): ClientEnvironment {
  const {
    agentActivitySources: _agentActivitySources,
    frontendAgentActivityObservers: _frontendObservers,
    initialPromptAttachments: _attachments,
    initialConversationMode: _initialConversationMode,
    claudeModelCatalog: _modelCatalog,
    opencodePid: _opencodePid,
    claudeBridgePid: _claudeBridgePid,
    codexBridgePid: _codexBridgePid,
    cursorBridgePid: _cursorBridgePid,
    grokBridgePid: _grokBridgePid,
    piBridgePid: _piBridgePid,
    tabTeardownIntents: _tabTeardownIntents,
    pendingRenamePrompt: _pendingRenamePrompt,
    prRecheckAfterAgentCompletionArmedAt: _prRecheckArm,
    controlRequestId: _controlRequestId,
    ...client
  } = environment;
  if (!client.pendingAgentLaunch && client.startupAgentSession?.status !== "starting") {
    delete client.initialAgentModel;
    delete client.initialReasoningEffort;
  }
  // The bodies stay backend-only, but their existence does not: the renderer
  // uses this to decide whether the targeted detail read is worth making at all.
  // Always emitted, including `false`, so a renderer can tell "this backend says
  // there are none" apart from "this backend is too old to say".
  return {
    ...client,
    hasInitialPromptAttachments: (_attachments?.length ?? 0) > 0,
  };
}

export function toClientEnvironmentSetupStartResult(
  result: EnvironmentSetupStartResult,
): ClientEnvironmentSetupStartResult {
  return {
    ...result,
    environment: toClientEnvironment(result.environment),
  };
}

export function conditionalSnapshot<T>(
  value: T,
  knownDigest: unknown,
):
  | T
  | {
      unchanged: boolean;
      digest: string;
      value?: T;
    } {
  if (knownDigest === undefined) return value;
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return typeof knownDigest === "string" && knownDigest === digest
    ? { unchanged: true, digest }
    : { unchanged: false, digest, value };
}

export type RendererLoopedReviewWorkflow = Omit<
  PersistedLoopedReviewWorkflow,
  "snapshot" | "controllerLease"
> & { snapshot?: unknown };

/**
 * Backend-owned workflows carry a controller lease (top level) and a fence
 * token (inside the snapshot) that the renderer must never see. Copies the
 * record without them. A record without a snapshot is returned untouched so
 * the response always mirrors the stored shape.
 */
export function stripLoopedReviewRendererSecrets(
  workflow: PersistedLoopedReviewWorkflow,
): RendererLoopedReviewWorkflow {
  const { controllerLease: _controllerLease, ...rendererWorkflow } = workflow;
  if (workflow.snapshot === undefined) return rendererWorkflow;
  return { ...rendererWorkflow, snapshot: stripLoopedReviewSnapshotSecrets(workflow.snapshot) };
}

/**
 * The lifecycle commands return the supervisor's own workflow object, and
 * `save()` stamps the live lease token onto it before handing it back. That
 * token is the fence provider sessions are pinned to, so it must be removed
 * here for the same reason `get`/`list` remove it — the renderer installs these
 * responses straight into its store, and in gateway mode that crosses a network.
 */
export function stripLoopedReviewSnapshotSecrets<T>(snapshot: T): T {
  if (typeof snapshot !== "object" || snapshot === null) return snapshot;
  const { controllerFence: _controllerFence, ...rest } = snapshot as Record<string, unknown> & {
    controllerFence?: unknown;
  };
  return rest as T;
}

/**
 * PTY output is already UTF-8 text at this boundary. Keeping it plain avoids a
 * base64 encode/decode and the 33% wire expansion on every live frame. The
 * renderer still accepts the old base64 form for rolling upgrades.
 */
export function terminalOutputPayload(
  data: string | Buffer,
  revision: number,
  generation: number,
): { text: string; revision: number; generation: number } {
  return {
    text: Buffer.isBuffer(data) ? data.toString("utf8") : data,
    revision,
    generation,
  };
}

export const MAX_TERMINAL_OUTPUT_BUFFER_CHUNKS = 1_024;
export const MAX_TERMINAL_OUTPUT_DELTA_BYTES = 2 * 1024 * 1024;
export const MAX_TERMINAL_OUTPUT_DELTAS = 1_024;

export function createTerminalOutputBuffer(): TerminalOutputBuffer {
  return { chunks: [], headIndex: 0, headOffset: 0, length: 0 };
}

export function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

export function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Drop a low surrogate whose high half the trim just discarded.
 *
 * A surrogate pair can straddle two PTY chunks, and then the trim boundary is a
 * chunk edge rather than an offset inside one chunk, so the in-chunk guard never
 * sees the pair. The orphan that leaves is not representable in UTF-8: every
 * consumer downstream of the buffer turns it into U+FFFD.
 */
export function trimOrphanedLowSurrogate(buffer: TerminalOutputBuffer): void {
  // Nothing was trimmed, so a leading low surrogate is the PTY's own output.
  if (buffer.headIndex === 0 && buffer.headOffset === 0) return;
  const head = buffer.chunks[buffer.headIndex];
  if (head === undefined || buffer.length === 0) return;
  if (!isLowSurrogate(head.charCodeAt(buffer.headOffset))) return;
  const previousChunk = buffer.chunks[buffer.headIndex - 1] ?? "";
  const precedingCodeUnit =
    buffer.headOffset > 0
      ? head.charCodeAt(buffer.headOffset - 1)
      : previousChunk.charCodeAt(previousChunk.length - 1);
  if (!isHighSurrogate(precedingCodeUnit)) return;
  buffer.headOffset += 1;
  buffer.length -= 1;
}

export function compactTerminalOutputBuffer(buffer: TerminalOutputBuffer): string {
  if (buffer.length === 0) {
    buffer.chunks = [];
    buffer.headIndex = 0;
    buffer.headOffset = 0;
    return "";
  }
  if (buffer.chunks.length - buffer.headIndex === 1 && buffer.headOffset === 0) {
    return buffer.chunks[buffer.headIndex]!;
  }
  const retained = buffer.chunks.slice(buffer.headIndex);
  retained[0] = retained[0]!.slice(buffer.headOffset);
  const joined = retained.join("");
  // Compact so repeated reads (and the next trim) work against one chunk.
  buffer.chunks = [joined];
  buffer.headIndex = 0;
  buffer.headOffset = 0;
  buffer.length = joined.length;
  return joined;
}

export function readTerminalOutputBuffer(sessionId: string): string {
  const buffer = terminalOutputBuffers.get(sessionId);
  return buffer ? compactTerminalOutputBuffer(buffer) : "";
}

export function terminalOutputBufferLength(sessionId: string): number {
  return terminalOutputBuffers.get(sessionId)?.length ?? 0;
}

export function deleteRetainedTerminalOutputBuffer(sessionId: string): void {
  const timer = terminalOutputRetentionTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  terminalOutputRetentionTimers.delete(sessionId);
  terminalOutputBuffers.delete(sessionId);
  terminalOutputRevisions.delete(sessionId);
  terminalOutputGenerations.delete(sessionId);
  terminalOutputDeltas.delete(sessionId);
  terminalOutputDeltaBytes.delete(sessionId);
  terminalOutputTruncated.delete(sessionId);
}

export function resetTerminalOutputBuffers(): void {
  resetTerminalOutputRetentionMs();
  for (const timer of terminalOutputRetentionTimers.values()) clearTimeout(timer);
  terminalOutputRetentionTimers.clear();
  terminalOutputBuffers.clear();
  terminalOutputRevisions.clear();
  terminalOutputGenerations.clear();
  terminalOutputDeltas.clear();
  terminalOutputDeltaBytes.clear();
  terminalOutputTruncated.clear();
}

export function retainTerminalOutputBuffer(sessionId: string): void {
  const previous = terminalOutputRetentionTimers.get(sessionId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(
    () => deleteRetainedTerminalOutputBuffer(sessionId),
    getTerminalOutputRetentionMs(),
  );
  timer.unref?.();
  terminalOutputRetentionTimers.delete(sessionId);
  terminalOutputRetentionTimers.set(sessionId, timer);
  while (terminalOutputRetentionTimers.size > MAX_RETAINED_TERMINAL_OUTPUT_BUFFERS) {
    const oldest = terminalOutputRetentionTimers.keys().next().value;
    if (oldest === undefined) break;
    deleteRetainedTerminalOutputBuffer(oldest);
  }
}

export function ensureTerminalOutputGeneration(sessionId: string): number {
  const existing = terminalOutputGenerations.get(sessionId);
  if (existing !== undefined) return existing;
  terminalOutputGenerations.set(sessionId, 1);
  return 1;
}

export function appendTerminalOutputBuffer(sessionId: string, data: string | Buffer): number {
  ensureTerminalOutputGeneration(sessionId);
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
  if (!text) return terminalOutputRevisions.get(sessionId) ?? 0;
  let buffer = terminalOutputBuffers.get(sessionId);
  if (!buffer) {
    buffer = createTerminalOutputBuffer();
    terminalOutputBuffers.set(sessionId, buffer);
  }

  // Tiny PTY callbacks can otherwise retain hundreds of thousands of string
  // and array slots even though their text is capped. Compact at a fixed slot
  // count; the amortized work is bounded and trimming never shifts the array.
  if (buffer.chunks.length - buffer.headIndex >= MAX_TERMINAL_OUTPUT_BUFFER_CHUNKS) {
    compactTerminalOutputBuffer(buffer);
  }
  buffer.chunks.push(text);
  buffer.length += text.length;

  let excess = buffer.length - MAX_TERMINAL_OUTPUT_BUFFER_CHARS;
  if (excess > 0) terminalOutputTruncated.add(sessionId);
  while (excess > 0) {
    const head = buffer.chunks[buffer.headIndex];
    if (head === undefined) break;
    const available = head.length - buffer.headOffset;
    if (available > excess) {
      let trim = excess;
      const boundary = buffer.headOffset + trim;
      if (
        isLowSurrogate(head.charCodeAt(boundary)) &&
        isHighSurrogate(head.charCodeAt(boundary - 1))
      ) {
        trim += 1;
      }
      buffer.headOffset += trim;
      buffer.length -= trim;
      break;
    }
    buffer.headIndex += 1;
    buffer.headOffset = 0;
    buffer.length -= available;
    excess -= available;
  }
  trimOrphanedLowSurrogate(buffer);
  if (buffer.headIndex >= MAX_TERMINAL_OUTPUT_BUFFER_CHUNKS) {
    compactTerminalOutputBuffer(buffer);
  }
  const revision = (terminalOutputRevisions.get(sessionId) ?? 0) + 1;
  terminalOutputRevisions.set(sessionId, revision);
  let deltas = terminalOutputDeltas.get(sessionId);
  if (!deltas) {
    deltas = [];
    terminalOutputDeltas.set(sessionId, deltas);
  }
  deltas.push({ revision, text });
  let deltaBytes = (terminalOutputDeltaBytes.get(sessionId) ?? 0) + Buffer.byteLength(text, "utf8");
  while (
    deltas.length > MAX_TERMINAL_OUTPUT_DELTAS ||
    deltaBytes > MAX_TERMINAL_OUTPUT_DELTA_BYTES
  ) {
    const removed = deltas.shift();
    if (!removed) break;
    deltaBytes -= Buffer.byteLength(removed.text, "utf8");
  }
  terminalOutputDeltaBytes.set(sessionId, deltaBytes);
  return revision;
}

export function emitTerminalOutput(
  sessionId: string,
  data: string | Buffer,
  emit: BackendEmit,
): void {
  const revision = appendTerminalOutputBuffer(sessionId, data);
  const generation = terminalOutputGenerations.get(sessionId) ?? 1;
  emit(`terminal-output-${sessionId}`, terminalOutputPayload(data, revision, generation));
}

export function resetTerminalOutputBuffer(sessionId: string): void {
  const retentionTimer = terminalOutputRetentionTimers.get(sessionId);
  if (retentionTimer) clearTimeout(retentionTimer);
  terminalOutputRetentionTimers.delete(sessionId);
  terminalOutputBuffers.set(sessionId, createTerminalOutputBuffer());
  terminalOutputRevisions.set(sessionId, 0);
  terminalOutputDeltas.set(sessionId, []);
  terminalOutputDeltaBytes.set(sessionId, 0);
  terminalOutputTruncated.delete(sessionId);
  terminalOutputGenerations.set(sessionId, (terminalOutputGenerations.get(sessionId) ?? 0) + 1);
}

export function logSetupTerminal(message: string, details: Record<string, unknown> = {}): void {
  console.info(`[setup-terminal] ${message}`, details);
}

export function terminalEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    TERM: baseEnv.TERM || "xterm-256color",
    COLORTERM: baseEnv.COLORTERM || "truecolor",
    LANG: baseEnv.LANG || "en_US.UTF-8",
  };
}

export function resolveLocalShellPath(): string {
  const configuredShell = process.env.SHELL?.trim();
  if (configuredShell && path.isAbsolute(configuredShell) && existsSync(configuredShell)) {
    return configuredShell;
  }

  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (existsSync(candidate)) return candidate;
  }

  return configuredShell || "zsh";
}

export function rememberTerminalSession(id: string, config: TerminalSessionConfig): string {
  terminalSessionConfigs.set(id, { ...config, bootstrapped: false });
  ensureTerminalOutputGeneration(id);
  return id;
}

export function isTerminalBootstrapped(id: string): boolean {
  return terminalSessionConfigs.get(id)?.bootstrapped === true;
}

export function stableTerminalKey(
  kind: TerminalSessionConfig["kind"],
  environmentId: string | undefined,
  terminalKey: string | undefined,
): string | null {
  if (!environmentId || !terminalKey) return null;
  return `${kind}\0${environmentId}\0${terminalKey}`;
}

export function rememberStableTerminalSession(
  id: string,
  config: TerminalSessionConfig,
  stableKey: string | null,
): string {
  rememberTerminalSession(id, config);
  if (stableKey) {
    terminalSessionIdsByStableKey.set(stableKey, id);
    terminalStableKeysBySessionId.set(id, stableKey);
  }
  return id;
}

export function existingStableTerminalSession(stableKey: string | null): string | null {
  if (!stableKey) return null;
  const id = terminalSessionIdsByStableKey.get(stableKey);
  if (!id) return null;
  if (terminalSessionConfigs.has(id) || terminalProcesses.has(id)) return id;
  terminalSessionIdsByStableKey.delete(stableKey);
  terminalStableKeysBySessionId.delete(id);
  return null;
}

export function containerTerminalConfigMatches(
  id: string,
  expected: Extract<TerminalSessionConfig, { kind: "container" }>,
): boolean {
  const config = terminalSessionConfigs.get(id);
  return (
    config?.kind === "container" &&
    containerIdMatches(config.containerId, expected.containerId) &&
    config.user === expected.user &&
    config.environmentId === expected.environmentId &&
    config.activityEnvironmentId === expected.activityEnvironmentId &&
    config.trackEnvironmentActivity === expected.trackEnvironmentActivity
  );
}

export function localTerminalConfigMatches(
  id: string,
  expected: Extract<TerminalSessionConfig, { kind: "local" }>,
): boolean {
  const config = terminalSessionConfigs.get(id);
  return (
    config?.kind === "local" &&
    config.environmentId === expected.environmentId &&
    config.trackEnvironmentActivity === expected.trackEnvironmentActivity
  );
}

export function getTrackedTerminalEnvironmentId(id: string): string | null {
  const config = terminalSessionConfigs.get(id);
  if (!config?.trackEnvironmentActivity) return null;
  return config.kind === "local" ? config.environmentId : (config.activityEnvironmentId ?? null);
}

export const TERMINAL_ACTIVITY_PERSIST_RETRY_DELAYS_MS = [100, 250, 500] as const;
export const TERMINAL_COMPLETION_NOTIFY_RETRY_DELAYS_MS = [100, 250, 500] as const;

export function finishTrackedTerminalCompletion(id: string, generation: number): void {
  if (terminalActivityGenerations.get(id) === generation) {
    terminalActivityArmed.delete(id);
  }
  if (terminalActivityCompletions.get(id) === generation) {
    terminalActivityCompletions.delete(id);
  }
  const state = terminalActivityCompletionStates.get(generation);
  if (state?.id === id) {
    for (const timer of state.retryTimers) clearTimeout(timer);
    terminalActivityCompletionStates.delete(generation);
  }
}

export function isTrackedTerminalCompletionActive(id: string, generation: number): boolean {
  const state = terminalActivityCompletionStates.get(generation);
  return state?.id === id && !state.cancelled;
}

export function scheduleTrackedTerminalCompletionRetry(
  id: string,
  generation: number,
  callback: () => void,
  delay: number,
): void {
  const state = terminalActivityCompletionStates.get(generation);
  if (!state || state.id !== id || state.cancelled) return;
  const timer = setTimeout(() => {
    state.retryTimers.delete(timer);
    if (!state.cancelled) callback();
  }, delay);
  timer.unref?.();
  state.retryTimers.add(timer);
}

export function cancelTrackedTerminalCompletions(id: string): void {
  for (const [generation, state] of terminalActivityCompletionStates) {
    if (state.id !== id) continue;
    state.cancelled = true;
    for (const timer of state.retryTimers) clearTimeout(timer);
    terminalActivityCompletionStates.delete(generation);
  }
}

export function notifyTrackedTerminalCompletion(
  id: string,
  environmentId: string,
  generation: number,
  context: CommandContext,
  attempt = 0,
): void {
  if (!isTrackedTerminalCompletionActive(id, generation)) return;
  const notify = context.notifyAgentTurnCompleted;
  if (!notify) {
    finishTrackedTerminalCompletion(id, generation);
    return;
  }
  void notify(environmentId).then(
    () => finishTrackedTerminalCompletion(id, generation),
    (error) => {
      const delay = TERMINAL_COMPLETION_NOTIFY_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        scheduleTrackedTerminalCompletionRetry(
          id,
          generation,
          () =>
            notifyTrackedTerminalCompletion(id, environmentId, generation, context, attempt + 1),
          delay,
        );
        return;
      }
      finishTrackedTerminalCompletion(id, generation);
      console.error("Failed to notify terminal agent completion", {
        environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

export function persistTrackedTerminalCompletion(
  id: string,
  environmentId: string,
  occurredAt: string,
  generation: number,
  context: CommandContext,
  attempt = 0,
): void {
  if (!isTrackedTerminalCompletionActive(id, generation)) return;
  void context.storage
    .recordEnvironmentCompletion(environmentId, occurredAt)
    .then((environment) => {
      if (!isTrackedTerminalCompletionActive(id, generation)) return;
      context.emit("environment-activity-recorded", {
        environment_id: environment.id,
        occurred_at: environment.lastActivityAt ?? occurredAt,
        activity_kind: "completed",
      });
      notifyTrackedTerminalCompletion(id, environmentId, generation, context);
    })
    .catch((error) => {
      const delay = TERMINAL_ACTIVITY_PERSIST_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        scheduleTrackedTerminalCompletionRetry(
          id,
          generation,
          () =>
            persistTrackedTerminalCompletion(
              id,
              environmentId,
              occurredAt,
              generation,
              context,
              attempt + 1,
            ),
          delay,
        );
        return;
      }
      finishTrackedTerminalCompletion(id, generation);
      console.error("Failed to record terminal environment activity", {
        environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function persistTerminalActivity(
  id: string,
  context: CommandContext,
  activityKind: "prompt" | "completed",
): void {
  const timer = terminalActivityTimers.get(id);
  if (timer) clearTimeout(timer);
  terminalActivityTimers.delete(id);

  if (!terminalActivityArmed.has(id)) return;
  const environmentId = getTrackedTerminalEnvironmentId(id);
  if (!environmentId) return;
  if (activityKind === "completed") {
    const generation = terminalActivityGenerations.get(id) ?? 0;
    if (terminalActivityCompletions.get(id) === generation) return;
    terminalActivityCompletions.set(id, generation);
    terminalActivityCompletionStates.set(generation, {
      id,
      generation,
      cancelled: false,
      retryTimers: new Set(),
    });
    persistTrackedTerminalCompletion(
      id,
      environmentId,
      new Date().toISOString(),
      generation,
      context,
    );
    return;
  }

  const occurredAt = new Date().toISOString();
  void context.storage
    .recordEnvironmentActivity(environmentId, occurredAt)
    .then((environment) => {
      context.emit("environment-activity-recorded", {
        environment_id: environment.id,
        occurred_at: environment.lastActivityAt ?? occurredAt,
        activity_kind: "prompt",
      });
    })
    .catch((error) => {
      console.error("Failed to record terminal environment activity", {
        environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function recordTerminalInputActivity(
  id: string,
  data: string,
  context: CommandContext,
): void {
  if (!/[\r\n]/.test(data) || !getTrackedTerminalEnvironmentId(id)) return;
  const generation = nextTerminalActivityGenerationValue();
  terminalActivityGenerations.set(id, generation);
  terminalActivityArmed.add(id);
  persistTerminalActivity(id, context, "prompt");
}

export function scheduleTerminalOutputActivity(id: string, context: CommandContext): void {
  if (!terminalActivityArmed.has(id) || !getTrackedTerminalEnvironmentId(id)) return;
  const existingTimer = terminalActivityTimers.get(id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(
    () => persistTerminalActivity(id, context, "completed"),
    TERMINAL_ACTIVITY_SETTLE_MS,
  );
  timer.unref?.();
  terminalActivityTimers.set(id, timer);
}

export function trackedTerminalActivityHooks(
  id: string,
  context: CommandContext,
): { onData: () => void; onExit: () => void } {
  return {
    onData: () => scheduleTerminalOutputActivity(id, context),
    onExit: () => persistTerminalActivity(id, context, "completed"),
  };
}

export function cleanupTerminalSession(id: string, options: { explicit?: boolean } = {}): void {
  orphanedTerminalMissingSince.delete(id);
  const activityTimer = terminalActivityTimers.get(id);
  if (activityTimer) clearTimeout(activityTimer);
  terminalActivityTimers.delete(id);
  terminalActivityArmed.delete(id);
  terminalActivityGenerations.delete(id);
  terminalActivityCompletions.delete(id);
  if (options.explicit) cancelTrackedTerminalCompletions(id);
  terminalProcesses.delete(id);
  const stableKey = terminalStableKeysBySessionId.get(id);
  const retainStableState =
    !options.explicit && stableKey !== undefined && terminalSessionConfigs.has(id);
  // Bootstrap ownership belongs to one concrete PTY lifetime. Stable tabs keep
  // their identity and replay buffer across a natural shell exit, but the
  // replacement PTY must be allowed to receive its launch command once.
  const retainedConfig = terminalSessionConfigs.get(id);
  if (retainedConfig) retainedConfig.bootstrapped = false;
  if (retainStableState) return;

  terminalSessionConfigs.delete(id);
  if (stableKey) {
    terminalStableKeysBySessionId.delete(id);
    if (terminalSessionIdsByStableKey.get(stableKey) === id) {
      terminalSessionIdsByStableKey.delete(stableKey);
    }
  }
  // Setup-session buffers are retained until their environment is removed.
  // Stable tab sessions returned above retain their bounded transcript until
  // explicit tab or environment cleanup. A one-shot session gets a bounded,
  // short-lived recovery window because a lagging renderer may be told to
  // refetch after the PTY itself has already exited.
  if (!isSetupTerminalSessionId(id)) {
    if (!options.explicit && terminalOutputBuffers.has(id)) {
      retainTerminalOutputBuffer(id);
    } else {
      deleteRetainedTerminalOutputBuffer(id);
    }
  }
}

export function explicitlyCloseTerminalSession(id: string): void {
  terminalProcesses.get(id)?.kill();
  cleanupTerminalSession(id, { explicit: true });
}

export function terminalStableKeyEnvironmentId(id: string): string | null {
  const stableKey = terminalStableKeysBySessionId.get(id);
  return stableKey?.split("\0")[1] ?? null;
}

export function cleanupTerminalSessionsForEnvironment(environmentId: string): void {
  const sessionIds = new Set<string>();
  for (const [id, config] of terminalSessionConfigs) {
    if (
      (config.kind === "local" && config.environmentId === environmentId) ||
      (config.kind === "container" &&
        (config.environmentId === environmentId ||
          config.activityEnvironmentId === environmentId)) ||
      terminalStableKeyEnvironmentId(id) === environmentId
    ) {
      sessionIds.add(id);
    }
  }
  for (const id of sessionIds) explicitlyCloseTerminalSession(id);
}

export function assertEnvironmentNotDeleting(environmentId: string | undefined): void {
  if (environmentId && deletingLocalServerEnvironments.has(environmentId)) {
    throw new Error(`Environment is being deleted: ${environmentId}`);
  }
}

export function assertEnvironmentDeletionNotRequested(
  environment: Environment | null | undefined,
  environmentId: string,
): void {
  if (environment?.deletionRequestedAt) {
    throw new Error(`Environment is being deleted: ${environmentId}`);
  }
}

export function setupTerminalSessionId(environmentId: string): string {
  return `${environmentId}:setup`;
}

export function isSetupTerminalSessionId(sessionId: string): boolean {
  return sessionId.endsWith(":setup");
}
