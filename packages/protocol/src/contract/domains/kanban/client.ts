/**
 * The `kanban` domain client (plan item 7008; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`requestId`, `markdown`/`sections`,
 *   `projectId` and `operationId` are critical where the definitions say) and
 *   decodes the result with the command's schema.
 * - Version 0 (a pre-contract node) is today's untyped call, answered as sent
 *   (`legacyCommandApi`). No Kanban, feature-plan or Linear command was ever
 *   capability-gated, so there is nothing to fold into version 1; what an
 *   older node lacks it answers with `unknown-command` (the feature-plan build
 *   fallback reads that, `feature-plan-build-compat.ts`).
 *
 * Kanban ticket ids are the same on every node, so a caller keeps results
 * under the node it asked (one client per node scope).
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `kanban` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { KANBAN_COMMANDS } from "./commands.js";
import { kanbanDomain } from "./domain.js";

export type KanbanApi = CommandApi<typeof KANBAN_COMMANDS>;

const kanbanApi = (call: CommandCall): KanbanApi => commandApi(call, KANBAN_COMMANDS);
const legacyKanbanApi = (_call: CommandCall, context: DomainAdapterContext): KanbanApi =>
  legacyCommandApi(context, KANBAN_COMMANDS);

export const kanbanClient = domainClient(kanbanDomain, {
  2: kanbanApi,
  // Version 2 only removed commands nothing called (2026-11-10), so version 1
  // peers take the same API. Adapter 1 goes when the support floor passes the
  // first Stable release with version 2.
  1: kanbanApi,
  0: legacyKanbanApi,
});
