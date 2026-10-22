/**
 * Proof that a live runtime adopted a saved configuration.
 *
 * Planning leaves a Claude, Cursor or Pi session at `pending-next-turn` and a
 * Grok session at `restart-required`. Those states are the backend's plan,
 * not an observation. This module turns them into `applied` only when the
 * runtime's own bridge reports — through its no-touch `/runtime-health` read
 * — that the configuration it is running was read from the saved bytes.
 *
 * The rule, for every provider, is:
 *
 * 1. The bridge reports a `sha256:<base64url>` digest for the file the saved
 *    source lives in (`user` or `project`), and says when that configuration
 *    was read (Claude: the query start; Cursor/Pi: the generation build; Grok:
 *    the child's MCP listing). `absent`, `excluded` or a missing field is not
 *    evidence, so an older bridge — or a session whose policy excludes the
 *    file — simply stays where planning left it.
 * 2. That read happened at or after the moment the save began writing.
 * 3. The digest equals the digest of the bytes the save wrote, **or** it
 *    equals the digest of the file as it is now and the saved change is still
 *    present in that file. The second arm exists because `~/.claude.json` is
 *    rewritten by unrelated Claude activity: a query that read a later
 *    revision still carrying the change has adopted it; a query that read a
 *    revision which no longer carries it has not.
 * 4. Grok only: its MCP evidence is process-level (whichever child reported
 *    last), so it is accepted only after the bridge process itself was
 *    replaced since apply was planned. Every child of a newer bridge was
 *    spawned after the save, so no session can still hold a pre-save child.
 * 5. A removal or rename is not applied while the runtime still runs the old
 *    server. A Claude CLI kept alive by background work reports the servers
 *    it could not unload (`staleServers`); its bridge refuses their tools, and
 *    the runtime is `restart-required` until a later query (a new CLI) shows
 *    the server gone.
 *
 * Every runtime has a generation: the bridge process and provider session
 * behind it, read from persisted records before and after the bridge reads. A
 * read during which the generation changed is not attributed to either one and
 * is retried. `applied` is stamped with the generation that proved it, and
 * says so when that is a newer run than the one apply planned against.
 *
 * A bridge that answers without the MCP configuration report is older than
 * it: it cannot prove an apply, and Cursor and Pi bridges that old do not
 * reload between turns either. The runtime says so (`restart-required`, or a
 * Claude `pending-next-turn` not confirmed until the bridge reports a query)
 * instead of waiting silently, and polling continues so a restarted bridge can
 * still prove it.
 *
 * Each pass also re-reads the source of every operation it polled and applies
 * the external-edit rule in `external-edits.ts`; `external-edit-watch.ts`
 * does the same for waiting operations this pass never polls.
 *
 * Polling is bounded: at most {@link EVIDENCE_READS_PER_TICK} reads per tick,
 * each runtime at most once per {@link EVIDENCE_RECHECK_MS}, each read capped
 * at {@link EVIDENCE_READ_TIMEOUT_MS}, and none after
 * {@link EVIDENCE_WINDOW_MS} from when apply was planned. A runtime that is
 * never proven keeps its planned state; nothing here ever reports failure.
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpApplyState, McpRuntimeApplyEntry } from "@orkestrator/protocol/mcp-management";

import type { RuntimeProbe } from "./apply.js";
import { heldRuntimes, noteOnce, retireSuperseded, sourceDrift } from "./external-edits.js";
import type { StoredOperation } from "./operations-store.js";

export const EVIDENCE_WINDOW_MS = 24 * 60 * 60_000;
export const EVIDENCE_READS_PER_TICK = 8;
export const EVIDENCE_RECHECK_MS = 10_000;
export const EVIDENCE_READ_TIMEOUT_MS = 10_000;

/**
 * Which reported file a saved source is. `local` is Claude's private-local map
 * (`projects[<worktree>]` inside `~/.claude.json`): same file as `user`, but a
 * query only loads it when its source scope is `all`, so the bridge's `user`
 * digest proves it only then.
 */
export type EvidenceRole = "user" | "project" | "local";

