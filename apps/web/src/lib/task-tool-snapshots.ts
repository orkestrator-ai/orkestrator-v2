import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import { isTaskTodoTool, type TodoStatus } from "@/lib/todo-tool";

interface ParsedTaskItem {
  id?: string;
  content?: string;
  status?: TodoStatus;
  placeholder: boolean;
}

interface TaskSnapshotItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const TASK_CREATE_NAMES = new Set(["taskcreate", "task_create"]);
const TASK_LIST_NAMES = new Set(["tasklist", "task_list"]);

function normalizeToolName(toolName?: string): string {
  return typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
}

function normalizeStatus(status: unknown): TodoStatus | undefined {
  if (typeof status !== "string") return undefined;

  const normalized = status.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "complete" || normalized === "done") return "completed";
  if (normalized === "running" || normalized === "active") return "in_progress";
  if (normalized === "todo" || normalized === "open") return "pending";
  if (normalized === "canceled" || normalized === "deleted") return "cancelled";

  if (
    normalized === "pending" ||
    normalized === "in_progress" ||
    normalized === "completed" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }

  return undefined;
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }

    if (typeof value === "number") {
      return String(value);
    }
  }

  return undefined;
}

function looksLikePlaceholderTaskLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^(?:task\s*)?#?\d+$/.test(normalized);
}

function firstTaskArray(candidate: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(candidate.tasks)) return candidate.tasks;
  if (Array.isArray(candidate.items)) return candidate.items;
  if (Array.isArray(candidate.todos)) return candidate.todos;
  if (Array.isArray(candidate.newTodos)) return candidate.newTodos;
  if (Array.isArray(candidate.new_todos)) return candidate.new_todos;
  return undefined;
}

function taskCandidatesFromPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return [];

  const candidate = value as Record<string, unknown>;
  const taskArray = firstTaskArray(candidate);
  if (taskArray) return taskArray;

  const task = candidate.task;
  if (typeof task === "object" && task !== null) return [task];

  return [candidate];
}

function taskIdFromRecord(record: Record<string, unknown>): string | undefined {
  return readString(record.taskId, record.taskID, record.task_id, record.id);
}

function taskContentFromRecord(record: Record<string, unknown>): {
  content?: string;
  placeholder: boolean;
} {
  const candidates = [
    record.subject,
    record.title,
    record.name,
    record.content,
    record.text,
    record.task,
    record.description,
    record.activeForm,
    record.active_form,
  ]
    .map((value) => readString(value))
    .filter((value): value is string => typeof value === "string");

  const content = candidates.find((value) => !looksLikePlaceholderTaskLabel(value));
  if (content) return { content, placeholder: false };

  const fallback = candidates[0];
  return { content: fallback, placeholder: Boolean(fallback) };
}

function parseTaskItemsFromPayload(value: unknown): ParsedTaskItem[] {
  return taskCandidatesFromPayload(value).flatMap((candidate): ParsedTaskItem[] => {
    if (typeof candidate === "string") {
      const content = candidate.trim();
      return content ? [{ content, status: "pending" as const, placeholder: false }] : [];
    }

    if (typeof candidate !== "object" || candidate === null) return [];

    const record = candidate as Record<string, unknown>;
    const id = taskIdFromRecord(record);
    const { content, placeholder } = taskContentFromRecord(record);
    const status = normalizeStatus(record.status);

    if (!id && !content && !status) return [];

    return [{ id, content, status, placeholder }];
  });
}

