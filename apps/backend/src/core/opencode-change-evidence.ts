/**
 * OpenCode's change-evidence adapter (see `docs/architecture/change-tracking.md`,
 * "Writing a provider adapter").
 *
 * OpenCode has no bridge process of ours, so this is the backend-side
 * equivalent of a bridge's `change-evidence.ts`: it decodes `opencode serve`
 * SSE events into canonical frames and appends them to an in-process
 * {@link ChangeEvidenceSpool} the change-tracking service pulls like any
 * bridge spool. It never counts lines and never picks between evidence
 * blocks: each native field becomes its own block, and the backend's
 * selection policy decides what is shown.
 *
 * Verified against OpenCode 1.19.0's tool implementations:
 *
 * - `edit` sets `metadata.diff` and `metadata.filediff = { file, patch,
 *   additions, deletions }` after it has written the file (so even a running
 *   part's metadata is an applied result). `diff` and `filediff.patch` are the
 *   same jsdiff two-file patch (`Index:`/`===` banner, `---`/`+++`, hunks).
 *   Older servers put `before`/`after` on `filediff` instead of `patch`.
 * - `write` reports only `metadata.exists`, checked immediately before the
 *   write: `false` establishes the file was new. Its result is not the input
 *   content (a formatter may rewrite it), so only the proposal carries content.
 * - `apply_patch` reports `metadata.files[] = { filePath, relativePath, type,
 *   patch, additions, deletions, movePath? }` plus a concatenated `diff`.
 * - Permission prompts (`permission.asked`) name the waiting `tool.callID`.
 *
 * Everything here runs synchronously inside the SSE handler and never throws
 * into it. The adapter also fronts the provider's legacy shell probe
 * (`OpenCodeCommandChanges`): it forwards each event, turn start and release
 * to it in stream order and receives its closed shell windows.
 */

import type {
  ExecutionOccurrence,
  ProviderChangeCapabilities,
  ToolKind,
  ToolPhase,
} from "@orkestrator/protocol/change-evidence";
import {
  ChangeEvidenceRecorder,
  type EvidenceInput,
  type EvidenceSourceInput,
} from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import {
  ChangeEvidenceSpool,
  stableEvidenceId,
  type EvidenceSpoolOptions,
} from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import type { BridgeConnection } from "./agent-provider-contract.js";
import { asRecord, nonEmptyString, setBoundedMapEntry } from "./agent-provider-runtime.js";
import type { EvidenceSource } from "./change-tracking/index.js";
import type { OpenCodeCommandChanges } from "./opencode-command-changes.js";
import { collectRawOpenCodeSubagentIds } from "./opencode-messages.js";

export const OPENCODE_EVIDENCE_PROVIDER = "opencode";

const MAX_CALLS = 2_048;
const MAX_SESSIONS = 512;
const MAX_MESSAGES = 4_096;
const MAX_PERMISSIONS = 512;
/** Distinct evidence signatures remembered per call (replayed updates are skipped). */
const MAX_SIGNATURES_PER_CALL = 16;

/** Where OpenCode's tools write: a host worktree, or a clone inside a container. */
export type OpenCodeWorkspaceLocation = "host" | "container";

/**
 * What one OpenCode connection can establish. A container's `/workspace` is
 * not a host path, so until a container capture worker exists nothing can be
 * captured there.
 */
export function openCodeChangeCapabilities(
  location: OpenCodeWorkspaceLocation,
): Omit<ProviderChangeCapabilities, "capabilityRevision"> {
  return {
    // `backgroundCompletion` is unresolved, so the record is partial.
    resolution: "partial",
    beforeTurn: "controlled-dispatch",
    afterTurn: "terminal-observed",
    beforeTool: "observed-after-start",
    afterTool: "observed",
    historicalCallIdentity: "stable",
    fileEvidence: { resolution: "confirmed", kinds: ["patch", "replacement", "reported-counts"] },
    turnDiff: "absent",
    captureExecutor: location === "host" ? "host-worker" : "container-worker",
    captureAvailability: location === "host" ? "ready" : "unavailable",
    backgroundCompletion: "unknown",
  };
}