/** What a bridge reports about the configuration a runtime is running. */
export interface RuntimeConfigEvidence {
  /** `sha256:<base64url>`, `absent` or `excluded` per file; missing when unreported. */
  sources: { user?: string; project?: string; local?: string };
  /** When that configuration was read. */
  observedAt: string;
  /** `process` when the bridge cannot attribute the load to one session (Grok). */
  scope: "session" | "process";
  /** Servers the configuration dropped that the runtime still runs. */
  staleServers?: readonly string[];
}

export type RuntimeEvidenceRead =
  | { state: "evidence"; evidence: RuntimeConfigEvidence }
  /** The bridge reports, but has nothing loaded yet; or the read failed. */
  | { state: "none" }
  /** The bridge is older than the MCP configuration report. */
  | { state: "unsupported" }
  /** No bridge is running; nothing was started to find out. */
  | { state: "not-running" };

const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;

export function isContentDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

/**
 * Which reported file a saved source is, for the providers whose bridges
 * report one. Claude's user and private-local entries share `~/.claude.json`.
 */
export function evidenceRole(provider: AgentPlatform, sourceId: string): EvidenceRole | undefined {
  switch (provider) {
    case "claude":
      if (sourceId === "claude:user") return "user";
      if (sourceId === "claude:local") return "local";
      return sourceId === "claude:project" ? "project" : undefined;
    case "cursor":
    case "grok":
    case "pi":
      if (sourceId === `${provider}:user`) return "user";
      return sourceId === `${provider}:project` ? "project" : undefined;
    default:
      return undefined;
  }
}

/**
 * Whether a planned runtime in `state` is waiting for evidence at all. A
 * Cursor or Pi runtime is `restart-required` only behind an older bridge, and
 * a restarted bridge can still prove it.
 */
export function awaitsEvidenceIn(provider: AgentPlatform, state: McpApplyState): boolean {
  switch (provider) {
    case "claude":
    case "cursor":
    case "grok":
    case "pi":
      return state === "pending-next-turn" || state === "restart-required";
    default:
      return false;
  }
}

/** Shared by polling and retention: evidence-waiting records survive history pressure. */
export function operationAwaitsEvidence(stored: StoredOperation, nowMs: number): boolean {
  const { recovery, snapshot } = stored;
  if (snapshot.phase !== "saved") return false;
  if (!recovery.savedDigest || !recovery.writeStartedAt || !recovery.evidenceRole) return false;
  const queuedAt = Date.parse(recovery.applyQueuedAt ?? "");
  if (!Number.isFinite(queuedAt) || nowMs - queuedAt > EVIDENCE_WINDOW_MS) return false;
  return snapshot.apply.runtimes.some((runtime) => {
    const record = recovery.runtimes?.find(
      (candidate) => candidate.runtimeId === runtime.runtimeId,
    );
    return (
      !!record?.awaitsEvidence &&
      !!record.logicalSessionKey &&
      awaitsEvidenceIn(record.agent as AgentPlatform, runtime.state)
    );
  });
}

/**
 * The digest a report offers as evidence for `role`, or undefined when it
 * offers none: an unreported slot, `absent`/`excluded`, or a read that
 * predates the save.
 */
export function evidenceDigest(
  evidence: RuntimeConfigEvidence,
  role: EvidenceRole,
  writeStartedAtMs: number,
): string | undefined {
  const observed = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(writeStartedAtMs)) return undefined;
  if (observed < writeStartedAtMs) return undefined;
  const digest = evidence.sources[role];
  return isContentDigest(digest) ? digest : undefined;
}

/** The saved source as it is now: its digest and whether it still carries the change. */
export interface CurrentSourceState {
  digest: string;
  landed: boolean;
  /** Keyed digest of the parsed server list, comparable with `savedEntriesDigest`. */
  entriesDigest?: string;
  /** The server list is exactly what a later save of this source left. */
  replacedBySave?: boolean;
}

/**
 * Apply rule 3 above. `current` is read lazily — only when the report does
 * not match the saved bytes directly — because it means reading and parsing
 * the source file.
 */
