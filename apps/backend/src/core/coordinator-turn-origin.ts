/**
 * Where a coordinator call's delegation came from, for the registry commands
 * that build a delegated prompt (`launch_environment`, the fork, a launch on
 * another node). The Control MCP tools read the same answer through
 * `coordinatorScopeTurnOrigin`; mail reads it in its own command.
 */
import { coordinatorCallTurnOrigin } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";

/**
 * `"mail"` when the call's turn was not started by the user: the scope's own
 * recorded origin (a scheduled fire's) when it has one, else the
 * conversation's newest turn. A conversation that is no longer found counts
 * as mail.
 */
export async function coordinatorCallerTurnOrigin(
  context: Pick<CommandContext, "storage">,
  caller: { coordinatorId: string; conversationId: string },
  scope: unknown,
): Promise<"mail" | undefined> {
  const recorded =
    scope && typeof scope === "object" ? (scope as { turnOrigin?: unknown }).turnOrigin : undefined;
  if (recorded === "user" || recorded === "mail") {
    return coordinatorCallTurnOrigin(undefined, recorded);
  }
  const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(
    caller.coordinatorId,
  );
  const conversation = workspace?.conversations.find((item) => item.id === caller.conversationId);
  return coordinatorCallTurnOrigin(conversation?.lastTurnOrigin);
}
