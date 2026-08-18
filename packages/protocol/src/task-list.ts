/**
 * The agent task list, reconstructed from task-tool traffic.
 *
 * Claude Code's `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` tools each
 * operate on one task at a time against state the CLI holds, unlike the
 * `TodoWrite` tool they replaced, which posted the whole list on every call. A
 * single call therefore says nothing about the list as a whole, so whoever sees
 * the tool traffic replays it into a `TaskRegistry` and stamps the resulting
 * snapshot onto the tool part. The renderer then shows the list as it stood at
 * that point in the transcript without re-deriving anything.
 *
 * This module lives in `protocol` because two different backends see that
 * traffic and must agree on what it means: the claude-bridge (Native Mode, from
 * SDK messages) and the backend's tmux session (from Claude's JSONL transcript).
 * There is deliberately no second implementation in the renderer.
 *
 * Everything is parsed from the tools' plain-text output, which is the only
 * place the assigned task id appears (`TaskCreate` takes a subject and returns
 * the id). That coupling is why `apply` reports "I could not parse this" as
 * `undefined` rather than guessing: a caller that receives no snapshot falls
 * back to showing the raw call, which is always honest.
 */

/** Display status of a task in the task list. */
export type TaskSnapshotStatus = "pending" | "in_progress" | "completed";

/** One task in a point-in-time view of the task list. */
export interface TaskSnapshotItem {
  id: string;
  subject: string;
  status: TaskSnapshotStatus;
}

/** A point-in-time view of the whole task list, as of one tool call. */
export interface TaskListSnapshot {
  /** The list, ordered the way `TaskList` reports it. */
  items: TaskSnapshotItem[];
  /**
   * The single task this call mutated, when it mutated one. Absent for the
   * read-only tools (`TaskList`, `TaskGet`), which change nothing.
   */
  changedTaskId?: string;
  /**
   * False when the registry knows its view is missing tasks — an update or read
   * arrived for a task it never saw created, so tasks created before it started
   * watching are absent. Consumers must not present an incomplete list as the
   * whole list. A later `TaskList` reconciles wholesale and restores it to true.
   */
  complete: boolean;
  /**
   * How many tasks were dropped from `items` by the size cap, when any were.
   * Never truncate silently: consumers surface this so a long list does not
   * quietly read as a short one.
   */
  truncated?: number;
}

/**
 * Cap on `items`. The snapshot is copied onto every task tool part and re-sent
 * with the whole message on each streaming update, so an unbounded list is
 * bandwidth spent on every frame of a turn. Well above any realistic list.
 */
export const MAX_SNAPSHOT_ITEMS = 200;

/**
 * Every member of `TaskSnapshotStatus`, as a value.
 *
 * Exported so consumers that validate a snapshot arriving from outside the
 * registry — a persisted transcript, a provider payload — check against this
 * list rather than keeping a hand-copied one. A private copy drifts silently:
 * adding a status here would still type-check in the consumer while its
 * validator quietly rejected the new value.
 */
export const TASK_SNAPSHOT_STATUSES: readonly TaskSnapshotStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

/** `Task #12 created successfully: Wire up the parser` */
const CREATE_OUTPUT = /^Task #(\d+) created successfully:\s*([\s\S]+)$/;
/** `Updated task #12 subject, status` */
const UPDATE_OUTPUT = /^Updated task #(\d+)\b/;
/** `#12 [pending] Wire up the parser (owner) [blocked by #3, #4]` */
const LIST_LINE = /^#(\d+)\s+\[([a-z_ -]+)\]\s+([\s\S]+)$/i;
/** `Task #12: Wire up the parser` */
const GET_HEADER = /^Task #(\d+):\s*([\s\S]+)$/;
const GET_STATUS = /^Status:\s*([a-z_ -]+)$/im;

