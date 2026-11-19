import { promptQueueEditViews } from "@orkestrator/protocol/prompt-queue-edit";
import type { PersistedPromptQueue } from "./models.js";

/**
 * The `editing` field of a session projection's queue: the items being edited
 * in place, which the backend is holding back. Absent when there are none.
 * Both projection reads (full and progressive) use it.
 */
export function nativeAgentQueueEditingField(queue: PersistedPromptQueue): {
  editing?: ReturnType<typeof promptQueueEditViews>;
} {
  const editing = promptQueueEditViews(queue);
  return editing.length > 0 ? { editing } : {};
}
