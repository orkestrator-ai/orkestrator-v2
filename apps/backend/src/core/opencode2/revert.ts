/**
 * Undo and Redo on OpenCode 2.x: its staged revert (build plan phase 5).
 *
 * 2.x semantics, from `packages/core/src/session/revert.ts` and the projector
 * at v2.2.6, checked live on 2.2.6:
 *
 * - `POST /api/session/:id/revert/stage { messageID }` restores the files the
 *   assistant changed after that message and records `Session.revert =
 *   { messageID, snapshot?, files }`. Every row stays in the history.
 * - `DELETE /api/session/:id/revert` (clear) puts the files back and drops
 *   the marker: Redo.
 * - The next prompt (or an explicit commit) deletes every row from
 *   `messageID` on, the boundary row included, and then drops the marker.
 * - All three answer 409 `SessionBusyError` while a run is active.
 *
 * Orkestrator's Undo names a user row (the turn to take back), or none, which
 * means the newest user row still showing. Staging again further back keeps
 * the snapshot of the first stage, so a later Redo restores everything.
 * Redo clears the whole staged revert, as 1.x `unrevert` does.
 *
 * Until a prompt commits it, the transcript hides what the marker covers, the
 * way 1.x does (`opencode-revert.ts`): the boundary row and every row after
 * it. Nothing is deleted here, so Redo brings the rows back from the same
 * history.
 */
import { PromptRejectedError, ProviderUnavailableError } from "../agent-provider-contract.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import type { OpenCode2Message } from "./types.js";

export interface OpenCode2RevertMarker {
  messageId: string;
}

const MAX_ID_LENGTH = 256;

/** The staged revert on a 2.x `Session`, if any. */
export function openCode2RevertMarker(session: unknown): OpenCode2RevertMarker | undefined {
  const revert = (session as { revert?: { messageID?: unknown } } | undefined)?.revert;
  const messageId = revert?.messageID;
  return typeof messageId === "string" &&
    messageId.startsWith("msg_") &&
    messageId.length <= MAX_ID_LENGTH
    ? { messageId }
    : undefined;
}

/**
 * The rows a staged revert leaves showing, oldest first; the read itself
 * without a marker. The cut is by position, never by comparing ids: a forked
 * session's copied rows end in `_1`, `_2`, … `_10`, which do not sort.
 *
 * `complete` says the read holds the whole history. A newest-first window
 * that does not contain the boundary began after it, so everything in it is
 * covered; a complete history without it has nothing covered (the boundary
 * was committed away).
 */
export function withoutStagedOpenCode2Revert<T extends Pick<OpenCode2Message, "id">>(
  rows: readonly T[],
  marker: OpenCode2RevertMarker | undefined,
  options: { complete: boolean },
): readonly T[] {
  if (!marker) return rows;
  const cut = rows.findIndex((row) => row.id === marker.messageId);
  if (cut >= 0) return rows.slice(0, cut);
  return options.complete ? rows : [];
}

/** The newest user row still showing: what a bare Undo takes back. */
export function openCode2UndoTarget(
  rows: readonly OpenCode2Message[],
  marker: OpenCode2RevertMarker | undefined,
  options: { complete: boolean },
): string | undefined {
  const visible = withoutStagedOpenCode2Revert(rows, marker, options);
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const row = visible[index]!;
    if (row.type === "user" && typeof row.id === "string") return row.id;
  }
  return undefined;
}

function refusal(action: "Undo" | "Redo", error: unknown): Error {
  if (error instanceof OpenCode2RequestError) {
    if (error.status === 409) {
      return new PromptRejectedError(
        `${action} waits for the running turn; stop it or let it finish.`,
      );
    }
    if (error.status === 404) {
      return new PromptRejectedError(`${action}: OpenCode no longer has that message.`);
    }
    return new PromptRejectedError(`OpenCode refused ${action.toLowerCase()}: ${error.message}`);
  }
  return new ProviderUnavailableError(`OpenCode 2.x ${action.toLowerCase()} failed`, {
    cause: error,
  });
}

export async function stageOpenCode2Revert(
  client: Pick<OpenCode2Client, "api">,
  sessionId: string,
  messageId: string,
): Promise<OpenCode2RevertMarker> {
  if (!messageId.startsWith("msg_") || messageId.length > MAX_ID_LENGTH) {
    throw new PromptRejectedError("Undo needs an OpenCode 2 message to take back");
  }
  try {
    const revert = await client.api<unknown>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/revert/stage`,
      "OpenCode revert",
      { body: { messageID: messageId } },
    );
    return openCode2RevertMarker({ revert }) ?? { messageId };
  } catch (error) {
    throw refusal("Undo", error);
  }
}

export async function clearOpenCode2Revert(
  client: Pick<OpenCode2Client, "api">,
  sessionId: string,
): Promise<void> {
  try {
    await client.api(
      "DELETE",
      `/api/session/${encodeURIComponent(sessionId)}/revert`,
      "OpenCode revert clear",
      {},
    );
  } catch (error) {
    throw refusal("Redo", error);
  }
}
