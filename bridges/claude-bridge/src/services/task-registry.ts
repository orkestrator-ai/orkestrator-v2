import type { TaskSnapshotItem, TaskSnapshotStatus } from "../types/index.js";

/**
 * Tracks the state of Claude Code's task list across a session.
 *
 * The `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` tools operate on one
 * task at a time against server-side state, unlike the `TodoWrite` tool they
 * replaced, which posted the whole list on every call. A single call therefore
 * says nothing about the list as a whole, so the bridge replays the calls into
 * this registry and stamps each tool part with the resulting snapshot. The
 * renderer can then show the current state of the list at that point in the
 * transcript without re-deriving it from surrounding parts.
 *
 * Everything here is parsed from the tools' plain-text output, which is the only
 * place the assigned task id appears (`TaskCreate` takes a subject and returns
 * the id). The registry lives on the session because the task list outlives an
 * individual turn.
 */

const TASK_STATUSES: readonly TaskSnapshotStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

/** `Task #12 created successfully: Wire up the parser` */
const CREATE_OUTPUT = /^Task #(\d+) created successfully:\s*([\s\S]+)$/;
/** `Updated task #12 subject, status` */
const UPDATE_OUTPUT = /^Updated task #(\d+)\s+([\w\s,]+)$/;
/** `#12 [pending] Wire up the parser (owner) [blocked by #3, #4]` */
const LIST_LINE = /^#(\d+)\s+\[([a-z_]+)\]\s+([\s\S]+)$/;
/** `Task #12: Wire up the parser` */
const GET_HEADER = /^Task #(\d+):\s*([\s\S]+)$/;
const GET_STATUS = /^Status:\s*([a-z_]+)$/m;

/** Trailing ` [blocked by #3, #4]` appended by TaskList. */
const LIST_BLOCKED_SUFFIX = /\s*\[blocked by #\d+(?:,\s*#\d+)*\]\s*$/;
/** Trailing ` (agent-name)` appended by TaskList when a task has an owner. */
const LIST_OWNER_SUFFIX = /\s*\([^()]*\)\s*$/;

function asStatus(value: unknown): TaskSnapshotStatus | undefined {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskSnapshotStatus)
    ? (value as TaskSnapshotStatus)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
   * arrived for a task this registry never saw created (a resumed session, or a
   * bridge restart mid-conversation). A later `TaskList` reconciles it.
   */
  subjectKnown: boolean;
}

export class TaskRegistry {
  private tasks = new Map<string, TaskEntry>();

  /**
   * Apply a completed Task tool call and return the resulting list state.
   *
   * Returns undefined for tools this registry does not model, so callers can
   * leave non-task parts untouched.
   */
  apply(
    toolName: string | undefined,
    toolArgs: Record<string, unknown> | undefined,
    toolOutput: string | undefined,
  ): TaskSnapshotItem[] | undefined {
    switch (toolName?.toLowerCase()) {
      case "taskcreate":
      case "task_create":
        this.applyCreate(toolArgs, toolOutput);
        return this.snapshot();
      case "taskupdate":
      case "task_update":
        this.applyUpdate(toolArgs, toolOutput);
        return this.snapshot();
      case "tasklist":
      case "task_list":
        this.applyList(toolOutput);
        return this.snapshot();
      case "taskget":
      case "task_get":
        this.applyGet(toolArgs, toolOutput);
        return this.snapshot();
      default:
        return undefined;
    }
  }

  /** Current list state, ordered by task id the way TaskList reports it. */
  snapshot(): TaskSnapshotItem[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((task) => ({ id: task.id, subject: task.subject, status: task.status }));
  }

  private applyCreate(
    toolArgs: Record<string, unknown> | undefined,
    toolOutput: string | undefined,
  ): void {
    const match = toolOutput?.trim().match(CREATE_OUTPUT);
    if (!match) return;

    const id = match[1];
    // The args carry the subject exactly as Claude wrote it; the echo in the
    // output is the same string but is the only source when args are absent.
    const subject = asNonEmptyString(toolArgs?.subject) ?? match[2].trim();

    this.tasks.set(id, { id, subject, status: "pending", subjectKnown: true });
  }

  private applyUpdate(
    toolArgs: Record<string, unknown> | undefined,
    toolOutput: string | undefined,
  ): void {
    const id =
      asNonEmptyString(toolArgs?.taskId) ?? toolOutput?.trim().match(UPDATE_OUTPUT)?.[1];
    if (!id) return;

    // `deleted` is not a display status — the task leaves the list entirely.
    if (toolArgs?.status === "deleted") {
      this.tasks.delete(id);
      return;
    }

    const existing = this.tasks.get(id);
    const subject = asNonEmptyString(toolArgs?.subject);
    const status = asStatus(toolArgs?.status);

    this.tasks.set(id, {
      id,
      subject: subject ?? existing?.subject ?? `Task #${id}`,
      status: status ?? existing?.status ?? "pending",
      subjectKnown: Boolean(subject) || (existing?.subjectKnown ?? false),
    });
  }

  /** TaskList reports the whole list, so it is authoritative — replace state. */
  private applyList(toolOutput: string | undefined): void {
    if (typeof toolOutput !== "string") return;

    const parsed = new Map<string, TaskEntry>();
    for (const line of toolOutput.split("\n")) {
      const match = line.trim().match(LIST_LINE);
      if (!match) continue;

      const [, id, rawStatus, rawSubject] = match;
      const existing = this.tasks.get(id);
      parsed.set(id, {
        id,
        // Prefer the subject captured at creation: it is exact, whereas the
        // list line has owner/blocked decorations appended to it.
        subject: existing?.subjectKnown ? existing.subject : stripListDecorations(rawSubject),
        status: asStatus(rawStatus) ?? existing?.status ?? "pending",
        subjectKnown: true,
      });
    }

    // An empty list is a legitimate state, but so is output we failed to parse.
    // Only trust a wholesale replacement when at least one line parsed, or when
    // the output really was empty.
    if (parsed.size > 0 || toolOutput.trim().length === 0) {
      this.tasks = parsed;
    }
  }

  private applyGet(
    toolArgs: Record<string, unknown> | undefined,
    toolOutput: string | undefined,
  ): void {
    if (typeof toolOutput !== "string") return;

    const header = toolOutput.trim().match(GET_HEADER);
    const id = header?.[1] ?? asNonEmptyString(toolArgs?.taskId);
    if (!id) return;

    const existing = this.tasks.get(id);
    const subject = header?.[2]?.split("\n")[0]?.trim();
    const status = asStatus(toolOutput.match(GET_STATUS)?.[1]);

    this.tasks.set(id, {
      id,
      subject: subject ?? existing?.subject ?? `Task #${id}`,
      status: status ?? existing?.status ?? "pending",
      subjectKnown: Boolean(subject) || (existing?.subjectKnown ?? false),
    });
  }
}

/** Whether a tool name is one of the task-list tools the registry models. */
export function isTaskListTool(toolName: string | undefined): boolean {
  switch (toolName?.toLowerCase()) {
    case "taskcreate":
    case "task_create":
    case "taskupdate":
    case "task_update":
    case "taskget":
    case "task_get":
    case "tasklist":
    case "task_list":
      return true;
    default:
      return false;
  }
}
