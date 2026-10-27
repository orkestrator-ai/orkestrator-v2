/**
 * Trimming the served transcript after another client rewound the thread.
 *
 * `thread/reverted` names only the thread, so the bridge asks app-server which
 * turns remain and drops what belongs to the others. A revert only ever
 * removes a suffix of turns, so the cut is a single index.
 */
import type { NormalizedMessage } from "../messages/types.js";

/**
 * Where to cut `messages` so they hold only `survivingTurnIds`, or undefined
 * when nothing needs to go or the cut cannot be proved.
 *
 * Messages that carry a turn id are judged by it alone: the first one whose
 * turn no longer exists starts the removed suffix. A transcript with no turn
 * ids at all falls back to app-server's own model of a thread, one turn per
 * user message, but only while no turn runs: a running turn's prompt may not
 * be in app-server's list yet, and cutting it would drop the live turn.
 */
export function externalRevertCut(
  messages: readonly Pick<NormalizedMessage, "role" | "turnId">[],
  survivingTurnIds: readonly string[],
  running: boolean,
): number | undefined {
  const surviving = new Set(survivingTurnIds);
  if (messages.some((message) => message.turnId)) {
    const index = messages.findIndex(
      (message) => message.turnId !== undefined && !surviving.has(message.turnId),
    );
    return index < 0 ? undefined : index;
  }
  if (running) return undefined;
  let users = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]!.role !== "user") continue;
    if (users === survivingTurnIds.length) return index;
    users += 1;
  }
  return undefined;
}
