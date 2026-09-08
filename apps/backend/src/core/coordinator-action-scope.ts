import { createHash } from "node:crypto";
import type { CommandContext } from "./commands-context.js";

export function actionHash(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (!item || typeof item !== "object") return item;
    const fields = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(fields)
        .sort()
        .flatMap((key) =>
          fields[key] === undefined ? [] : [[key, canonicalize(fields[key])] as const],
        ),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export async function requireCoordinatorConversation(
  context: CommandContext,
  projectId: string,
  coordinatorId: string,
  conversationId: string,
): Promise<void> {
  const workspace = await context.storage.getCoordinatorWorkspaceById(coordinatorId);
  if (
    !workspace ||
    workspace.projectId !== projectId ||
    workspace.lifecycleState !== "ready" ||
    !workspace.conversations.some((item) => item.id === conversationId && !item.closedAt)
  )
    throw new Error("Coordinator identity is unavailable");
}
