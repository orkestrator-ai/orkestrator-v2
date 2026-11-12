/**
 * The coordinator poll guard: what makes two reads "the same answer", and how
 * many of them a conversation may collect before it is told to stop asking.
 *
 * The guard never withholds data. A read it judges a poll still returns its
 * whole authorized answer, with `repeatedRead: true` and the async contract
 * added, so a wider coverage costs nothing but the field.
 *
 * Two rules decide what counts as a repeat:
 *
 * - **The key is the question, not the call.** Each read is keyed on the tool,
 *   its target and the filters that change what is asked (a status or
 *   unread-only filter), never on paging or size (`limit`, `offset`), so a
 *   model cannot reset the count by changing how much it asks for.
 * - **The fingerprint is the state a poll watches.** Each read hashes only the
 *   fields a waiting model is watching for (lifecycle, activity, phase, open
 *   questions, PR readiness), leaving out what moves on every event
 *   (`lastActivityAt`, revisions), so a real change is a new answer at once.
 *
 * The window slides: every identical read extends it, so slow polling (one
 * read a minute) is caught as surely as fast polling.
 */
import { COORDINATOR_ASYNC_CONTRACT } from "@orkestrator/protocol/coordinator";

type JsonRecord = Record<string, unknown>;

/**
 * Whether this read is a poll: the same answer, asked again, too many times.
 *
 * Returns the guidance to add to the answer, or null to answer normally.
 */
export type CoordinatorPollGuard = (key: string, fingerprint: string) => JsonRecord | null;

/**
 * How many identical answers a conversation may collect before it is told to
 * stop asking, and how long after the last of them that judgement stands.
 */
export const COORDINATOR_POLL_BUDGET = 3;
export const COORDINATOR_POLL_WINDOW_MS = 120_000;
export const MAX_COORDINATOR_POLL_ENTRIES = 256;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Repeated-unchanged-read counters, per conversation and question.
 *
 * Owned by the long-lived Control MCP server rather than the per-request MCP
 * server, which is rebuilt for every call: a counter kept there would reset
 * on each call and never observe a loop at all. Bounded on both axes: one
 * entry per conversation and question, at most `maxEntries` in all, and a
 * conversation's entries are dropped when its credential is revoked.
 */
export class CoordinatorPollTracker {
  private readonly entries = new Map<
    string,
    { fingerprint: string; unchanged: number; lastReadAt: number }
  >();

  constructor(
    private readonly options: {
      budget?: number;
      windowMs?: number;
      maxEntries?: number;
      now?: () => number;
    } = {},
  ) {}

  guard(scope: { coordinatorId: string; conversationId: string }): CoordinatorPollGuard {
    const budget = this.options.budget ?? COORDINATOR_POLL_BUDGET;
    const windowMs = this.options.windowMs ?? COORDINATOR_POLL_WINDOW_MS;
    const maxEntries = this.options.maxEntries ?? MAX_COORDINATOR_POLL_ENTRIES;
    return (read, fingerprint) => {
      const key = `${scope.coordinatorId}:${scope.conversationId}:${read}`;
      const now = (this.options.now ?? Date.now)();
      const previous = this.entries.get(key);
      if (
        !previous ||
        previous.fingerprint !== fingerprint ||
        now - previous.lastReadAt > windowMs
      ) {
        this.entries.delete(key);
        this.entries.set(key, { fingerprint, unchanged: 1, lastReadAt: now });
        if (this.entries.size > maxEntries) {
          // Insertion order is last-touched order: the first key is the stalest.
          const stalest = this.entries.keys().next().value;
          if (stalest !== undefined) this.entries.delete(stalest);
        }
        return null;
      }
      // Sliding: an identical read keeps the question open for another window.
      previous.unchanged += 1;
      previous.lastReadAt = now;
      this.entries.delete(key);
      this.entries.set(key, previous);
      if (previous.unchanged <= budget) return null;
      return { repeatedRead: true, instruction: COORDINATOR_ASYNC_CONTRACT };
    };
  }