export async function evidenceShowsSave(
  digest: string,
  savedDigest: string,
  current: () => Promise<CurrentSourceState | undefined>,
): Promise<boolean> {
  if (digest === savedDigest) return true;
  const now = await current();
  return !!now && now.landed && now.digest === digest;
}

/**
 * The Claude bridge keeps a session's CLI open between messages (an idle
 * window, 10 minutes by default) as well as while background work runs, so
 * "background work" alone would misdescribe the usual case.
 */
export const STILL_LOADED_REASON =
  "This session's Claude process is still open, so the removed server stays loaded and its tools are refused. It closes once the session has been idle for a while (10 minutes by default) with no background work left; stop the session to unload it now.";

/** The server a removal or rename takes away, which must not still be loaded. */
function removedServer(stored: StoredOperation): string | undefined {
  const { kind } = stored.snapshot;
  return kind === "remove" || kind === "rename" ? stored.recovery.name : undefined;
}

export function appliedReason(provider: AgentPlatform): string {
  switch (provider) {
    case "claude":
      return "The session's latest message started with the saved configuration.";
    case "grok":
      return "Grok restarted and loaded the saved configuration.";
    default:
      return "The session rebuilt its MCP servers from the saved configuration.";
  }
}

/** `applied` proven by a newer run than the one apply was planned against. */
export const NEWER_RUN_REASON =
  "A newer run of this session, started after apply was planned, loaded the saved configuration.";

const BRIDGE_LABEL: Partial<Record<AgentPlatform, string>> = {
  claude: "Claude",
  cursor: "Cursor",
  grok: "Grok Build",
  pi: "Pi",
};

/**
 * What a runtime behind a bridge older than the MCP configuration report is
 * told. Claude bridges that old still re-read their files at every query, so
 * the change loads; bridges since #838 report what a query loaded once one
 * has run, which confirms it with no restart (seen live on 2026-10-18), and
 * only one older still never does. Cursor and Pi bridges that old do not
 * reload between turns, and Grok only ever loads on restart.
 */
