const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export function isTodoItem(item: unknown): item is TodoItem {
  if (typeof item !== "object" || item === null) return false;

  const candidate = item as Record<string, unknown>;

  return (
    typeof candidate.content === "string" &&
    typeof candidate.status === "string" &&
    TODO_STATUSES.includes(candidate.status as TodoStatus)
  );
}

function normalizeTodoStatus(status: unknown): TodoStatus | undefined {
  if (typeof status !== "string") return undefined;

  const normalized = status.trim().toLowerCase().replace(/[-\s]+/g, "_");

  if (normalized === "complete" || normalized === "done") return "completed";
  if (normalized === "running" || normalized === "active") return "in_progress";
  if (normalized === "todo" || normalized === "open") return "pending";
  if (normalized === "canceled") return "cancelled";
  if (normalized === "deleted") return "cancelled";

  return TODO_STATUSES.includes(normalized as TodoStatus)
    ? (normalized as TodoStatus)
    : undefined;
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

function firstTodosArray(candidate: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(candidate.newTodos)) return candidate.newTodos;
  if (Array.isArray(candidate.new_todos)) return candidate.new_todos;
  if (Array.isArray(candidate.todos)) return candidate.todos;
  return undefined;
}

function taskCandidatesFromPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;

  if (typeof value !== "object" || value === null) return [];

  const candidate = value as Record<string, unknown>;

  const todosArray = firstTodosArray(candidate);
  if (todosArray) return todosArray;
  if (Array.isArray(candidate.tasks)) return candidate.tasks;
  if (Array.isArray(candidate.items)) return candidate.items;

  const singleTask = candidate.task;
  if (typeof singleTask === "object" && singleTask !== null) return [singleTask];

  return [candidate];
}

function looksLikePlaceholderTaskLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^(?:task\s*)?#?\d+$/.test(normalized);
}

function bestTaskContent(...values: unknown[]): string | undefined {
  const candidates = values
    .map((value) => readString(value))
    .filter((value): value is string => typeof value === "string");

  return (
    candidates.find((value) => !looksLikePlaceholderTaskLabel(value)) ??
    candidates[0]
  );
}

function taskContentFromRecord(record: Record<string, unknown>): string | undefined {
  const taskId = readString(
    record.taskId,
    record.taskID,
    record.task_id,
    record.id,
  );
  const content = bestTaskContent(
    record.subject,
    record.title,
    record.content,
    record.task,
    record.description,
    record.name,
    record.text,
    record.activeForm,
    record.active_form,
  );

  const idPrefix = `#${taskId}`;
  if (content && taskId && !content.startsWith(`${idPrefix} `) && content !== idPrefix) {
    return `${idPrefix} ${content}`;
  }
  if (content) return content;
  if (taskId) return `Task #${taskId}`;

  return undefined;
}

function parseTaskItemsFromPayload(
  value: unknown,
  options?: { requireRecognizedStatus?: boolean },
): TodoItem[] {
  return taskCandidatesFromPayload(value).flatMap((candidate) => {
    if (typeof candidate === "string") {
      const content = candidate.trim();
      return content ? [{ content, status: "pending" as const }] : [];
    }

    if (typeof candidate !== "object" || candidate === null) return [];

    const record = candidate as Record<string, unknown>;
    const content = taskContentFromRecord(record);
    if (!content) return [];
    const status = normalizeTodoStatus(record.status);
    if (options?.requireRecognizedStatus && !status) return [];

    return [{
      content,
      status: status ?? "pending",
    }];
  });
}

function extractTodos(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;

  if (typeof value === "object" && value !== null) {
    const todosArray = firstTodosArray(value as Record<string, unknown>);
    if (todosArray) return todosArray;
  }

  return [];
}

export function parseTodosFromOutput(toolOutput?: string): TodoItem[] {
  if (!toolOutput) return [];

  try {
    const parsed = JSON.parse(toolOutput) as unknown;
    return parseTaskItemsFromPayload(extractTodos(parsed), {
      requireRecognizedStatus: true,
    });
  } catch {
    return [];
  }
}

function parseTaskItemsFromOutput(toolOutput?: string): TodoItem[] {
  if (!toolOutput) return [];

  try {
    const parsed = JSON.parse(toolOutput) as unknown;
    return parseTaskItemsFromPayload(parsed);
  } catch {
    return [];
  }
}

export function getTodoItems(
  toolArgs?: Record<string, unknown>,
  toolOutput?: string,
  toolName?: string,
): TodoItem[] {
  const todosFromArgs = Array.isArray(toolArgs?.todos)
    ? parseTaskItemsFromPayload(toolArgs.todos, {
        requireRecognizedStatus: true,
      })
    : [];

  if (todosFromArgs.length > 0) {
    return todosFromArgs;
  }

  const isTaskTool = isTaskTodoTool(toolName);
  if (isTaskTool) {
    const tasksFromArgs = parseTaskItemsFromPayload(toolArgs);
    if (tasksFromArgs.length > 0) {
      return tasksFromArgs;
    }
  }

  const todosFromOutput = parseTodosFromOutput(toolOutput);
  if (todosFromOutput.length > 0) {
    return todosFromOutput;
  }

  return isTaskTool ? parseTaskItemsFromOutput(toolOutput) : [];
}

const TASK_TODO_TOOL_NAMES = new Set([
  "taskcreate",
  "taskupdate",
  "taskget",
  "tasklist",
  "task_create",
  "task_update",
  "task_get",
  "task_list",
]);
const TODO_TOOL_NAMES = new Set(["todowrite", "todo_list"]);

function normalizeToolName(toolName?: string): string | undefined {
  return typeof toolName === "string" ? toolName.trim().toLowerCase() : undefined;
}

export function isTaskTodoTool(toolName?: string): boolean {
  const normalized = normalizeToolName(toolName);
  return typeof normalized === "string" && TASK_TODO_TOOL_NAMES.has(normalized);
}

export function isTodoTool(toolName?: string): boolean {
  const normalized = normalizeToolName(toolName);
  return (
    typeof normalized === "string" &&
    (TODO_TOOL_NAMES.has(normalized) || TASK_TODO_TOOL_NAMES.has(normalized))
  );
}

export function getTodoToolLabel(toolName?: string): string {
  const normalized = normalizeToolName(toolName);

  if (normalized === "todo_list") return "Todo List";
  if (normalized === "taskcreate" || normalized === "task_create") return "Task Create";
  if (normalized === "taskupdate" || normalized === "task_update") return "Task Update";
  if (normalized === "taskget" || normalized === "task_get") return "Task Get";
  if (normalized === "tasklist" || normalized === "task_list") return "Task List";

  return toolName || "TodoWrite";
}