  /** A conversation that lost its credential is starting over. */
  forget(coordinatorId: string, conversationId?: string): void {
    const prefix =
      conversationId === undefined ? `${coordinatorId}:` : `${coordinatorId}:${conversationId}:`;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A guard key: the tool and the parts of its input that make the question. */
export function pollKey(tool: string, ...parts: unknown[]): string {
  return `${tool}:${JSON.stringify(parts.map((part) => part ?? null))}`;
}

export function mailboxFingerprint(page: JsonRecord): string {
  const messages = Array.isArray(page.messages) ? page.messages : [];
  return JSON.stringify(
    messages.map((message) =>
      isRecord(message) ? [message.id, message.placement, message.ackedAt ?? null] : message,
    ),
  );
}

/** A PR that starts conflicting, fails a check or becomes ready is a different answer. */
function prFingerprint(environment: JsonRecord): unknown[] {
  return [
    environment.prState ?? null,
    environment.prHasMergeConflicts ?? null,
    environment.prMergeability ?? null,
    environment.prChecks ?? null,
    environment.prReadyToMerge ?? null,
  ];
}

/**
 * What a worker-status poll watches on one environment. `lastActivityAt`
 * moves on every turn event, so it is left out: re-reading while a worker is
 * still `working` asks the same question each time.
 */
function environmentState(environment: JsonRecord): unknown[] {
  return [
    environment.id,
    environment.nodeId ?? null,
    environment.status,
    environment.setupPhase ?? null,
    environment.lifecycleOperation ?? null,
    environment.agentActivityState ?? null,
    ...prFingerprint(environment),
  ];
}

export function environmentListFingerprint(result: {
  environments: JsonRecord[];
  otherNodes?: JsonRecord[];
}): string {
  return JSON.stringify([
    result.environments.map(environmentState),
    (result.otherNodes ?? []).map((node) => [
      node.nodeId,
      node.available,
      records(node.environments).map((environment) => [
        environment.environmentId,
        environment.status,
        environment.activity ?? null,
        ...prFingerprint(environment),
      ]),
    ]),
  ]);
}

export function environmentFingerprint(environment: JsonRecord): string {
  return JSON.stringify(environmentState(environment));
}

/** Each tab and what it is doing now, and whether its goal will continue. */
export function agentRegistryFingerprint(snapshot: JsonRecord): string {
  return JSON.stringify(
    records(snapshot.entries).map((entry) => [
      entry.environmentId,
      entry.tabId,
      entry.state ?? null,
      isRecord(entry.goal) ? (entry.goal.status ?? entry.goal.running ?? null) : null,
    ]),
  );
}

/**
 * A tab's turn and what it waits on: connection, turn phase and error, open
 * questions and approvals, and its goal. Streaming moves the revision on every
 * event and is left out.
 */
export function tabStateFingerprint(result: JsonRecord): string {
  const state = isRecord(result.state) ? result.state : {};
  const turn = isRecord(state.turn) ? state.turn : {};
  const goal = isRecord(state.goal) ? state.goal : {};
  return JSON.stringify([
    result.connection ?? state.connection ?? null,
    state.kind ?? null,
    state.status ?? null,
    turn.phase ?? null,
    turn.error ?? null,
    records(state.interactions).map((interaction) => interaction.id ?? null),
    goal.status ?? null,
  ]);
}

/**
 * A transcript's newest row and its connection: a row is one model response,
 * so new work is a new newest row, whatever `limit` asked for. A terminal tail
 * is its output, since that has no rows.
 */
export function transcriptFingerprint(result: JsonRecord): string {
  if (result.kind === "terminal-output") {
    return JSON.stringify(["terminal", result.output ?? null, result.truncated ?? null]);
  }
  const messages = records(result.messages);
  return JSON.stringify([
    result.connection ?? null,
    result.error ?? null,
    messages.at(-1)?.id ?? null,
  ]);
}

/** Keys of a workflow summary that move without its state changing. */
const VOLATILE_WORKFLOW_KEYS = new Set([
  "updatedAt",
  "revision",
  "backendRevision",
  "lastActivityAt",
]);

function stableState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableState);
  if (!isRecord(value)) return value ?? null;
  return Object.keys(value)
    .filter((key) => !VOLATILE_WORKFLOW_KEYS.has(key) && value[key] !== undefined)
    .sort()
    .map((key) => [key, stableState(value[key])]);
}

/** A build pipeline or Multi Review summary: phase, workers, automation, errors. */
export function workflowFingerprint(summary: unknown): string {
  return JSON.stringify(stableState(summary));
}

/** Every listed association's delegation and its resource's state. */
export function workflowListFingerprint(workflows: readonly JsonRecord[]): string {
  return JSON.stringify(
    workflows.map((workflow) => [
      workflow.id,
      stableState(workflow.delegation),
      stableState(workflow.follow),
      stableState(workflow.resource),
    ]),
  );
}