const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  bash: "shell",
  shell: "shell",
  edit: "file-edit",
  patch: "file-edit",
  apply_patch: "file-edit",
  multiedit: "file-edit",
  write: "file-write",
  read: "read",
  grep: "read",
  glob: "read",
  list: "read",
  task: "other",
  agent: "other",
};

export function openCodeToolKind(tool: string): ToolKind {
  return TOOL_KINDS[tool.toLowerCase()] ?? "other";
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function stringField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function pathField(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) return value;
  }
  return undefined;
}

function countField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * `ctx.metadata({ metadata: { diff, filediff } })` can nest one extra layer;
 * unwrap only when the outer record has no edit fields of its own (mirrors
 * `tool-diff.ts`).
 */
function unwrapMetadata(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const nested = asRecord(record.metadata);
  const editKeys = [
    "filediff",
    "diff",
    "files",
    "filepath",
    "file",
    "exists",
    "additions",
    "deletions",
  ];
  if (
    nested &&
    editKeys.every((key) => record[key] === undefined) &&
    editKeys.some((key) => nested[key] !== undefined)
  ) {
    return nested;
  }
  return record;
}

/** OpenCode's edit/write title is a worktree-relative path; prose is not. */
function pathLikeTitle(title: unknown): string | undefined {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed || /\s/.test(trimmed) || trimmed.endsWith(".")) return undefined;
  return /^[A-Za-z0-9_./\\-]+$/.test(trimmed) ? trimmed : undefined;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

/**
 * A patch the shared unified parser reads: hunks introduced by `---`/`+++`
 * or `diff --git` headers. OpenCode's jsdiff banner (`Index:`, `===`) sits
 * outside any file block and is ignored by that parser.
 */
export function openCodePatchFormat(text: string): "git_unified" | "opaque" {
  if (!HUNK_HEADER.test(text)) return "opaque";
  return /^(?:--- .*\n\+\+\+ |diff --git )/m.test(text) ? "git_unified" : "opaque";
}

const PATH_OPERATIONS: Readonly<Record<string, "add" | "modify" | "delete" | "rename">> = {
  add: "add",
  added: "add",
  update: "modify",
  modified: "modify",
  delete: "delete",
  deleted: "delete",
  move: "rename",
};

/**
 * Decode one tool state into independent evidence blocks. Applied results
 * (`provider-reported`) and model input (`proposal`) are kept apart; nothing
 * here decides which one is shown.
 */
