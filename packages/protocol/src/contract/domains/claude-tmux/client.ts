/**
 * The `claude-tmux` domain client (plan item 7002; §11.2 "Client
 * adapters"): one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (the expected prompt of
 *   `claude_tmux_answer_selection_prompt` is critical) and gets the paged
 *   transcript whenever `page` is sent.
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26). A domains map
 * that omits this domain yields `unsupported-version`. Without a domains
 * map, calls use the lowest adapter unnegotiated. Later bumps keep an
 * adapter for every version a release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import { commandApi, type CommandApi } from "../command-api.js";
import { CLAUDE_TMUX_COMMANDS } from "./commands.js";
import { claudeTmuxDomain } from "./domain.js";

export type ClaudeTmuxApi = CommandApi<typeof CLAUDE_TMUX_COMMANDS>;

const claudeTmuxApi = (call: CommandCall): ClaudeTmuxApi => commandApi(call, CLAUDE_TMUX_COMMANDS);

export const claudeTmuxClient = domainClient(claudeTmuxDomain, {
  1: claudeTmuxApi,
});
