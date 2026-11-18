/**
 * OpenCode 2.x background sub-agents, as the rest of the backend sees
 * background work (OpenCode 2.3.0, anomalyco/opencode#63382).
 *
 * Since 2.3.0 every `subagent` call returns at once with the child's session
 * id, the parent's run settles while the child works, and each time the child
 * goes idle a `<subagent>` report (a `synthetic` row, `metadata.source:
 * "subagent"`) is admitted to the parent's inbox and the parent is woken into
 * a run of its own, with no prompt from Orkestrator (probed on 2.3.0). That is
 * the shape of a Claude turn that released to background agents, so it is
 * reported the same way:
 *
 * - **Activity** (`activityBatch`): a session whose own run settled but whose
 *   descendant still runs reads `working`, as a Claude session with a live
 *   background agent does; its composer stays free, because its `status` is
 *   its own run's.
 * - **Workflows** (`observeSession`, `settleTurn`, `structured`): an idle
 *   session with {@link OpenCode2BackgroundWork.live} work reports
 *   `backgroundWorkLive`, keeps its turn's grant and has no result yet, so a
 *   pipeline or review waits for the run the report wakes (whose rows belong
 *   to the same request, `openCode2RequestRun`).
 * - **Stop** ({@link OpenCode2BackgroundWork.stop}): 2.3.0 no longer cancels a
 *   parent's children when the parent is interrupted, and a child's cancelled
 *   report wakes its parent. A stop interrupts the running descendants and
 *   then any run their reports wake, so Stop ends the work as it did on 2.2.6
 *   (and as stopping a Claude session ends its background agents).
 * - **Cards**: the transcript folds each report onto the call that launched
 *   it (`transcript.ts`).
 *
 * Only stable routes are read: the running sessions, each session's parent
 * (immutable, so remembered), a parent's children and its inbox.
 */
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { asRecord } from "../agent-provider-runtime.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import { openCode2SubagentReport } from "./transcript.js";
import type { OpenCode2Session } from "./types.js";

const log = createLogger("native-agent.opencode2");

/** Sessions whose parent is remembered (a parent never changes). */
const MAX_REMEMBERED_PARENTS = 2_048;
/** Running sessions looked up per read when their parent is not yet known. */
const MAX_PARENT_LOOKUPS = 32;
/** Deepest chain of sub-agents followed (2.x's default `subagent_depth` is 1). */
const MAX_DEPTH = 8;
/** Descendants a stop interrupts. */
const MAX_STOPPED_DESCENDANTS = 64;
/**
 * A child created this recently that has not started yet is about to: it is
 * admitted before it drains (2.3.0 `subagent.ts`).
 */
export const OPENCODE2_CHILD_START_GRACE_MS = 15_000;
/**
 * A child that settled this recently may have a report on its way to the
 * parent's inbox: it is admitted right after the child releases.
 */
export const OPENCODE2_CHILD_REPORT_GRACE_MS = 3_000;
/** How long a stop keeps interrupting runs that its children's reports wake. */
export const OPENCODE2_STOP_SETTLE_MS = 3_000;
const STOP_POLL_MS = 100;

export interface OpenCode2BackgroundWorkDependencies {
  /** The server's running sessions; `fresh` skips any cache. */
  running(fresh: boolean): Promise<ReadonlySet<string>>;
  now(): number;
  sleep?(ms: number): Promise<void>;
}

export class OpenCode2BackgroundWork {
  /** Session id → its parent's id, `null` for a root session. */
  private readonly parents = new Map<string, string | null>();
  private readonly stops = new Map<string, object>();

  dispose(): void {
    this.stops.clear();
    this.parents.clear();
  }

  beginStop(sessionId: string): object {
    const token = {};
    this.stops.set(sessionId, token);
    return token;
  }

  cancelStop(sessionId: string): void {
    this.stops.delete(sessionId);
  }

  constructor(
    private readonly client: OpenCode2Client,
    private readonly deps: OpenCode2BackgroundWorkDependencies,
  ) {}

  /**
   * Which of `sessionIds` own a running session other than themselves (a
   * running descendant), from one read of the running sessions. A parent
   * that cannot be read leaves that running session unowned.
   */
  async owners(sessionIds: readonly string[], running: ReadonlySet<string>): Promise<Set<string>> {
    const wanted = new Set(sessionIds);
    const owners = new Set<string>();
    const others = [...running].filter((id) => !wanted.has(id));
    if (others.length === 0 || wanted.size === 0) return owners;
    let lookups = 0;
    for (const id of others) {
      let current: string | null | undefined = id;
      for (let depth = 0; current && depth < MAX_DEPTH; depth += 1) {
        let parent = this.parents.get(current);
        if (parent === undefined) {
          if (lookups >= MAX_PARENT_LOOKUPS) break;
          lookups += 1;
          parent = await this.parentOf(current);
          if (parent === undefined) break;
        }
        if (parent && wanted.has(parent)) {
          owners.add(parent);
          break;
        }
        current = parent;
      }
    }
    return owners;
  }

