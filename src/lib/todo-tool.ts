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

function taskCandidatesFromPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;

  if (typeof value !== "object" || value === null) return [];

  const candidate = value as Record<string, unknown>;

  if (Array.isArray(candidate.tasks)) return candidate.tasks;
  if (Array.isArray(candidate.items)) return candidate.items;

  const singleTask = candidate.task;
  if (typeof singleTask === "object" && singleTask !== null) return [singleTask];

  return [candidate];
}

function taskContentFromRecord(record: Record<string, unknown>): string | undefined {
  const taskId = readString(
    record.taskId,
    record.taskID,
    record.task_id,
    record.id,
  );
  const content = readString(
    record.content,
    record.title,
    record.task,
    record.description,
    record.name,
    record.text,
  );

  if (content && taskId) return `#${taskId} ${content}`;
  if (content) return content;
  if (taskId) return `Task #${taskId}`;

  return undefined;
}

function parseTaskItemsFromPayload(value: unknown): TodoItem[] {
  return taskCandidatesFromPayload(value).flatMap((candidate) => {
    if (typeof candidate === "string") {
      const content = candidate.trim();
      return content ? [{ content, status: "pending" as const }] : [];
    }

    if (typeof candidate !== "object" || candidate === null) return [];

    const record = candidate as Record<string, unknown>;
    const content = taskContentFromRecord(record);
    if (!content) return [];

    return [{
      content,
      status: normalizeTodoStatus(record.status) ?? "pending",
    }];
  });
}

function extractTodos(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    if (Array.isArray(candidate.todos)) {
      return candidate.todos;
    }
  }

  return [];
}

export function parseTodosFromOutput(toolOutput?: string): TodoItem[] {
  if (!toolOutput) return [];

  try {
    const parsed = JSON.parse(toolOutput) as unknown;
    return extractTodos(parsed).filter(isTodoItem);
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
    ? toolArgs.todos.filter(isTodoItem)
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
  "task_create",
  "task_update",
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

  return toolName || "TodoWrite";
}
