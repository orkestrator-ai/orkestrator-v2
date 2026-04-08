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

export function getTodoItems(
  toolArgs?: Record<string, unknown>,
  toolOutput?: string,
): TodoItem[] {
  const todosFromArgs = Array.isArray(toolArgs?.todos)
    ? toolArgs.todos.filter(isTodoItem)
    : [];

  if (todosFromArgs.length > 0) {
    return todosFromArgs;
  }

  return parseTodosFromOutput(toolOutput);
}

const TODO_TOOL_NAMES = new Set(["TodoWrite", "todowrite", "todo_list"]);

export function isTodoTool(toolName?: string): boolean {
  return typeof toolName === "string" && TODO_TOOL_NAMES.has(toolName);
}