  /**
   * Whether `sessionId` has background work that will report to it: a
   * running descendant, a report waiting in its inbox, a child admitted but
   * not yet started, or a child that settled so recently its report may still
   * be on its way. An unreadable state stays pending until a read proves completion.
   */
  async live(sessionId: string): Promise<boolean> {
    try {
      const running = await this.deps.running(true);
      if ((await this.owners([sessionId], running)).has(sessionId)) return true;
      const [inbox, children] = await Promise.all([
        this.client.listInbox(sessionId),
        this.client.listChildSessions(sessionId),
      ]);
      if (inbox.some((item) => openCode2SubagentReport({ ...item.payload, type: item.type }))) {
        return true;
      }
      const now = this.deps.now();
      return children.some((child) => pendingChild(child, now));
    } catch (error) {
      if (!(error instanceof OpenCode2RequestError && error.status === 404)) {
        log.debug("background.unreadable", { error: formatLogError(error, { message: false }) });
      }
      return true;
    }
  }

  /**
   * Stop the background work of a session whose own run was just
   * interrupted: interrupt every running descendant, then, until the reports
   * those interruptions send have been delivered, interrupt any run they wake
   * in `sessionId`. Bounded by {@link OPENCODE2_STOP_SETTLE_MS}; best-effort.
   */
  async stop(sessionId: string, token = this.beginStop(sessionId)): Promise<void> {
    const current = () => this.stops.get(sessionId) === token;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    try {
      const inputHead = async () => {
        const page = await this.client.listMessages(sessionId, { limit: 199, order: "desc" });
        return page.messages.find(
          (row) =>
            row.type === "user" || (row.type === "synthetic" && !openCode2SubagentReport(row)),
        )?.id;
      };
      const initialInput = await inputHead();
      const descendants = await this.descendants(sessionId);
      if (!current()) return;
      if (descendants.length === 0) {
        const inbox = await this.client.listInbox(sessionId);
        if (!inbox.some((item) => openCode2SubagentReport({ ...item.payload, type: item.type })))
          return;
      }
      // Poll the whole bounded phase, including quiet snapshots: admission and
      // report delivery can occur after an initially empty running set.
      const deadline = this.deps.now() + OPENCODE2_STOP_SETTLE_MS;
      for (let poll = 0; poll <= OPENCODE2_STOP_SETTLE_MS / STOP_POLL_MS; poll += 1) {
        const running = await this.deps.running(true);
        if (!current()) return;
        for (const id of [...descendants, sessionId]) {
          if (!current()) return;
          if (running.has(id)) {
            // Another provider instance (pipeline or mail) can dispatch too.
            // A new external input owns the parent; only report continuations
            // of the stopped work may be interrupted here.
            if (id === sessionId && (await inputHead()) !== initialInput) return;
            if (!current()) return;
            await this.client.interrupt(id, { resume: false });
          }
        }
        if (this.deps.now() >= deadline) break;
        await sleep(STOP_POLL_MS);
        if (!current()) return;
        const refreshed = await this.descendants(sessionId);
        if (!current()) return;
        descendants.splice(0, descendants.length, ...refreshed);
      }
    } finally {
      if (current()) this.stops.delete(sessionId);
    }
  }

  /** The session's descendants, breadth first and bounded. */
  private async descendants(sessionId: string): Promise<string[]> {
    const found: string[] = [];
    let level = [sessionId];
    for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
      const next: string[] = [];
      for (const parent of level) {
        const children = await this.client.listChildSessions(parent);
        for (const child of children) {
          this.remember(child.id, parent);
          if (found.length >= MAX_STOPPED_DESCENDANTS) return found;
          found.push(child.id);
          next.push(child.id);
        }
      }
      level = next;
    }
    return found;
  }

  private async parentOf(sessionId: string): Promise<string | null | undefined> {
    try {
      const session = await this.client.getSession(sessionId);
      const parent = typeof session.parentID === "string" ? session.parentID : null;
      this.remember(sessionId, parent);
      return parent;
    } catch (error) {
      if (error instanceof OpenCode2RequestError && error.status === 404) {
        this.remember(sessionId, null);
        return null;
      }
      throw error;
    }
  }

  private remember(sessionId: string, parent: string | null): void {
    this.parents.delete(sessionId);
    this.parents.set(sessionId, parent);
    while (this.parents.size > MAX_REMEMBERED_PARENTS) {
      this.parents.delete(this.parents.keys().next().value!);
    }
  }
}

/** A child about to start, or one whose report may not have reached its parent yet. */
function pendingChild(child: OpenCode2Session, now: number): boolean {
  const time = asRecord(child.time);
  const created = typeof time?.created === "number" ? time.created : undefined;
  const busy = typeof time?.busy === "number" ? time.busy : undefined;
  const idle = typeof time?.idle === "number" ? time.idle : undefined;
  if (busy === undefined) {
    return created !== undefined && now - created < OPENCODE2_CHILD_START_GRACE_MS;
  }
  return idle !== undefined && idle >= busy && now - idle < OPENCODE2_CHILD_REPORT_GRACE_MS;
}
