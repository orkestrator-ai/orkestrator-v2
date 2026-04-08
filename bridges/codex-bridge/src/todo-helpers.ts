export interface TodoListItem {
  text: string;
  completed: boolean;
}

export function summarizeTodoList(items: TodoListItem[]): string {
  return items
    .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`)
    .join("\n");
}

export function mapTodoArgs(items: TodoListItem[]): {
  todos: Array<{ content: string; status: "completed" | "pending" }>;
} {
  return {
    todos: items.map((todo) => ({
      content: todo.text,
      status: todo.completed ? "completed" : "pending",
    })),
  };
}