export function openCodeToolEvidence(
  tool: string,
  stateValue: unknown,
  title?: unknown,
): EvidenceInput[] {
  const kind = openCodeToolKind(tool);
  if (kind !== "file-edit" && kind !== "file-write") return [];
  const state = asRecord(stateValue);
  const input = asRecord(state?.input);
  const meta = unwrapMetadata(state?.metadata);
  const filediff = asRecord(meta?.filediff);
  const name = tool.toLowerCase();
  const inputPath = pathField(input, "filePath", "file_path", "path");
  const resultPath =
    pathField(filediff, "file", "filePath", "filepath", "path") ??
    pathField(meta, "filepath", "filePath", "file", "path") ??
    inputPath ??
    pathLikeTitle(title ?? state?.title);
  const evidence: EvidenceInput[] = [];

  // A file OpenCode itself established as new (write's `exists: false`,
  // checked just before writing; a snapshot-style `status: "added"`).
  const establishedNew = meta?.exists === false || filediff?.status === "added";
  const files = Array.isArray(meta?.files)
    ? meta.files.map(asRecord).filter((f) => f !== null)
    : [];

  if (files.length > 0) {
    // apply_patch: one block per file; the concatenated `diff` repeats them.
    for (const file of files) {
      const path = pathField(file, "relativePath", "filePath", "file", "path");
      if (!path) continue;
      const movedFrom = typeof file.movePath === "string" ? pathField(file, "filePath") : undefined;
      const patch = stringField(file, "patch", "diff");
      if (patch) {
        evidence.push({
          kind: "patch",
          key: `result:file:${path}:patch`,
          text: patch,
          path,
          ...(movedFrom && movedFrom !== path ? { previousPath: movedFrom } : {}),
          format: openCodePatchFormat(patch),
          claim: "provider-reported",
        });
      }
      const additions = countField(file, "additions");
      const deletions = countField(file, "deletions");
      if (additions !== null || deletions !== null) {
        evidence.push({
          kind: "reported-counts",
          key: `result:file:${path}:counts`,
          path,
          additions,
          deletions,
          scope: "file",
          claim: "provider-reported",
        });
      }
      const operation = typeof file.type === "string" ? PATH_OPERATIONS[file.type] : undefined;
      if (operation) {
        evidence.push({
          kind: "path-operation",
          key: `result:file:${path}:operation`,
          path,
          ...(movedFrom && movedFrom !== path ? { previousPath: movedFrom } : {}),
          operation,
          claim: "provider-reported",
        });
      }
    }
  } else {
    const patch = stringField(filediff, "patch") ?? stringField(meta, "diff");
    if (patch) {
      evidence.push({
        kind: "patch",
        key: "result:patch",
        text: patch,
        ...(resultPath ? { path: resultPath } : {}),
        format: openCodePatchFormat(patch),
        claim: "provider-reported",
      });
    }
    const before = stringField(filediff, "before");
    const after = stringField(filediff, "after");
    if ((before !== undefined || after !== undefined) && resultPath) {
      // An empty `before` is a new file only when OpenCode said so; older
      // servers also reported "" when they overwrote an existing file.
      const beforeSide = before === "" ? (establishedNew ? null : undefined) : before;
      evidence.push({
        kind: "replacement",
        key: "result:replacement",
        path: resultPath,
        before: beforeSide,
        after,
        unknownReason: before === "" ? "provider-empty-before-ambiguous" : "provider-side-missing",
        extent: "whole-file",
        origin: "result",
        claim: "provider-reported",
      });
    }
    const counts =
      filediff &&
      (countField(filediff, "additions") !== null || countField(filediff, "deletions") !== null)
        ? filediff
        : meta;
    const additions = countField(counts, "additions");
    const deletions = countField(counts, "deletions");
    if (additions !== null || deletions !== null) {
      evidence.push({
        kind: "reported-counts",
        key: "result:counts",
        ...(resultPath ? { path: resultPath } : {}),
        additions,
        deletions,
        scope: "file",
        claim: "provider-reported",
      });
    }
    if (typeof meta?.exists === "boolean" && resultPath) {
      evidence.push({
        kind: "path-operation",
        key: "result:operation",
        path: resultPath,
        operation: meta.exists ? "modify" : "add",
        claim: "provider-reported",
      });
    }
  }

  // Model input: proposals, never an applied effect.
  const proposalPath = inputPath ?? resultPath;
  const oldString = stringField(input, "oldString", "old_string");
  const newString = stringField(input, "newString", "new_string");
  if (proposalPath && (oldString !== undefined || newString !== undefined)) {
    evidence.push({
      kind: "replacement",
      key: "input:replacement",
      path: proposalPath,
      before: oldString,
      after: newString,
      unknownReason: "input-side-missing",
      extent: "fragment",
      origin: "input",
      claim: "proposal",
    });
  }
  if (proposalPath && Array.isArray(input?.edits)) {
    input.edits.forEach((value, index) => {
      const edit = asRecord(value);
      const before = stringField(edit, "oldString", "old_string");
      const after = stringField(edit, "newString", "new_string");
      if (before === undefined && after === undefined) return;
      evidence.push({
        kind: "replacement",
        key: `input:edit:${index}`,
        path: proposalPath,
        before,
        after,
        unknownReason: "input-side-missing",
        extent: "fragment",
        origin: "input",
        claim: "proposal",
      });
    });
  }
  const content = name === "write" ? stringField(input, "content") : undefined;
  if (proposalPath && content !== undefined) {
    evidence.push({
      kind: "replacement",
      key: "input:content",
      path: proposalPath,
      // The prior file was not captured; it is unknown, never "".
      before: undefined,
      after: content,
      unknownReason: "prior-content-not-captured",
      extent: "whole-file",
      origin: "input",
      claim: "proposal",
    });
  }
  const patchText = stringField(input, "patchText", "patch", "diff");
  if (patchText) {
    evidence.push({
      kind: "patch",
      key: "input:patch",
      text: patchText,
      ...(proposalPath ? { path: proposalPath } : {}),
      format: openCodePatchFormat(patchText),
      claim: "proposal",
    });
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface CallState {
  sessionId: string;
  callId: string;
  toolKind: ToolKind;
  started: boolean;
  permission?: "pending" | "rejected";
  signatures: string[];
}

interface TurnState {
  turnId: string;
  outcome?: "failed" | "cancelled";
}

export interface OpenCodeChangeEvidenceOptions {
  location: OpenCodeWorkspaceLocation;
  /** Stable producer identity for {@link OpenCodeChangeEvidence.connectionSource}. */
  sourceKey?: string;
  /** The connection's shell probe, fed through this adapter. */
  commandChanges?: OpenCodeCommandChanges;
  /** Test seam; production owns a memory-only spool. */
  spool?: ChangeEvidenceSpool;
  spoolOptions?: EvidenceSpoolOptions;
}

type SseEvent = { type?: unknown; properties?: unknown };

export class OpenCodeChangeEvidence {
  readonly spool: ChangeEvidenceSpool;
  readonly recorder: ChangeEvidenceRecorder;
  private readonly calls = new Map<string, CallState>();
  private readonly turns = new Map<string, TurnState>();
  /** Assistant message id → the user message (turn) it answers. */
  private readonly messageTurns = new Map<string, string>();
  private readonly permissions = new Map<string, string>();
  /** Child session → owning (registered) session. */
  private readonly owners = new Map<string, string>();
  /** Child session → the task call that spawned it, when that is the owner's call. */
  private readonly spawningCalls = new Map<string, string>();
  private readonly sourceKey: string;
  private readonly commandChanges?: OpenCodeCommandChanges;

  /**
   * The adapter for one OpenCode connection. A directory connection's tools
   * write a host worktree; a container's `/workspace` is not a host path and
   * has no capture worker yet. The source key is the server and worktree,
   * never the credential, so a recreated provider keeps it and presents a new
   * spool epoch.
   */
  static forConnection(
    connection: Pick<BridgeConnection, "baseUrl" | "directory" | "accountId">,
    commandChanges?: OpenCodeCommandChanges,
  ): OpenCodeChangeEvidence {
    const identity = stableEvidenceId(
      connection.baseUrl,
      connection.directory ?? "container",
      connection.accountId,
    );
    return new OpenCodeChangeEvidence({
      location: connection.directory ? "host" : "container",
      sourceKey: `opencode:${identity}`,
      ...(commandChanges ? { commandChanges } : {}),
    });
  }

  constructor(options: OpenCodeChangeEvidenceOptions) {
    this.spool = options.spool ?? new ChangeEvidenceSpool(options.spoolOptions);
    this.recorder = new ChangeEvidenceRecorder({
      spool: this.spool,
      provider: OPENCODE_EVIDENCE_PROVIDER,
      capabilities: openCodeChangeCapabilities(options.location),
      executor: options.location === "host" ? "host-worker" : "container-worker",
    });
    this.sourceKey = options.sourceKey ?? `opencode:${this.spool.runtimeEpoch}`;
    this.commandChanges = options.commandChanges;
    this.commandChanges?.observeShellWindows(this.shellObservation);
  }

  /** This connection's spool as a change-tracking source. */
  connectionSource(environmentId: string): EvidenceSource {
    return this.evidenceSource(environmentId, this.sourceKey);
  }

  /** The in-process source the change-tracking service pulls. */
  evidenceSource(environmentId: string, sourceKey: string): EvidenceSource {
    const spool = this.spool;
    return {
      sourceKey,
      environmentId,
      provider: OPENCODE_EVIDENCE_PROVIDER,
      read: async (cursor, epoch) => spool.read(epoch && epoch !== spool.runtimeEpoch ? 0 : cursor),
      body: async (id) => spool.readBody(id),
      ack: async (request) => {
        spool.acknowledge(request);
      },
    };
  }

  /**
   * A dispatch this backend controls opens the turn, named by the user
   * message id it sends, then primes the shell probe's baseline.
   */
  beginTurn(sessionId: string, turnId: string): Promise<void> {
    this.guard(() => this.openTurn(sessionId, turnId));
    return this.commandChanges?.beginTurn(sessionId) ?? Promise.resolve();
  }

  /** A shell window closed by the workspace probe. */
  readonly shellObservation = (
    sessionId: string,
    callId: string,
    observation: ProbeObservation,
  ): void => {
    this.guard(() => {
      this.recorder.observation(
        { ...this.source(sessionId), callId },
        {
          boundary: observation.boundary,
          overlap: observation.overlap,
          consistency: "unknown",
          ...(observation.change ? { change: observation.change } : {}),
          omittedReasons: observation.omittedReasons,
          ...(observation.unavailableReason
            ? { unavailableReason: observation.unavailableReason }
            : {}),
        },
      );
    });
  };

  /** Feed only owned sessions and their descendants from the shared SSE feed. */
  observeScoped(event: SseEvent, ownedSessions: ReadonlySet<string>): void {
    this.commandChanges?.observeScoped(event, ownedSessions);
    this.guard(() => {
      const properties = asRecord(event.properties);
      if (event.type === "session.updated" || event.type === "session.created") {
        const session = asRecord(properties?.info);
        const parent = nonEmptyString(session?.parentID);
        const child = nonEmptyString(session?.id);
        if (parent && child) this.rememberChild(child, parent, ownedSessions);
      }
      const part = asRecord(properties?.part);
      const info = asRecord(properties?.info);
      const sessionId =
        nonEmptyString(properties?.sessionID) ??
        nonEmptyString(part?.sessionID) ??
        nonEmptyString(info?.sessionID) ??
        (event.type === "session.deleted" ? nonEmptyString(info?.id) : null);
      if (!sessionId || (!ownedSessions.has(sessionId) && !this.owners.has(sessionId))) return;
      if (part) {
        for (const child of collectRawOpenCodeSubagentIds([{ parts: [part] }])) {
          this.rememberChild(child, sessionId, ownedSessions, nonEmptyString(part.callID));
        }
      }
      this.observeEvent(event);
    });
  }

  /** Feed one event already known to belong to a tracked session. */
  observe(event: SseEvent): void {
    this.guard(() => this.observeEvent(event));
  }

  /** A released tab: drop in-memory tracking (the spool keeps what it holds). */
  forget(sessionId: string): void {
    this.commandChanges?.forget(sessionId);
    this.forgetEvidence(sessionId);
  }

  private forgetEvidence(sessionId: string): void {
    this.turns.delete(sessionId);
    for (const [key, call] of this.calls) if (call.sessionId === sessionId) this.calls.delete(key);
  }

  dispose(): void {
    this.commandChanges?.dispose();
    this.calls.clear();
    this.turns.clear();
    this.messageTurns.clear();
    this.permissions.clear();
    this.owners.clear();
    this.spawningCalls.clear();
  }

  private guard(work: () => void): void {
    try {
      work();
    } catch {
      // Evidence is best effort; the SSE handler must never fail because of it.
    }
  }

  private rememberChild(
    child: string,
    parent: string,
    ownedSessions: ReadonlySet<string>,
    callId?: string | null,
  ): void {
    const owner = ownedSessions.has(parent) ? parent : this.owners.get(parent);
    if (!owner || owner === child) return;
    setBoundedMapEntry(this.owners, child, owner, MAX_SESSIONS);
    if (callId && parent === owner)
      setBoundedMapEntry(this.spawningCalls, child, callId, MAX_SESSIONS);
  }

  private source(sessionId: string, messageId?: string | null): EvidenceSourceInput {
    const turnId =
      (messageId && this.messageTurns.get(messageId)) || this.turns.get(sessionId)?.turnId;
    const owner = this.owners.get(sessionId);
    const parentCallId = this.spawningCalls.get(sessionId);
    return {
      conversationId: sessionId,
      ...(turnId ? { turnId } : {}),
      ...(owner ? { parentConversationId: owner } : {}),
      ...(parentCallId ? { parentCallId } : {}),
    };
  }

  private observeEvent(event: SseEvent): void {
    const properties = asRecord(event.properties);
    switch (event.type) {
      case "message.part.updated": {
        const part = asRecord(properties?.part);
        const sessionId = nonEmptyString(part?.sessionID) ?? nonEmptyString(properties?.sessionID);
        if (part && sessionId && part.type === "tool") this.observeToolPart(sessionId, part);
        return;
      }
      case "message.updated": {
        const info = asRecord(properties?.info);
        const sessionId = nonEmptyString(info?.sessionID) ?? nonEmptyString(properties?.sessionID);
        const id = nonEmptyString(info?.id);
        if (!sessionId || !id) return;
        if (info?.role === "user") {
          // A turn another client started (or a subagent's) opens on its prompt.
          if (!this.turns.has(sessionId)) this.openTurn(sessionId, id);
        } else if (info?.role === "assistant") {
          const parent = nonEmptyString(info.parentID);
          if (parent) setBoundedMapEntry(this.messageTurns, id, parent, MAX_MESSAGES);
        }
        return;
      }
      case "permission.asked": {
        const sessionId = nonEmptyString(properties?.sessionID);
        const requestId = nonEmptyString(properties?.id);
        const callId = nonEmptyString(asRecord(properties?.tool)?.callID);
        if (!sessionId || !callId) return;
        const call = this.calls.get(callKey(sessionId, callId));
        if (!call) return;
        if (requestId)
          setBoundedMapEntry(
            this.permissions,
            requestId,
            callKey(sessionId, callId),
            MAX_PERMISSIONS,
          );
        call.permission = "pending";
        this.emitTool(
          call,
          "awaiting-approval",
          "not-started",
          [],
          nonEmptyString(asRecord(properties?.tool)?.messageID),
        );
        return;
      }
      case "permission.replied": {
        const requestId = nonEmptyString(properties?.requestID);
        const key = requestId ? this.permissions.get(requestId) : undefined;
        if (!requestId || !key) return;
        this.permissions.delete(requestId);
        const call = this.calls.get(key);
        if (!call || call.permission !== "pending") return;
        if (properties?.reply === "reject") {
          call.permission = "rejected";
          this.emitTool(call, "denied", "did-not-run", []);
        } else {
          call.permission = undefined;
          call.started = true;
          this.emitTool(call, "running", "started", []);
        }
        return;
      }
      case "session.error": {
        const sessionId = nonEmptyString(properties?.sessionID);
        const turn = sessionId ? this.turns.get(sessionId) : undefined;
        if (!turn) return;
        const name = nonEmptyString(asRecord(properties?.error)?.name);
        turn.outcome = name === "MessageAbortedError" ? "cancelled" : "failed";
        return;
      }
      case "session.status": {
        const sessionId = nonEmptyString(properties?.sessionID);
        if (sessionId && asRecord(properties?.status)?.type === "idle") this.settleTurn(sessionId);
        return;
      }
      case "session.idle": {
        const sessionId = nonEmptyString(properties?.sessionID);
        if (sessionId) this.settleTurn(sessionId);
        return;
      }
      case "session.deleted": {
        const info = asRecord(properties?.info);
        const sessionId = nonEmptyString(properties?.sessionID) ?? nonEmptyString(info?.id);
        if (sessionId) this.forgetEvidence(sessionId);
        return;
      }
    }
  }

  private openTurn(sessionId: string, turnId: string): void {
    setBoundedMapEntry(this.turns, sessionId, { turnId }, MAX_SESSIONS);
    this.recorder.turn({ ...this.source(sessionId), turnId }, "running", "may-write");
  }

  private settleTurn(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    // Idle is terminal for OpenCode's loop; whether a detached writer lives
    // on is not observable, so liveness stays unknown.
    this.recorder.turn(
      { ...this.source(sessionId), turnId: turn.turnId },
      turn.outcome ?? "succeeded",
      "unknown",
    );
  }

  private observeToolPart(sessionId: string, part: Record<string, unknown>): void {
    const callId = nonEmptyString(part.callID);
    const tool = nonEmptyString(part.tool);
    const state = asRecord(part.state);
    const status = state?.status;
    if (!callId || !tool || !state) return;
    const key = callKey(sessionId, callId);
    let call = this.calls.get(key);
    if (!call) {
      call = {
        sessionId,
        callId,
        toolKind: openCodeToolKind(tool),
        started: false,
        signatures: [],
      };
      setBoundedMapEntry(this.calls, key, call, MAX_CALLS);
    }
    const evidence = openCodeToolEvidence(tool, state, state.title);
    let phase: ToolPhase;
    let occurrence: ExecutionOccurrence;
    if (status === "pending") {
      phase = call.permission === "pending" ? "awaiting-approval" : "running";
      occurrence = "not-started";
    } else if (status === "running") {
      if (call.permission === "pending") {
        phase = "awaiting-approval";
        occurrence = "not-started";
      } else {
        call.started = true;
        phase = "running";
        occurrence = "started";
      }
    } else if (status === "completed") {
      call.started = true;
      phase = "succeeded";
      occurrence = "started";
    } else if (status === "error") {
      if (call.permission === "rejected") {
        phase = "denied";
        occurrence = "did-not-run";
      } else {
        phase = "failed";
        occurrence = call.started ? "started" : "unknown";
      }
    } else {
      return;
    }
    if (phase !== "awaiting-approval" && status !== "error") call.permission = undefined;
    this.emitTool(call, phase, occurrence, evidence, nonEmptyString(part.messageID));
  }

  /**
   * Emit one tool frame unless this exact lifecycle + evidence was already
   * emitted for the call. A settling update carries only the blocks it still
   * has; blocks it omits keep their earlier revisions.
   */
  private emitTool(
    call: CallState,
    phase: ToolPhase,
    occurrence: ExecutionOccurrence,
    evidence: readonly EvidenceInput[],
    messageId?: string | null,
  ): void {
    const signature = stableEvidenceId(phase, occurrence, call.toolKind, JSON.stringify(evidence));
    if (call.signatures.includes(signature)) return;
    call.signatures.push(signature);
    if (call.signatures.length > MAX_SIGNATURES_PER_CALL) call.signatures.shift();
    this.recorder.tool(
      { ...this.source(call.sessionId, messageId), callId: call.callId },
      { toolKind: call.toolKind, phase, executionOccurrence: occurrence, evidence },
    );
  }
}

function callKey(sessionId: string, callId: string): string {
  return `${sessionId}\0${callId}`;
}
