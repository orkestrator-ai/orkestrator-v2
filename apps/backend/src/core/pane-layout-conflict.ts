import { Data } from "effect";
import { paneLayoutRevisionConflictMessage } from "@orkestrator/protocol/pane-layout";

/**
 * A pane layout save or delete named a revision that is no longer current.
 * Code `pane-layout-revision-conflict` (`contract/ipc-error.ts`); readers use
 * `isPaneLayoutRevisionConflict` (`@orkestrator/protocol/pane-layout`), and
 * the message keeps `Pane layout revision conflict:` for older renderers.
 */
export class PaneLayoutRevisionConflictError extends Data.TaggedError(
  "PaneLayoutRevisionConflictError",
)<{ readonly message: string }> {
  readonly code = "pane-layout-revision-conflict" as const;
}

export function paneLayoutRevisionConflict(
  expectedRevision: number,
  currentRevision: number,
): PaneLayoutRevisionConflictError {
  return new PaneLayoutRevisionConflictError({
    message: paneLayoutRevisionConflictMessage(expectedRevision, currentRevision),
  });
}
