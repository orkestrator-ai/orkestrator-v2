const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export const TODO_SNAPSHOT_MESSAGE_PREFIX = "todo-snapshot-";

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

export interface TodoTimelinePart {
  type?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolError?: string;
  toolUseId?: string;
  parentTaskUseId?: string;
  isMcpTool?: boolean;
  mcpServerName?: string;
}

export interface TodoTimelineMessage<TPart extends TodoTimelinePart = TodoTimelinePart> {
  id: string;
  role: string;
  content: string;
  parts: TPart[];
}

const TODO_TOOL_NAMES = new Set(["TodoWrite", "todowrite"]);

export function isTodoTool(toolName?: string): boolean {
  return typeof toolName === "string" && TODO_TOOL_NAMES.has(toolName);
}

function isTodoSnapshotMessageId(messageId: string): boolean {
  return messageId.startsWith(TODO_SNAPSHOT_MESSAGE_PREFIX);
}

function getLatestTodoPart<TMessage extends TodoTimelineMessage>(
  messages: TMessage[],
): { message: TMessage; part: TodoTimelinePart; todos: TodoItem[] } | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message) continue;

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex] as TodoTimelinePart | undefined;
      if (!part || !isTodoTool(part.toolName)) continue;

      const todos = getTodoItems(part.toolArgs, part.toolOutput);
      if (todos.length === 0) continue;

      return { message, part, todos };
    }
  }

  return null;
}

export function getLatestTimestamp<T>(
  messages: T[],
  getTimestamp: (message: T) => string | undefined,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const ts = getTimestamp(messages[index] as T);
    if (typeof ts !== "string" || ts.length === 0) continue;

    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed + 1).toISOString();
    }
  }

  return new Date().toISOString();
}

export function appendLatestTodoSnapshot<
  TMessage extends TodoTimelineMessage,
>(
  messages: TMessage[],
  createMessage: (source: {
    message: TMessage;
    part: TodoTimelinePart;
    todos: TodoItem[];
  }) => TMessage,
): TMessage[] {
  const baseMessages = messages.filter((message) => !isTodoSnapshotMessageId(message.id));
  const latestTodo = getLatestTodoPart(baseMessages);

  if (!latestTodo) {
    return baseMessages;
  }

  // Don't append snapshot when all todos are finished (completed or cancelled)
  const hasActiveTodos = latestTodo.todos.some(
    (todo) => todo.status !== "completed" && todo.status !== "cancelled",
  );
  if (!hasActiveTodos) {
    return baseMessages;
  }

  return [...baseMessages, createMessage(latestTodo)];
}
