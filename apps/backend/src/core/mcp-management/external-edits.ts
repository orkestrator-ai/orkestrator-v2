/**
 * What a saved change's source file looks like now, and what that means for
 * applying it.
 *
 * Saving refuses a file that changed since the editor read it. After the save,
 * anything may still edit the file: the user by hand, a provider CLI, Claude's
 * own bookkeeping in `~/.claude.json`, or a later save here. Apply never
 * rewrites the file, so it cannot re-materialize an old revision; the risk is
 * reporting progress on a change the file no longer holds. The rule:
 *
 * - **Unchanged**: the server list is what the save left. Nothing to say.
 * - **Merged**: the server list changed, but this change is still in it.
 *   Applying continues and sessions load the file as it is now; the operation
 *   says the file also changed outside Orkestrator. A later save here is its
 *   own operation, so it is not flagged.
 * - **Superseded**: the change is no longer in the file. Runtimes still
 *   waiting for it are cancelled with the reason, and applying it again is
 *   refused: there is nothing left to apply.
 *
 * Bookkeeping that never touches the server list (Claude's `numStartups`) is
 * not a change: the comparison is over the parsed server map, not the bytes.
 */

import type {
  McpApplyCancelReason,
  McpApplyState,
  McpOperationSnapshot,
} from "@orkestrator/protocol/mcp-management";

import type { CurrentSourceState } from "./evidence.js";
import type { StoredOperation } from "./operations-store.js";

/**
 * States in which a planned change has not taken effect yet and still could.
 * A superseded change retires exactly these.
 */
export const STILL_TO_TAKE_EFFECT: ReadonlySet<McpApplyState> = new Set<McpApplyState>([
  "queued",
  "pending-next-turn",
  "pending-reattach",
  "restart-required",
]);

export const CHANGED_OUTSIDE_REASON =
  "The file was changed outside Orkestrator after this save and no longer contains this change, so there is nothing left to apply.";
export const REPLACED_BY_SAVE_REASON =
  "A later change saved here replaced this one, so there is nothing left to apply.";
export const MERGED_NOTE =
  "The server list in this file was also changed outside Orkestrator after this save. This change is still in it, and sessions load the file as it is now, outside changes included.";

/** A change the file no longer holds: why, for people and for the UI. */
export interface Supersession {
  reason: string;
  cancelReason: McpApplyCancelReason;
}

export type SourceDrift =
  | { kind: "unchanged" }
  | { kind: "merged"; note: string }
  | ({ kind: "superseded" } & Supersession);

/** Apply the rule above. An unreadable or unknown source says nothing. */
export function sourceDrift(
  stored: StoredOperation,
  current: CurrentSourceState | undefined,
): SourceDrift {
  if (!current) return { kind: "unchanged" };
  if (!current.landed) {
    return current.replacedBySave
      ? { kind: "superseded", reason: REPLACED_BY_SAVE_REASON, cancelReason: "superseded-local" }
      : {
          kind: "superseded",
          reason: CHANGED_OUTSIDE_REASON,
          cancelReason: "superseded-external",
        };
  }
  const saved = stored.recovery.savedEntriesDigest;
  if (
    saved &&
    current.entriesDigest &&
    current.entriesDigest !== saved &&
    !current.replacedBySave
  ) {
    return { kind: "merged", note: MERGED_NOTE };
  }
  return { kind: "unchanged" };
}

/**
 * Retire every runtime still waiting for a superseded change. Returns whether
 * anything changed. Applied runtimes keep their state: they did load it. The
 * `cancelReason` tells the UI a retry would only be refused.
 */
export function retireSuperseded(
  runtimes: McpOperationSnapshot["apply"]["runtimes"],
  superseded: Supersession,
  now: string,
): boolean {
  let changed = false;
  for (const runtime of runtimes) {
    if (!STILL_TO_TAKE_EFFECT.has(runtime.state)) continue;
    runtime.state = "cancelled";
    runtime.reason = superseded.reason;
    runtime.cancelReason = superseded.cancelReason;
    runtime.updatedAt = now;
    changed = true;
  }
  return changed;
}

/** Add `note` to the operation's message once. Returns whether it was added. */
export function noteOnce(snapshot: McpOperationSnapshot, note: string): boolean {
  if (snapshot.message?.includes(note)) return false;
  snapshot.message = snapshot.message ? `${snapshot.message} ${note}` : note;
  return true;
}
