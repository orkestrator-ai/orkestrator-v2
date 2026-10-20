/**
 * The ACP bridge's change-evidence adapter (see
 * `docs/architecture/change-tracking.md`, "Writing a provider adapter").
 *
 * It turns ACP tool-call frames into canonical {@link ProviderEvidenceFrame}s
 * and appends them to one {@link ChangeEvidenceSpool} per process, which the
 * backend pulls through `GET /change-evidence`. It never counts lines.
 *
 * Identities:
 * - `conversationId` is the bridge session id — the id the backend addresses
 *   in `/session/:id` and stores as its provider session id — never the ACP
 *   agent's own `sessionId`, which a resume or respawn can change underneath.
 * - `callId` is the ACP `toolCallId`, exactly the `toolUseId` on the
 *   transcript part. An agent may reuse an id in a later turn (see
 *   `acp-tools.ts`); a reused id that this bridge renders as a second card
 *   gets an `attemptId` naming the turn, so it cannot fold into the finished
 *   operation of the earlier card.
 * - `turnId` is the backend's prompt `requestId` when it sent one.
 *
 * Evidence per call: each ACP `diff` content block is its own block, keyed by
 * its path and its ordinal among blocks for that path. ACP's `oldText` is
 * "the original content (None for new files)", so a null or omitted
 * `oldText` is established absence. ACP does not promise whole-file
 * contents (some agents send the edited fragment), so the extent is unknown.
 * While the call has not completed its blocks are proposals; once it
 * completes they are provider-reported results under separate keys. A later
 * update that replaces the call's content is a new revision of the same keys.
 *
 * Nothing here awaits anything: every entry point runs on the JSON-RPC read
 * loop or a request handler and only appends to the in-memory spool.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  MAX_EVIDENCE_PATH_LENGTH,
  type ExecutionOccurrence,
  type ProviderChangeCapabilities,
  type ToolKind,
  type ToolPhase,
} from "@orkestrator/protocol/change-evidence";
import {
  ChangeEvidenceRecorder,
  type EvidenceInput,
} from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import {
  acpToolSourceStates,
  providerConfig,
  stateDirectory,
  type BridgeToolPart,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import { findToolPart, turnStartIndex } from "./acp-rows.js";
import {
  acpRuntimeDescriptor,
  acpToolKind,
  isAcpShellCall,
  isBackgroundLaunch,
  type AcpRuntimeDescriptor,
} from "./acp-tool-classification.js";

/** Diff blocks read from one update; a frame carries at most 256 updates. */
const MAX_DIFF_BLOCKS_PER_CALL = 100;
/** Raw diff text held for calls that have not completed yet, process-wide. */
const MAX_HELD_DIFF_BYTES = 32 * 1024 * 1024;
/** Call ids remembered per session to notice an id the agent reused. */
const MAX_SEEN_CALL_IDS = 8_192;
/** Approval outcomes parked for a call the agent has not announced yet. */
const MAX_PENDING_APPROVALS = 64;

/**
 * `ACP_MEASURE_COMMAND_CHANGES=0` switches the shell probe off; the same
 * setting tells the backend this bridge cannot capture.
 */
export function commandMeasurementSetting(environment: NodeJS.ProcessEnv = process.env): boolean {
  const setting = environment.ACP_MEASURE_COMMAND_CHANGES?.trim().toLowerCase();
  return !(setting === "0" || setting === "false" || setting === "off");
}

/**
 * Where the shell probe runs. The Orkestrator image exports
 * `DEVCONTAINER=true`; a host bridge is one the host backend launched with a
 * state directory under its data directory. Anything else is unknown.
 */
export function acpCaptureExecutor(
  environment: NodeJS.ProcessEnv = process.env,
): ProviderChangeCapabilities["captureExecutor"] {
  if (environment.DEVCONTAINER?.trim().toLowerCase() === "true") return "container-worker";
  if (environment.ACP_STATE_DIR?.trim()) return "host-worker";
  return "unknown";
}

