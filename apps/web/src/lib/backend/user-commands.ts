import type { HumanPromptList } from "@orkestrator/protocol/human-prompts";
import type { UserCommandList, UserCommandRecord } from "@orkestrator/protocol/user-commands";
import { terminals } from "@/lib/node-scope/domains/terminals";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createUserCommandsApi(client: BackendClient) {
  // The `terminals` domain client (plan item 7002): user commands are part of it.
  const domain = () => terminals(client);

  /** Run a composer `!` command as the user in this tab's workspace. */
  function runUserCommand(input: {
    environmentId: string;
    tabId: string;
    command: string;
  }): Promise<UserCommandRecord> {
    return domain().run_user_command(input);
  }

  // The decoded answers are the protocol's readonly records; callers keep the
  // mutable `UserCommandList` / `HumanPromptList` views of the same shape.
  async function listUserCommands(environmentId: string, tabId: string): Promise<UserCommandList> {
    return (await domain().list_user_commands({ environmentId, tabId })) as UserCommandList;
  }

  /** Send a line (or, with `enter: false`, raw text) to a running user command. */
  function writeUserCommandInput(
    id: string,
    text: string,
    enter = true,
  ): Promise<UserCommandRecord> {
    return domain().write_user_command_input({ id, text, enter });
  }

  function cancelUserCommand(id: string): Promise<UserCommandRecord> {
    return domain().cancel_user_command({ id });
  }

  /** Prompts waiting on the user, in these environments (all when omitted). */
  async function listHumanPrompts(environmentIds?: readonly string[]): Promise<HumanPromptList> {
    return (await domain().list_human_prompts(
      environmentIds ? { environmentIds } : {},
    )) as HumanPromptList;
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
