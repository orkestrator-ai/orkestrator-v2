/**
 * The `kanban` domain on a `lib/backend` factory's client (plan item 7008):
 * `kanban(client).get_kanban_tasks({ projectId })`. See `./domain-api.ts` for
 * the adapter choice: a node that advertises the domain gets version 1 (the
 * envelope travels and results are decoded); any other node gets version 0,
 * exactly today's call.
 *
 * Kanban ticket ids are the same on every node, so a caller keeps what it
 * reads under the node it asked: one client per node scope.
 */
import { kanbanClient, type KanbanApi } from "@orkestrator/protocol/contract/domains/kanban";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { KanbanApi } from "@orkestrator/protocol/contract/domains/kanban";

export function kanban(client: BackendClient): KanbanApi {
  return domainApi(client, kanbanClient);
}

/**
 * The arguments of a command that takes none. Version 0 then sends today's
 * body, the command name without an arguments object.
 */
export const NO_ARGS = undefined as unknown as Record<string, never>;

/**
 * A decoded result as the web's own model type. The protocol schemas declare
 * the fields readers route on and keep the rest (open structs); the web's
 * types are narrower (literal unions for statuses and kinds) until plan item
 * 7010 converges them.
 */
export function asKanbanModel<T>(result: Promise<unknown>): Promise<T> {
  return result as Promise<T>;
}