/** The capabilities this bridge establishes for one runtime. */
export function acpChangeCapabilities(
  runtime: AcpRuntimeDescriptor,
  options: {
    measurementEnabled: boolean;
    executor: ProviderChangeCapabilities["captureExecutor"];
  },
): Omit<ProviderChangeCapabilities, "capabilityRevision"> {
  return {
    resolution: "resolved",
    // ACP reports a call only once the agent has started it (Grok runs with
    // `--always-approve`), so the probe's "before" is the latest snapshot.
    beforeTool: "observed-after-start",
    afterTool: "observed",
    // The bridge dispatches `session/prompt` itself, after `prime`.
    beforeTurn: "controlled-dispatch",
    afterTurn: "terminal-observed",
    // The vendor replays tool calls under their ids on `session/load`, but an
    // agent may reuse an id in a later turn.
    historicalCallIdentity: "partial",
    fileEvidence: { resolution: "confirmed", kinds: ["replacement", "patch"] },
    turnDiff: "absent",
    captureExecutor: options.executor,
    captureAvailability: options.measurementEnabled ? "ready" : "unavailable",
    backgroundCompletion: runtime.backgroundCompletion,
  };
}

// ---------------------------------------------------------------------------
// Process-wide spool and recorder
// ---------------------------------------------------------------------------

let spool: ChangeEvidenceSpool | undefined;
let recorder: ChangeEvidenceRecorder | undefined;
let runtime: AcpRuntimeDescriptor = acpRuntimeDescriptor(providerConfig.id);
let measurementEnabled: boolean | undefined;

/**
 * Replace the spool or the measurement setting. In-process tests use this
 * instead of mutating the environment other suites share.
 */
export function configureChangeEvidence(options: {
  spool?: ChangeEvidenceSpool | null;
  measurementEnabled?: boolean;
  runtime?: AcpRuntimeDescriptor;
}): void {
  if ("spool" in options) spool = options.spool ?? undefined;
  if ("measurementEnabled" in options) measurementEnabled = options.measurementEnabled;
  if (options.runtime) runtime = options.runtime;
  recorder = undefined;
}

export function changeEvidenceSpool(): ChangeEvidenceSpool {
  // Persisted next to `command-changes`, so unacknowledged evidence survives
  // a bridge restart.
  spool ??= new ChangeEvidenceSpool(
    stateDirectory ? { directory: resolve(stateDirectory, "change-evidence") } : {},
  );
  return spool;
}

export function changeEvidenceRecorder(): ChangeEvidenceRecorder {
  if (!recorder) {
    const executor = acpCaptureExecutor();
    recorder = new ChangeEvidenceRecorder({
      spool: changeEvidenceSpool(),
      provider: runtime.name,
      capabilities: acpChangeCapabilities(runtime, {
        measurementEnabled: measurementEnabled ?? commandMeasurementSetting(),
        executor,
      }),
      ...(executor === "container-worker" ? { executor: "container-worker" as const } : {}),
    });
  }
  return recorder;
}

// ---------------------------------------------------------------------------
// Per-call state
// ---------------------------------------------------------------------------

interface AcpDiffBlock {
  path?: string;
  /** string present, null established absence, undefined unknown. */
  oldText: string | null | undefined;
  newText: string | undefined;
  /** A unified diff the agent supplied itself (an extension field). */
  diff?: string;
}

interface CallRecord {
  callId: string;
  attemptId?: string;
  turnId?: string;
  /** The raw ACP status, which tells `pending` from `in_progress`. */
  status?: string;
  awaitingApproval: boolean;
  /** A parked request was allowed; the agent has not reported the run yet. */
  approved: boolean;
  denied: boolean;
  /** Latest content diffs; released once the call is terminal. */
  diffs: AcpDiffBlock[];
  heldBytes: number;
  contentVersion: number;
  proposalVersion: number;
  resultVersion: number;
  phase?: ToolPhase;
  lastSignature?: string;
}

interface SessionEvidence {
  /** Records for calls that have not reached a terminal phase. */
  open: Map<BridgeToolPart, CallRecord>;
  /** The newest record per call id, for a probe window that ends later. */
  byCallId: Map<string, CallRecord>;
  seenCallIds: Set<string> | undefined;
  pendingApprovals: Map<string, "awaiting" | "denied">;
  turn?: { turnId: string; backgroundLaunched: boolean };
}

const records = new WeakMap<BridgeToolPart, CallRecord>();
const sessionEvidence = new WeakMap<SessionState, SessionEvidence>();
/** Records holding diff text, oldest first, for the process-wide byte bound. */
const holding = new Map<CallRecord, number>();
let heldBytes = 0;