function parseJsonPayload(value?: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parsedTaskItemsFromPart(part: ClaudeMessagePart): ParsedTaskItem[] {
  if (!isTaskTodoTool(part.toolName)) return [];

  const fromArgs = parseTaskItemsFromPayload(part.toolArgs);
  const fromOutput = parseTaskItemsFromPayload(parseJsonPayload(part.toolOutput));

  if (fromArgs.length === 0) return fromOutput;
  if (fromOutput.length === 0) return fromArgs;

  return fromArgs.map((item, index) => {
    const outputItem = fromOutput[index];
    if (!outputItem) return item;

    return {
      id: item.id ?? outputItem.id,
      content:
        item.placeholder && outputItem.content && !outputItem.placeholder
          ? outputItem.content
          : item.content ?? outputItem.content,
      status: item.status ?? outputItem.status,
      placeholder: item.placeholder && outputItem.placeholder,
    };
  });
}

class TaskSnapshotAccumulator {
  private items = new Map<string, TaskSnapshotItem>();
  private order: string[] = [];
  private nextImplicitId = 1;

  apply(part: ClaudeMessagePart): TaskSnapshotItem[] {
    const toolName = normalizeToolName(part.toolName);
    const parsedItems = parsedTaskItemsFromPart(part);

    if (TASK_LIST_NAMES.has(toolName) && parsedItems.length > 0) {
      this.replaceWith(parsedItems);
    } else {
      for (const parsed of parsedItems) {
        this.upsert(parsed, TASK_CREATE_NAMES.has(toolName));
      }
    }

    return this.snapshot();
  }

  private replaceWith(parsedItems: ParsedTaskItem[]) {
    this.items.clear();
    this.order = [];
    for (const [index, parsed] of parsedItems.entries()) {
      this.upsert(parsed, false, String(index + 1));
    }
  }

  private upsert(parsed: ParsedTaskItem, isCreate: boolean, fallbackId?: string) {
    const id = parsed.id ?? (isCreate ? String(this.nextImplicitId++) : fallbackId);
    if (!id) return;
    this.reserveImplicitId(id);

    const existing = this.items.get(id);
    const content =
      parsed.content && !parsed.placeholder
        ? parsed.content
        : existing?.content ?? parsed.content ?? `Task #${id}`;
    const status = parsed.status ?? existing?.status ?? "pending";

    if (!this.items.has(id)) {
      this.order.push(id);
    }
    this.items.set(id, { id, content, status });
  }

  private reserveImplicitId(id: string) {
    const numericId = Number(id);
    if (Number.isInteger(numericId) && numericId >= this.nextImplicitId) {
      this.nextImplicitId = numericId + 1;
    }
  }

  private snapshot(): TaskSnapshotItem[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((item): item is TaskSnapshotItem => Boolean(item));
  }
}

function buildTaskSnapshotPart(
  source: ClaudeMessagePart,
  snapshot: TaskSnapshotItem[],
): ClaudeMessagePart {
  return {
    ...source,
    type: "tool-invocation",
    toolName: "TaskList",
    toolTitle: "Task List",
    toolArgs: {
      todos: snapshot.map((item) => ({
        content: item.content,
        status: item.status,
      })),
    },
    toolOutput: undefined,
  };
}

function textOfParts(parts: ClaudeMessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.content ?? "")
    .join("\n");
}

function hasVisibleMessageContent(message: ClaudeMessage): boolean {
  return (
    message.role === "user" ||
    message.parts.length > 0 ||
    message.content.trim().length > 0
  );
}

export function collapseTaskToolUpdates(messages: ClaudeMessage[]): ClaudeMessage[] {
  let sawTaskTool = false;
  let latestSnapshot: { messageIndex: number; partIndex: number } | null = null;
  const accumulator = new TaskSnapshotAccumulator();
  const nextMessages = messages.map((message) => ({
    ...message,
    parts: [...message.parts] as Array<ClaudeMessagePart | null>,
  }));

  for (let messageIndex = 0; messageIndex < nextMessages.length; messageIndex++) {
    const message = nextMessages[messageIndex]!;

    for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
      const part = message.parts[partIndex];
      if (!part) continue;
      if (part.type !== "tool-invocation" || !isTaskTodoTool(part.toolName)) {
        continue;
      }

      sawTaskTool = true;
      const snapshot = accumulator.apply(part);
      if (snapshot.length === 0) continue;

      if (latestSnapshot) {
        nextMessages[latestSnapshot.messageIndex]!.parts[latestSnapshot.partIndex] = null;
      }

      message.parts[partIndex] = buildTaskSnapshotPart(part, snapshot);
      latestSnapshot = { messageIndex, partIndex };
    }
  }

  if (!sawTaskTool) return messages;

  return nextMessages
    .map((message) => {
      const parts = message.parts.filter(
        (part): part is ClaudeMessagePart => part !== null,
      );
      return {
        ...message,
        parts,
        content: textOfParts(parts),
      };
    })
    .filter(hasVisibleMessageContent);
}
