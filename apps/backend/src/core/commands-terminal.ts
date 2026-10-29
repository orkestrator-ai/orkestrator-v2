import {
  containerLifecycleSnapshot,
  parseContainerLifecycle,
} from "@orkestrator/protocol/container-lifecycle";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ClientEnvironment, Environment, PersistedMultiReviewWorkflow } from "./models.js";
import type {
  EnvironmentSetupStartResult,
  ClientEnvironmentSetupStartResult,
} from "./environment-operations.js";
import type { TerminalOutputBuffer, TerminalSessionConfig } from "./terminal-runtime.js";

/**
 * Every key `ClientEnvironment` omits must be destructured away here.
 *
 * TypeScript will not catch a miss: excess-property checking does not apply to
 * spread properties, so a field left in `client` is returned to the renderer
 * while the declared return type says it was removed. The
 * `get_environment_snapshots` case in
 * `apps/backend/tests/commands-registry-environments.test.ts` asserts the
 * absence of each one, because that is the only place the drift shows up.
 */
export function toClientEnvironment(environment: Environment): ClientEnvironment {
  const {
    agentActivitySources: _agentActivitySources,
    frontendAgentActivityObservers: _frontendObservers,
    initialPromptAttachments: _attachments,
    initialPromptPresentation: _initialPromptPresentation,
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
    controlRequestFingerprint: _controlRequestFingerprint,
    branchRevision: _branchRevision,
    containerLifecycle: _containerLifecycle,
    ...client
  } = environment;
  if (!client.pendingAgentLaunch && client.startupAgentSession?.status !== "starting") {
    delete client.initialAgentPlatform;
    delete client.initialAgentModel;
    delete client.initialReasoningEffort;
    delete client.initialFastMode;
  }
  // The bodies stay backend-only, but their existence does not: the renderer
  // uses this to decide whether the targeted detail read is worth making at all.
  // Always emitted, including `false`, so a renderer can tell "this backend says
  // there are none" apart from "this backend is too old to say".
  return {
    ...client,
    hasInitialPromptAttachments: (_attachments?.length ?? 0) > 0,
    ...(_containerLifecycle === undefined
      ? {}
      : {
          containerLifecycle: containerLifecycleSnapshot(
            parseContainerLifecycle(_containerLifecycle),
          ),
        }),
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

export type RendererWorkflowRecord = Omit<
  PersistedMultiReviewWorkflow,
  "snapshot" | "controllerLease"
> & { snapshot?: unknown };

/**
 * Backend-owned workflows carry a controller lease (top level) and a fence
 * token (inside the snapshot) that the renderer must never see. Copies the
 * record without them. A record without a snapshot is returned untouched so
 * the response always mirrors the stored shape.
 */
export function stripWorkflowRendererSecrets(
  workflow: PersistedMultiReviewWorkflow,
): RendererWorkflowRecord {
  const { controllerLease: _controllerLease, ...rendererWorkflow } = workflow;
  if (workflow.snapshot === undefined) return rendererWorkflow;
  return { ...rendererWorkflow, snapshot: stripWorkflowSnapshotSecrets(workflow.snapshot) };
}

/**
 * The lifecycle commands return the supervisor's own workflow object, and
 * `save()` stamps the live lease token onto it before handing it back. That
 * token is the fence provider sessions are pinned to, so it must be removed
 * here for the same reason `get`/`list` remove it — the renderer installs these
 * responses straight into its store, and in gateway mode that crosses a network.
 */
export function stripWorkflowSnapshotSecrets<T>(snapshot: T): T {
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

export function stableTerminalKey(
  kind: TerminalSessionConfig["kind"],
  environmentId: string | undefined,
  terminalKey: string | undefined,
): string | null {
  if (!environmentId || !terminalKey) return null;
  return `${kind}\0${environmentId}\0${terminalKey}`;
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
