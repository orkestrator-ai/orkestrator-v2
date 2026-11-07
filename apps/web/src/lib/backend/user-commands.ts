import type { HumanPromptList } from "@orkestrator/protocol/human-prompts";
import type { UserCommandList, UserCommandRecord } from "@orkestrator/protocol/user-commands";
import { clientInvoke, commandBackendClient, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createUserCommandsApi(client: BackendClient) {
  const invoke = clientInvoke(client);

  /** Run a composer `!` command as the user in this tab's workspace. */
  function runUserCommand(input: {
    environmentId: string;
    tabId: string;
    command: string;
  }): Promise<UserCommandRecord> {
    return invoke("run_user_command", input);
  }

  function listUserCommands(environmentId: string, tabId: string): Promise<UserCommandList> {
    return invoke("list_user_commands", { environmentId, tabId });
  }

  /** Send a line (or, with `enter: false`, raw text) to a running user command. */
  function writeUserCommandInput(
    id: string,
    text: string,
    enter = true,
  ): Promise<UserCommandRecord> {
    return invoke("write_user_command_input", { id, text, enter });
  }

  function cancelUserCommand(id: string): Promise<UserCommandRecord> {
    return invoke("cancel_user_command", { id });
  }

  /** Prompts waiting on the user, in these environments (all when omitted). */
  function listHumanPrompts(environmentIds?: readonly string[]): Promise<HumanPromptList> {
    return invoke("list_human_prompts", environmentIds ? { environmentIds } : {});
  }

  return {
    runUserCommand,
    listUserCommands,
    writeUserCommandInput,
    cancelUserCommand,
    listHumanPrompts,
  };
}

export type UserCommandsApi = ReturnType<typeof createUserCommandsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  runUserCommand,
  listUserCommands,
  writeUserCommandInput,
  cancelUserCommand,
  listHumanPrompts,
} = createUserCommandsApi(commandBackendClient);
