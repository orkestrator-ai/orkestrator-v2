import { invoke } from "@/lib/native/backend";
import type { HumanPromptList } from "@orkestrator/protocol/human-prompts";
import type { UserCommandList, UserCommandRecord } from "@orkestrator/protocol/user-commands";

/** Run a composer `!` command as the user in this tab's workspace. */
export function runUserCommand(input: {
  environmentId: string;
  tabId: string;
  command: string;
}): Promise<UserCommandRecord> {
  return invoke("run_user_command", input);
}

export function listUserCommands(environmentId: string, tabId: string): Promise<UserCommandList> {
  return invoke("list_user_commands", { environmentId, tabId });
}

/** Send a line (or, with `enter: false`, raw text) to a running user command. */
export function writeUserCommandInput(
  id: string,
  text: string,
  enter = true,
): Promise<UserCommandRecord> {
  return invoke("write_user_command_input", { id, text, enter });
}

export function cancelUserCommand(id: string): Promise<UserCommandRecord> {
  return invoke("cancel_user_command", { id });
}

/** Prompts waiting on the user, in these environments (all when omitted). */
export function listHumanPrompts(environmentIds?: readonly string[]): Promise<HumanPromptList> {
  return invoke("list_human_prompts", environmentIds ? { environmentIds } : {});
}
