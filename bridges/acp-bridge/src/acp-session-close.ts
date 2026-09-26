import type { AcpProcess, SessionState } from "./acp-context.js";
import {
  CLOSE_ATTACH_WAIT_MS,
  CLOSE_CANCEL_WAIT_MS,
  bumpCursorDiscoveryRevision,
  clientSessionKeys,
  sessions,
} from "./acp-context.js";
import { cancelCursorToolMetadataReconcile } from "./acp-tools.js";
import { persistState, schedulePersist } from "./acp-persist-writer.js";

export type RetainingCloseOutcome = "closed" | "pending";

/**
 * One close per bridge session id. Keyed by id rather than by state object so
 * a retry that arrives while the first close is still waiting joins it instead
 * of starting a second teardown of the same session.
 */
const closesInFlight = new Map<string, Promise<RetainingCloseOutcome>>();

function exited(process: AcpProcess): boolean {
  return process.child.exitCode !== null || process.child.signalCode !== null;
}

/** Wait for `promise` for at most `timeoutMs`; `"timeout"` when it did not settle. */
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Answer every request the agent parked on a person with its deny/cancel
 * outcome: permissions `{ outcome: { outcome: "cancelled" } }`, Grok questions
 * and plan approvals `{ outcome: "cancelled" }` (the same answer their expiry
 * timer gives). Synchronous, so nothing can answer them after the tab is gone.
 */
export function denyPendingRequests(state: SessionState): void {
  for (const approval of Array.from(state.approvals.values())) approval.respond();
  for (const interaction of Array.from(state.interactions.values())) {
    interaction.respond({ outcome: "cancelled" });
  }
}

/**
 * Ordinary tab close for one ACP bridge session (`POST /session/:id/close`).
 *
 * The same release as DELETE — deny parked requests, stop the agent child,
 * drop the registry entry, publish the state file — and, like DELETE, no vendor
 * call deletes anything: ACP has no session delete here, and Grok's own session
 * store is only ever read. `session/load` can reopen the conversation
 * afterwards through `/session/list`.
 *
 * Ordering, all of it while the session stays registered as `closing`:
 * 1. Fence admission and deny every parked permission, question and plan
 *    approval before anything yields.
 * 2. Send `session/cancel` to a running turn.
 * 3. Await an in-flight attach (bounded by `ACP_CLOSE_ATTACH_WAIT_MS`), so its
 *    late child is terminated too rather than outliving the close.
 * 4. Await the running `session/prompt` answering the cancel (bounded by
 *    `ACP_CLOSE_CANCEL_WAIT_MS`), so the vendor can finish writing the turn.
 * 5. Terminate every child and require each to have exited.
 * 6. Write the state file without this session, and only then drop the
 *    registry entry and client-key alias.
 *
 * Any step that is not proven (attach still running, a child that did not
 * exit, a failed write) answers `pending`: the entry stays registered and
 * fenced, so the backend's retry reaches the same session — never a false
 * `missing` — and nothing new can start on it in the meantime.
 */
export function closeSessionRetaining(state: SessionState): Promise<RetainingCloseOutcome> {
  const existing = closesInFlight.get(state.id);
  if (existing) return existing;
  const operation: Promise<RetainingCloseOutcome> = runClose(state).finally(() => {
    if (closesInFlight.get(state.id) === operation) closesInFlight.delete(state.id);
  });
  closesInFlight.set(state.id, operation);
  return operation;
}

async function runClose(state: SessionState): Promise<RetainingCloseOutcome> {
  // Fail closed: once a close has started, a pending outcome keeps the fence.
  // The backend holds a close intent for this tab and retries it; reopening
  // admission in between would let work start on a session that is leaving.
  state.closing = "fenced";
  denyPendingRequests(state);
  cancelCursorToolMetadataReconcile(state);
  if (state.status === "running" || state.dispatching) {
    // Same retry suppression as `/cancel`: a retriable provider error must not
    // restart the turn this close just stopped.
    state.retryCancelledPromptSequence = state.dispatching
      ? state.promptSequence + 1
      : state.promptSequence;
    state.child?.notify("session/cancel", { sessionId: state.acpSessionId });
  }

  const children = new Set<AcpProcess>();
  if (state.attaching) {
    const late = await within(
      state.attaching.then(
        (child) => child,
        () => null,
      ),
      CLOSE_ATTACH_WAIT_MS,
    );
    if (late === "timeout") return "pending";
    if (late) children.add(late);
  }

  // `session/cancel` is a notification; its acknowledgement is the running
  // `session/prompt` answering (normally `stopReason: "cancelled"`).
  const settlement = state.status === "running" ? state.turnSettlement : undefined;
  if (settlement) await within(settlement, CLOSE_CANCEL_WAIT_MS);

  if (state.child) children.add(state.child);
  for (const child of children) await child.close();
  if (Array.from(children).some((child) => !exited(child))) return "pending";

  state.closing = "committing";
  try {
    await persistState();
  } catch {
    state.closing = "fenced";
    // Put the session back into the file on the next write that works.
    schedulePersist();
    return "pending";
  }
  // No await between the landed write and the removal: until here every
  // lookup still finds the session (closing), and from here on it is gone
  // from the registry and the file alike.
  if (sessions.get(state.id) === state) {
    sessions.delete(state.id);
    bumpCursorDiscoveryRevision();
  }
  const clientKey = state.clientSessionKey;
  if (clientKey !== undefined && clientSessionKeys.get(clientKey) === state.id) {
    clientSessionKeys.delete(clientKey);
  }
  return "closed";
}