/** Trailing ` [blocked by #3, #4]` appended by TaskList. */
const LIST_BLOCKED_SUFFIX = /\s*\[blocked by #\d+(?:,\s*#\d+)*\]\s*$/i;
/** Trailing ` (agent-name)` appended by TaskList when a task has an owner. */
const LIST_OWNER_SUFFIX = /\s*\([^()]*\)\s*$/;

/**
 * `TaskList` reporting an empty list in prose rather than as empty output.
 *
 * Distinguishing this from output we simply failed to parse is the whole point:
 * the first means "clear the list", the second means "I know nothing, keep what
 * I have and let the caller show the raw text".
 */
const EMPTY_LIST_OUTPUT =
  /^(?:there are\s+)?no\s+(?:open\s+|matching\s+|remaining\s+)?tasks\b|^task list is empty\b|^\(no tasks\)$/i;

const TASK_TOOL_KINDS = {
  taskcreate: "create",
  task_create: "create",
  taskupdate: "update",
  task_update: "update",
  tasklist: "list",
  task_list: "list",
  taskget: "get",
  task_get: "get",
} as const;

type TaskToolKind = (typeof TASK_TOOL_KINDS)[keyof typeof TASK_TOOL_KINDS];

/** Which task tool this is, or undefined for anything the registry ignores. */
export function taskToolKind(toolName: string | undefined): TaskToolKind | undefined {
  if (typeof toolName !== "string") return undefined;
  return TASK_TOOL_KINDS[toolName.trim().toLowerCase() as keyof typeof TASK_TOOL_KINDS];
}

/** Whether a tool name is one of the task-list tools the registry models. */
export function isTaskListTool(toolName: string | undefined): boolean {
  return taskToolKind(toolName) !== undefined;
}

/**
 * The status this value denotes, or `undefined` for anything else.
 *
 * Exported alongside `TASK_SNAPSHOT_STATUSES` so a consumer validating a
 * foreign snapshot accepts exactly the spellings the registry itself accepts.
 */
export function parseTaskSnapshotStatus(value: unknown): TaskSnapshotStatus | undefined {
  if (typeof value !== "string") return undefined;
  // `[in progress]` and `[in-progress]` mean the same thing as `[in_progress]`;
  // accepting only the underscore spelling would silently drop the row.
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return TASK_SNAPSHOT_STATUSES.includes(normalized as TaskSnapshotStatus)
    ? (normalized as TaskSnapshotStatus)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Order by task id the way TaskList reports it.
 *
 * Ids are numeric in every observed output, but `TaskUpdate` args are not
 * validated by us, so a non-numeric id must still sort deterministically rather
 * than feeding NaN to the comparator.
 */
function compareIds(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  const leftIsNumber = Number.isFinite(left);
  const rightIsNumber = Number.isFinite(right);

  if (leftIsNumber && rightIsNumber) return left - right;
  if (leftIsNumber) return -1;
  if (rightIsNumber) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Strip the decorations TaskList appends after the subject.
 *
 * Only used for tasks the registry has never seen created — when the subject is
 * already known from `TaskCreate` args it is preferred verbatim, because a
 * subject may legitimately end in a parenthetical that is indistinguishable
 * from an owner suffix.
 */
function stripListDecorations(subject: string): string {
  return subject.replace(LIST_BLOCKED_SUFFIX, "").replace(LIST_OWNER_SUFFIX, "").trim();
}

interface TaskEntry {
  id: string;
  subject: string;
  status: TaskSnapshotStatus;
  /**
   * False when the subject was synthesized from an id alone, i.e. an update
   * arrived for a task this registry never saw created. A later `TaskList`
   * reconciles it.
   */
  subjectKnown: boolean;
}

/** What one `apply` did, before it is turned into a snapshot. */
interface ApplyOutcome {
  /** The task this call mutated, for the renderer's highlight. */
  changedTaskId?: string;
}

export class TaskRegistry {
  private tasks = new Map<string, TaskEntry>();

  /**
   * False once the registry has had to invent an entry for a task it never saw
   * created, which means tasks that existed before it started watching are
   * missing from its view.
   */
  private complete = true;

  /**
   * Apply a completed task tool call and return the resulting list state.
   *
   * Returns `undefined` when the call changed nothing the registry could
   * understand — an unmodelled tool, or output in a shape it cannot parse. The
   * caller must treat that as "no snapshot" and fall back to rendering the call
   * itself, rather than showing a stale or empty list as though it were fact.
   */
  apply(
    toolName: string | undefined,
    toolArgs: Record<string, unknown> | undefined,
    toolOutput: string | undefined,
  ): TaskListSnapshot | undefined {
    let outcome: ApplyOutcome | undefined;

    switch (taskToolKind(toolName)) {
      case "create":
        outcome = this.applyCreate(toolArgs, toolOutput);
        break;
      case "update":
        outcome = this.applyUpdate(toolArgs, toolOutput);
        break;
      case "list":
        outcome = this.applyList(toolOutput);
        break;
      case "get":
        outcome = this.applyGet(toolArgs, toolOutput);
        break;
      default:
        return undefined;
    }

    if (!outcome) return undefined;
    return { ...this.snapshot(), changedTaskId: outcome.changedTaskId };
  }

  /** Current list state, independent of any particular call. */
  snapshot(): TaskListSnapshot {
    const ordered = Array.from(this.tasks.values()).sort((a, b) => compareIds(a.id, b.id));
    const items = ordered
      .slice(0, MAX_SNAPSHOT_ITEMS)
      .map((task) => ({ id: task.id, subject: task.subject, status: task.status }));
    const dropped = ordered.length - items.length;

    return {
      items,
      complete: this.complete,
      ...(dropped > 0 ? { truncated: dropped } : {}),
    };
  }

  private applyCreate(
    toolArgs: Record<string, unknown> | undefined,
    toolOutput: string | undefined,
  ): ApplyOutcome | undefined {
    const match = toolOutput?.trim().match(CREATE_OUTPUT);
    // No id means no task: inventing one from the args would put a row in the
    // list under an id nothing can ever update.
    if (!match) return undefined;

    const id = match[1]!;
    // The args carry the subject exactly as Claude wrote it; the echo in the
    // output is the same string but is the only source when args are absent.
    const subject = asNonEmptyString(toolArgs?.subject) ?? match[2]!.trim();

    this.tasks.set(id, { id, subject, status: "pending", subjectKnown: true });
    return { changedTaskId: id };
  }

  private applyUpdate(
    toolArgs: Record<string, unknown> | undefined,
    toolOutput: string | undefined,
  ): ApplyOutcome | undefined {
    const id =
      asNonEmptyString(toolArgs?.taskId) ??
      asNonEmptyString(toolArgs?.task_id) ??
      toolOutput?.trim().match(UPDATE_OUTPUT)?.[1];
    if (!id) return undefined;

    // `deleted` is not a display status — the task leaves the list entirely.
    if (asNonEmptyString(toolArgs?.status)?.toLowerCase() === "deleted") {
      this.tasks.delete(id);
      return { changedTaskId: id };
    }

    const existing = this.tasks.get(id);
    const subject = asNonEmptyString(toolArgs?.subject);
    const status = parseTaskSnapshotStatus(toolArgs?.status);

    // An update for a task we never saw created means the list predates us.
    if (!existing && !subject) this.complete = false;

    this.tasks.set(id, {
      id,
      subject: subject ?? existing?.subject ?? `Task #${id}`,
      status: status ?? existing?.status ?? "pending",
      subjectKnown: Boolean(subject) || (existing?.subjectKnown ?? false),
    });

    return { changedTaskId: id };
  }

  /** TaskList reports the whole list, so it is authoritative — replace state. */
  private applyList(toolOutput: string | undefined): ApplyOutcome | undefined {
    if (typeof toolOutput !== "string") return undefined;

    const trimmed = toolOutput.trim();
    const parsed = new Map<string, TaskEntry>();
    for (const line of toolOutput.split("\n")) {
      const match = line.trim().match(LIST_LINE);
      if (!match) continue;

      const [, id, rawStatus, rawSubject] = match;
      const existing = this.tasks.get(id!);
      parsed.set(id!, {
        id: id!,
        // Prefer the subject captured at creation: it is exact, whereas the
        // list line has owner/blocked decorations appended to it.
        subject: existing?.subjectKnown ? existing.subject : stripListDecorations(rawSubject!),
        status: parseTaskSnapshotStatus(rawStatus) ?? existing?.status ?? "pending",
        subjectKnown: true,
      });
    }

    // An empty list is a legitimate state, but so is output we failed to parse.
    // Trust a wholesale replacement only when a line parsed, the output was
    // genuinely empty, or the tool said in words that the list is empty.
    const isEmptyList = trimmed.length === 0 || EMPTY_LIST_OUTPUT.test(trimmed);
    if (parsed.size === 0 && !isEmptyList) return undefined;

    this.tasks = parsed;
    // A full listing is authoritative, so whatever we were missing, we are not
    // missing it any more.
    this.complete = true;
    // A listing reads; it changes nothing, so nothing is highlighted.
    return {};
  }

  private applyGet(
    toolArgs: Record<string, unknown> | undefined,
    toolOutput: string | undefined,
  ): ApplyOutcome | undefined {
    if (typeof toolOutput !== "string") return undefined;

    const header = toolOutput.trim().match(GET_HEADER);
    const id =
      header?.[1] ?? asNonEmptyString(toolArgs?.taskId) ?? asNonEmptyString(toolArgs?.task_id);
    if (!id) return undefined;

    const existing = this.tasks.get(id);
    const subject = asNonEmptyString(header?.[2]?.split("\n")[0]);
    const status = parseTaskSnapshotStatus(toolOutput.match(GET_STATUS)?.[1]);

    // Nothing usable came back beyond an id we already knew nothing about.
    if (!existing && !subject && !status) return undefined;
    if (!existing && !subject) this.complete = false;

    this.tasks.set(id, {
      id,
      subject: subject ?? existing?.subject ?? `Task #${id}`,
      status: status ?? existing?.status ?? "pending",
      subjectKnown: Boolean(subject) || (existing?.subjectKnown ?? false),
    });

    // A read changes nothing, so nothing is highlighted as changed.
    return {};
  }
}