export function olderBridgeOutcome(provider: AgentPlatform): {
  state: McpApplyState;
  reason: string;
} {
  const label = BRIDGE_LABEL[provider] ?? provider;
  if (provider === "claude") {
    return {
      state: "pending-next-turn",
      reason: `This ${label} bridge is older than this backend and does not report what it loads. The change loads on the session's next message and is confirmed once the bridge reports that message's query; if it never does, restart the environment to confirm it.`,
    };
  }
  return {
    state: "restart-required",
    reason:
      provider === "grok"
        ? `This ${label} bridge is older than this backend and cannot confirm what it loaded. Stop and start the environment to load the change.`
        : `This ${label} bridge is older than this backend and may not reload MCP servers between turns. Stop and start the environment to load the change.`,
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type RecoveryRuntime = NonNullable<StoredOperation["recovery"]["runtimes"]>[number];

interface Candidate {
  stored: StoredOperation;
  runtimes: McpRuntimeApplyEntry[];
  runtime: McpRuntimeApplyEntry;
  record: RecoveryRuntime & { logicalSessionKey: string };
  key: string;
}

/** Runtime generations as persisted records describe them at one moment. */
export interface RuntimeGenerations {
  /** The opaque generation of one runtime now, or undefined when unknown. */
  of(
    environmentId: string,
    agent: AgentPlatform,
    logicalSessionKey: string,
  ): Promise<string | undefined>;
  /** The provider bridge's recorded process id now. */
  bridgePid(environmentId: string, agent: AgentPlatform): number | undefined;
}

export interface EvidenceSchedulerDeps {
  probe: RuntimeProbe;
  now: () => number;
  /** A provider whose apply is paused by the rollout gate is not polled. */
  blocked: (provider: AgentPlatform) => boolean;
  /** The saved source as it is now, for rule 3 and the external-edit rule. */
  currentSource: (stored: StoredOperation) => Promise<CurrentSourceState | undefined>;
  /** Reads every runtime's generation from persisted records. */
  generations: () => Promise<RuntimeGenerations>;
  /** Persist and publish an operation whose runtimes changed. */
  commit: (stored: StoredOperation) => Promise<void>;
}

/**
 * Polls bridges for evidence, off any request path. Holds only in-memory
 * pacing: after a backend restart every runtime is simply due again.
 */
export class EvidenceScheduler {
  private readonly nextCheck = new Map<string, number>();

  constructor(private readonly deps: EvidenceSchedulerDeps) {}

  /** Whether any runtime is still inside its evidence window. Keeps the timer alive. */
  hasWork(operations: readonly StoredOperation[]): boolean {
    return this.candidates(operations, this.deps.now()).length > 0;
  }

  private candidates(operations: readonly StoredOperation[], nowMs: number): Candidate[] {
    const found: Candidate[] = [];
    for (const stored of operations) {
      const recovery = stored.recovery;
      if (!operationAwaitsEvidence(stored, nowMs)) continue;
      if (this.deps.blocked(stored.snapshot.provider)) continue;
      const runtimes = stored.snapshot.apply.runtimes;
      for (const runtime of runtimes) {
        const record = recovery.runtimes?.find(
          (candidate) => candidate.runtimeId === runtime.runtimeId,
        );
        if (!record?.awaitsEvidence || !record.logicalSessionKey) continue;
        if (!awaitsEvidenceIn(record.agent as AgentPlatform, runtime.state)) continue;
        found.push({
          stored,
          runtimes,
          runtime,
          record: record as Candidate["record"],
          key: `${stored.snapshot.operationId}\u0000${runtime.runtimeId}`,
        });
      }
    }
    return found;
  }

  /**
   * One bounded pass. Reads are serial and each is time-limited; a read that
   * fails or times out is the same as no evidence. Never rejects on a bridge
   * error — only a failed persist propagates, to the tick's own handler.
   */
  async check(operations: readonly StoredOperation[]): Promise<void> {
    const nowMs = this.deps.now();
    const all = this.candidates(operations, nowMs);
    const live = new Set(all.map((candidate) => candidate.key));
    for (const key of Array.from(this.nextCheck.keys())) {
      if (!live.has(key)) this.nextCheck.delete(key);
    }
    // Least recently checked first, so a large fan-out is covered round-robin.
    const due = all
      .filter((candidate) => (this.nextCheck.get(candidate.key) ?? 0) <= nowMs)
      .sort((a, b) => (this.nextCheck.get(a.key) ?? 0) - (this.nextCheck.get(b.key) ?? 0))
      .slice(0, EVIDENCE_READS_PER_TICK);
    if (!due.length) return;
    let before: RuntimeGenerations;
    try {
      before = await this.deps.generations();
    } catch {
      // Without generations no answer can be attributed; every runtime stays due.
      return;
    }
    const reads = new Map<string, Promise<RuntimeEvidenceRead>>();
    const answers: Array<{
      candidate: Candidate;
      answer: RuntimeEvidenceRead;
      generation?: string;
    }> = [];
    for (const candidate of due) {
      this.nextCheck.set(candidate.key, nowMs + EVIDENCE_RECHECK_MS);
      const { record } = candidate;
      const agent = record.agent as AgentPlatform;
      if (agent === "grok") {
        // Process-level evidence counts only from a bridge started after planning.
        const pid = before.bridgePid(record.environmentId, "grok");
        if (pid === undefined || pid === record.bridgePid) continue;
      }
      const generation = await before
        .of(record.environmentId, agent, record.logicalSessionKey)
        .catch(() => undefined);
      const readKey = `${record.environmentId}\u0000${agent}\u0000${record.logicalSessionKey}`;
      let read = reads.get(readKey);
      if (!read) {
        read = withTimeout(
          this.deps.probe.mcpConfigEvidence(record.environmentId, agent, record.logicalSessionKey),
          EVIDENCE_READ_TIMEOUT_MS,
        ).catch((): RuntimeEvidenceRead => ({ state: "none" }));
        reads.set(readKey, read);
      }
      answers.push({ candidate, answer: await read, generation });
    }
    // A runtime replaced while its bridge was read cannot be told apart from
    // its replacement: such an answer is dropped and the runtime read again.
    let after: RuntimeGenerations | undefined;
    if (
      answers.some(({ answer }) => answer.state === "evidence" || answer.state === "unsupported")
    ) {
      after = await this.deps.generations().catch(() => undefined);
    }
    const currents = new Map<StoredOperation, Promise<CurrentSourceState | undefined>>();
    const current = (stored: StoredOperation) => {
      let read = currents.get(stored);
      if (!read) {
        read = this.deps.currentSource(stored).catch(() => undefined);
        currents.set(stored, read);
      }
      return read;
    };
    const changed = new Set<StoredOperation>();
    const stamp = (runtime: McpRuntimeApplyEntry, generation: string | undefined) => {
      runtime.updatedAt = new Date(this.deps.now()).toISOString();
      if (generation) runtime.generation = generation;
      else delete runtime.generation;
    };
    for (const { candidate, answer, generation } of answers) {
      if (answer.state !== "evidence" && answer.state !== "unsupported") continue;
      const { stored, record, runtime } = candidate;
      const agent = record.agent as AgentPlatform;
      if (!after) continue;
      const settled = await after
        .of(record.environmentId, agent, record.logicalSessionKey)
        .catch(() => undefined);
      if (settled !== generation) {
        this.nextCheck.delete(candidate.key);
        continue;
      }
      if (answer.state === "unsupported") {
        const older = olderBridgeOutcome(agent);
        if (stored.snapshot.apply.runtimes !== candidate.runtimes) continue;
        if (!awaitsEvidenceIn(agent, runtime.state)) continue;
        if (runtime.state === older.state && runtime.reason === older.reason) continue;
        runtime.state = older.state;
        runtime.reason = older.reason;
        stamp(runtime, generation);
        changed.add(stored);
        continue;
      }
      // Only Grok's bridge reports process-level loads, and only Grok's are.
      if (answer.evidence.scope !== (agent === "grok" ? "process" : "session")) continue;
      const recovery = stored.recovery;
      const digest = evidenceDigest(
        answer.evidence,
        recovery.evidenceRole!,
        Date.parse(recovery.writeStartedAt!),
      );
      if (!digest) continue;
      let shown: boolean;
      try {
        shown = await evidenceShowsSave(digest, recovery.savedDigest!, () => current(stored));
      } catch {
        continue;
      }
      if (!shown) continue;
      // A request may have cancelled or replanned while this read awaited.
      if (stored.snapshot.apply.runtimes !== candidate.runtimes) continue;
      if (!awaitsEvidenceIn(agent, runtime.state)) continue;
      const removed = removedServer(stored);
      if (removed && answer.evidence.staleServers?.includes(removed)) {
        // Rule 5: keep polling; a query on a new runtime proves it.
        if (runtime.state !== "restart-required" || runtime.reason !== STILL_LOADED_REASON) {
          runtime.state = "restart-required";
          runtime.reason = STILL_LOADED_REASON;
          stamp(runtime, generation);
          changed.add(stored);
        }
        continue;
      }
      const newerRun =
        agent !== "grok" && !!record.generation && !!generation && generation !== record.generation;
      runtime.state = "applied";
      runtime.reason = newerRun ? NEWER_RUN_REASON : appliedReason(agent);
      stamp(runtime, generation);
      this.nextCheck.delete(candidate.key);
      changed.add(stored);
    }
    // The external-edit rule, once per polled operation, after its evidence.
    const polled = new Map<StoredOperation, McpRuntimeApplyEntry[]>();
    for (const { stored, runtimes } of due) polled.set(stored, runtimes);
    for (const [stored, runtimes] of polled) {
      const drift = sourceDrift(stored, await current(stored));
      if (stored.snapshot.apply.runtimes !== runtimes) continue;
      if (drift.kind === "superseded") {
        const now = new Date(this.deps.now()).toISOString();
        if (retireSuperseded(runtimes, drift, now, heldRuntimes(stored))) {
          changed.add(stored);
        }
      } else if (drift.kind === "merged" && noteOnce(stored.snapshot, drift.note)) {
        changed.add(stored);
      }
    }
    for (const stored of changed) await this.deps.commit(stored);
  }
}