function evidenceFor(state: SessionState): SessionEvidence {
  let evidence = sessionEvidence.get(state);
  if (!evidence) {
    evidence = {
      open: new Map(),
      byCallId: new Map(),
      seenCallIds: undefined,
      pendingApprovals: new Map(),
    };
    sessionEvidence.set(state, evidence);
  }
  return evidence;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function seenCallIds(state: SessionState, evidence: SessionEvidence): Set<string> {
  if (!evidence.seenCallIds) {
    // Seeded once from the transcript, so a reuse is still noticed after a
    // restart restored the earlier card from disk.
    evidence.seenCallIds = new Set();
    for (const message of state.messages) {
      for (const part of message.parts) {
        if (part.type === "tool-invocation") evidence.seenCallIds.add(part.toolUseId);
      }
    }
  }
  return evidence.seenCallIds;
}

/** Whether another card in the transcript carries `part`'s call id. */
function isReusedCallId(state: SessionState, evidence: SessionEvidence, part: BridgeToolPart) {
  const seen = seenCallIds(state, evidence);
  const id = part.toolUseId;
  if (!seen.has(id)) {
    seen.add(id);
    if (seen.size > MAX_SEEN_CALL_IDS) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  }
  for (const message of state.messages) {
    for (const other of message.parts) {
      if (other !== part && other.type === "tool-invocation" && other.toolUseId === id) {
        return true;
      }
    }
  }
  return false;
}

function recordFor(state: SessionState, part: BridgeToolPart): CallRecord {
  let record = records.get(part);
  if (record) return record;
  const evidence = evidenceFor(state);
  const turnId = evidence.turn?.turnId;
  const approval = evidence.pendingApprovals.get(part.toolUseId);
  evidence.pendingApprovals.delete(part.toolUseId);
  record = {
    callId: part.toolUseId,
    ...(isReusedCallId(state, evidence, part)
      ? { attemptId: `reuse:${turnId ?? randomUUID()}` }
      : {}),
    ...(turnId ? { turnId } : {}),
    awaitingApproval: approval === "awaiting",
    approved: false,
    denied: approval === "denied",
    diffs: [],
    heldBytes: 0,
    contentVersion: 0,
    proposalVersion: 0,
    resultVersion: 0,
  };
  records.set(part, record);
  evidence.open.set(part, record);
  remember(evidence.byCallId, part.toolUseId, record, MAX_SEEN_CALL_IDS);
  return record;
}

function releaseDiffs(record: CallRecord): void {
  if (holding.delete(record)) heldBytes -= record.heldBytes;
  record.diffs = [];
  record.heldBytes = 0;
}

function holdDiffs(record: CallRecord, diffs: AcpDiffBlock[]): void {
  releaseDiffs(record);
  const bytes = diffs.reduce(
    (total, diff) =>
      total + (diff.oldText?.length ?? 0) + (diff.newText?.length ?? 0) + (diff.diff?.length ?? 0),
    0,
  );
  record.diffs = diffs;
  record.heldBytes = bytes;
  if (bytes === 0) return;
  holding.set(record, bytes);
  heldBytes += bytes;
  // The oldest unfinished calls lose their text first; a call that later
  // completes without re-sending its content then reports no result block
  // rather than a wrong one.
  for (const [oldest] of holding) {
    if (heldBytes <= MAX_HELD_DIFF_BYTES || oldest === record) break;
    releaseDiffs(oldest);
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidencePath(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EVIDENCE_PATH_LENGTH &&
    !value.includes("\0")
    ? value
    : undefined;
}

/** Every `diff` block of an ACP `content` array, in order. */
export function acpDiffBlocks(content: unknown): AcpDiffBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: AcpDiffBlock[] = [];
  for (const item of content) {
    if (!isObject(item) || item.type !== "diff") continue;
    if (blocks.length >= MAX_DIFF_BLOCKS_PER_CALL) break;
    const path = evidencePath(item.path);
    const oldText =
      typeof item.oldText === "string"
        ? item.oldText
        : item.oldText === null || item.oldText === undefined
          ? null
          : undefined;
    const newText = typeof item.newText === "string" ? item.newText : undefined;
    const diff = typeof item.diff === "string" && item.diff ? item.diff : undefined;
    if (!path && !diff) continue;
    blocks.push({ ...(path ? { path } : {}), oldText, newText, ...(diff ? { diff } : {}) });
  }
  return blocks;
}

/**
 * Evidence blocks for the call's diffs. Keys depend on a block's path and its
 * ordinal among that path's blocks, not on its position among other files,
 * so a re-sent content array revises the same blocks.
 */
export function acpDiffEvidence(
  diffs: readonly AcpDiffBlock[],
  mode: "proposal" | "result",
): EvidenceInput[] {
  const ordinals = new Map<string, number>();
  const prefix = mode === "proposal" ? "proposal:" : "";
  const claim = mode === "proposal" ? "proposal" : "provider-reported";
  const inputs: EvidenceInput[] = [];
  for (const block of diffs) {
    const pathKey = block.path ?? "";
    const ordinal = ordinals.get(pathKey) ?? 0;
    ordinals.set(pathKey, ordinal + 1);
    const suffix = `${pathKey}:${ordinal}`;
    if (block.path) {
      inputs.push({
        kind: "replacement",
        key: `${prefix}diff:${suffix}`,
        path: block.path,
        before: block.oldText,
        after: block.newText,
        unknownReason: "acp-diff-text-not-supplied",
        extent: "unknown",
        origin: mode === "proposal" ? "input" : "result",
        claim,
      });
    }
    if (block.diff) {
      inputs.push({
        kind: "patch",
        key: `${prefix}patch:${suffix}`,
        text: block.diff,
        ...(block.path ? { path: block.path } : {}),
        format: "git_unified",
        claim,
      });
    }
  }
  return inputs;
}

function lifecycle(record: CallRecord): { phase: ToolPhase; occurrence: ExecutionOccurrence } {
  if (record.denied) return { phase: "denied", occurrence: "did-not-run" };
  switch (record.status) {
    case "completed":
      return { phase: "succeeded", occurrence: "started" };
    case "failed":
      return { phase: "failed", occurrence: "unknown" };
    case "cancelled":
      return { phase: "cancelled", occurrence: "unknown" };
  }
  if (record.awaitingApproval) return { phase: "awaiting-approval", occurrence: "not-started" };
  if (record.status === "in_progress") return { phase: "running", occurrence: "started" };
  // Allowed but not yet reported running. Frame ids are content-derived, so
  // this must differ from the frame before the request or it would dedupe.
  if (record.approved) return { phase: "running", occurrence: "not-started" };
  // `pending` (or no status yet): input may still be streaming. Grok reports
  // a call once it has started, other agents before; neither is established.
  return { phase: "running", occurrence: "unknown" };
}

function isTerminal(phase: ToolPhase): boolean {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled" || phase === "denied";
}

function emit(
  state: SessionState,
  record: CallRecord,
  toolKind: ToolKind,
  phase: ToolPhase,
  occurrence: ExecutionOccurrence,
  evidence: EvidenceInput[],
): void {
  const signature = `${toolKind}\0${phase}\0${occurrence}`;
  if (evidence.length === 0 && signature === record.lastSignature) return;
  record.lastSignature = signature;
  record.phase = phase;
  changeEvidenceRecorder().tool(
    {
      conversationId: state.id,
      callId: record.callId,
      ...(record.attemptId ? { attemptId: record.attemptId } : {}),
      ...(record.turnId ? { turnId: record.turnId } : {}),
    },
    { toolKind, phase, executionOccurrence: occurrence, evidence },
  );
}

function toolKindOf(part: BridgeToolPart): ToolKind {
  const source = acpToolSourceStates.get(part);
  return source ? acpToolKind(source, runtime) : "other";
}

function settleRecord(state: SessionState, part: BridgeToolPart, record: CallRecord): void {
  evidenceFor(state).open.delete(part);
  releaseDiffs(record);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Follow one live `tool_call` / `tool_call_update` after the bridge applied
 * it to `part`. Late naming re-classifies the same operation; it never opens
 * another one.
 */
export function recordAcpToolEvidence(
  state: SessionState,
  part: BridgeToolPart,
  update: JsonObject,
): void {
  // A replayed transcript is not this process's observation, and replayed
  // ids cannot be told from reused ones.
  if (state.historyReplay !== false) return;
  try {
    const record = recordFor(state, part);
    if (typeof update.status === "string") record.status = update.status;
    else if (update.status === null) record.status = undefined;
    if ("content" in update) {
      holdDiffs(record, acpDiffBlocks(update.content));
      record.contentVersion += 1;
    }
    const source = acpToolSourceStates.get(part);
    if (source && isAcpShellCall(source) && isBackgroundLaunch(source.toolArgs)) {
      const turn = evidenceFor(state).turn;
      if (turn) turn.backgroundLaunched = true;
    }
    const { phase, occurrence } = lifecycle(record);
    let evidence: EvidenceInput[] = [];
    if (record.diffs.length > 0) {
      if (phase === "succeeded" && record.resultVersion !== record.contentVersion) {
        record.resultVersion = record.contentVersion;
        evidence = acpDiffEvidence(record.diffs, "result");
      } else if (phase !== "succeeded" && record.proposalVersion !== record.contentVersion) {
        record.proposalVersion = record.contentVersion;
        evidence = acpDiffEvidence(record.diffs, "proposal");
      }
    }
    emit(state, record, toolKindOf(part), phase, occurrence, evidence);
    if (isTerminal(phase)) settleRecord(state, part, record);
  } catch (error) {
    // Evidence is an audit side channel; it must never fail the read loop.
    console.warn(
      `[acp-bridge] Failed to record change evidence: ${
        error instanceof Error ? error.name : "unknown error"
      }`,
    );
  }
}

/**
 * A permission request for `toolCallId` was parked, allowed or refused. A
 * request may name a call the agent has not announced yet; its outcome then
 * waits for the call's first frame.
 */
export function recordAcpToolApproval(
  state: SessionState,
  toolCallId: unknown,
  outcome: "awaiting" | "allowed" | "denied",
): void {
  if (typeof toolCallId !== "string" || !toolCallId || state.historyReplay !== false) return;
  const evidence = evidenceFor(state);
  const part = findToolPart(state, toolCallId, turnStartIndex(state))?.part;
  if (!part) {
    if (outcome === "allowed") evidence.pendingApprovals.delete(toolCallId);
    else remember(evidence.pendingApprovals, toolCallId, outcome, MAX_PENDING_APPROVALS);
    return;
  }
  const record = recordFor(state, part);
  if (record.phase && isTerminal(record.phase)) return;
  record.awaitingApproval = outcome === "awaiting";
  record.approved = outcome === "allowed";
  record.denied = outcome === "denied";
  const { phase, occurrence } = lifecycle(record);
  emit(state, record, toolKindOf(part), phase, occurrence, []);
  if (isTerminal(phase)) settleRecord(state, part, record);
}

/**
 * Report what the shell probe observed around a call. The probe's own
 * boundary labels travel unchanged: a command recognised only after it ran
 * was measured from the prior snapshot (`prior-observation`) or a late one
 * (`late-start`), never from a fresh "before".
 */
export function recordAcpShellObservation(
  state: SessionState,
  toolUseId: string,
  observation: ProbeObservation,
): void {
  try {
    const record = evidenceFor(state).byCallId.get(toolUseId);
    changeEvidenceRecorder().observation(
      {
        conversationId: state.id,
        callId: toolUseId,
        ...(record?.attemptId ? { attemptId: record.attemptId } : {}),
        ...(record?.turnId ? { turnId: record.turnId } : {}),
      },
      {
        boundary: observation.boundary,
        overlap: observation.overlap,
        ...(observation.change ? { change: observation.change } : {}),
        omittedReasons: observation.omittedReasons,
        ...(observation.unavailableReason
          ? { unavailableReason: observation.unavailableReason }
          : {}),
      },
    );
  } catch (error) {
    console.warn(
      `[acp-bridge] Failed to record a shell observation: ${
        error instanceof Error ? error.name : "unknown error"
      }`,
    );
  }
}

/** The bridge is about to dispatch a turn's `session/prompt`. */
export function beginAcpTurnEvidence(state: SessionState, requestId: string | undefined): void {
  const turnId = requestId || `turn:${randomUUID()}`;
  evidenceFor(state).turn = { turnId, backgroundLaunched: false };
  changeEvidenceRecorder().turn({ conversationId: state.id, turnId }, "running", "may-write");
}

/**
 * The turn's `session/prompt` settled. Calls the turn left without a terminal
 * status (`reconcileStaleToolParts` settles their cards) end with it; a call
 * still running — a background sub-agent's child — stays open.
 */
export function endAcpTurnEvidence(
  state: SessionState,
  outcome: "succeeded" | "failed" | "cancelled",
): void {
  const evidence = sessionEvidence.get(state);
  if (!evidence) return;
  try {
    for (const [part, record] of Array.from(evidence.open)) {
      if (part.toolState !== "success" && part.toolState !== "failure") continue;
      if (record.phase && isTerminal(record.phase)) {
        settleRecord(state, part, record);
        continue;
      }
      emit(
        state,
        record,
        toolKindOf(part),
        outcome === "cancelled" ? "cancelled" : "failed",
        "unknown",
        [],
      );
      settleRecord(state, part, record);
    }
    const turn = evidence.turn;
    if (!turn) return;
    evidence.turn = undefined;
    const writers =
      state.activeSubagentToolIds.size > 0 || turn.backgroundLaunched ? "may-write" : "quiescent";
    changeEvidenceRecorder().turn(
      { conversationId: state.id, turnId: turn.turnId },
      outcome,
      writers,
    );
  } catch (error) {
    console.warn(
      `[acp-bridge] Failed to record turn change evidence: ${
        error instanceof Error ? error.name : "unknown error"
      }`,
    );
  }
}
