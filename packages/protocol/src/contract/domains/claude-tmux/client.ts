/**
 * The `claude-tmux` domain client (plan item 7002; §11.2 "Client
 * adapters"): one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (the expected prompt of
 *   `claude_tmux_answer_selection_prompt` is critical) and gets the paged
 *   transcript whenever `page` is sent.
 * - Version 0 (a pre-contract node) is today's untyped call, `{ command,
 *   args }`, answered as sent (`legacyCommandApi`). The tmux commands were
 *   never capability-gated; a node that predates transcript paging answers
 *   the whole file as an array, which the caller reads as a page with
 *   nothing before it (the result schema accepts both forms).
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `claude-tmux` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { CLAUDE_TMUX_COMMANDS } from "./commands.js";
import { claudeTmuxDomain } from "./domain.js";

export type ClaudeTmuxApi = CommandApi<typeof CLAUDE_TMUX_COMMANDS>;

const claudeTmuxApi = (call: CommandCall): ClaudeTmuxApi => commandApi(call, CLAUDE_TMUX_COMMANDS);
const legacyClaudeTmuxApi = (_call: CommandCall, context: DomainAdapterContext): ClaudeTmuxApi =>
  legacyCommandApi(context, CLAUDE_TMUX_COMMANDS);

export const claudeTmuxClient = domainClient(claudeTmuxDomain, {
  1: claudeTmuxApi,
  0: legacyClaudeTmuxApi,
});
