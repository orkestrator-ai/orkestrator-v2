/**
 * A Kanban ticket's column belongs to its build while the build runs.
 *
 * From the moment a build is admitted until it ends (`complete` or `failed`;
 * a paused build has not ended), only the build lifecycle
 * (`build-pipeline-kanban-lifecycle.ts`) moves the ticket. Everything else
 * still edits the ticket (title, description, comments, labels, images), but
 * a status change from anyone else is left out: a drag on the board, an
 * agent's `update_ticket`, the public API, self-improvement, a closed pull
 * request, or a command node's copy of the ticket arriving through sync.
 * Before this, any of those could move a ticket that was still being built
 * back to the backlog while the build carried on.
 *
 * A build holds the ticket it reports to: a pipeline whose source is that
 * Kanban ticket, which is the only kind the lifecycle ever moves.
 */
import type { PersistedBuildPipeline } from "./storage-shared.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ticket a stored pipeline holds, or undefined when it holds none. */
export function ticketHeldByBuild(
  record: Pick<PersistedBuildPipeline, "snapshot">,
): string | undefined {
  const snapshot = record.snapshot as unknown;
  if (!isRecord(snapshot)) return undefined;
  const phase = snapshot.phase;
  if (typeof phase !== "string" || phase === "complete" || phase === "failed") return undefined;
  const source = snapshot.source;
  if (!isRecord(source) || source.type !== "kanban") return undefined;
  return typeof source.taskId === "string" && source.taskId ? source.taskId : undefined;
}

/** The tickets whose column a build on this machine holds. */
export function ticketsHeldByBuilds(
  records: Iterable<Pick<PersistedBuildPipeline, "snapshot">>,
): Set<string> {
  const held = new Set<string>();
  for (const record of records) {
    const taskId = ticketHeldByBuild(record);
    if (taskId) held.add(taskId);
  }
  return held;
}

/** How the Kanban store asks which tickets builds hold; none when not wired. */
export type BuildTicketHolds = () => Promise<ReadonlySet<string>>;

export const NO_BUILD_TICKET_HOLDS: BuildTicketHolds = async () => new Set();
