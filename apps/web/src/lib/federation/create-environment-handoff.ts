import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

/**
 * What became of a New Environment request when the user moved the dialog to another machine
 * (`openCreateEnvironmentOnMachine`):
 *
 * - `opened`: the node's own dialog is showing the carried form;
 * - `superseded`: the request was replaced or dropped before it opened,
 *   because the user navigated elsewhere (or switched again);
 * - `failed`: the node cannot show it (its workspace could not be opened, the
 *   project is not there, or nothing opened within the time limit).
 */
export type CreateEnvironmentRequestOutcome =
  { kind: "opened" } | { kind: "superseded" } | { kind: "failed"; reason: string };

/**
 * How long a node's workspace has to show the carried form. It covers
 * connecting to the node and loading its projects, settings and first Docker
 * probe, which the dialog waits for (`dialogHydrated`).
 */
export const CREATE_ENVIRONMENT_HANDOFF_TIMEOUT_MS = 30_000;

interface Watch {
  readonly nodeId: string;
  readonly seq: number;
  settle(outcome: CreateEnvironmentRequestOutcome): void;
  stop(): void;
}

const watches = new Set<Watch>();

/**
 * Watches request `seq` to `nodeId` (empty for the command node), then calls
 * `onSettled` once. Returns the stop, which ends the watch without calling it.
 */
export function watchCreateEnvironmentRequest(
  nodeId: string,
  seq: number,
  onSettled: (outcome: CreateEnvironmentRequestOutcome) => void,
  timeoutMs = CREATE_ENVIRONMENT_HANDOFF_TIMEOUT_MS,
): () => void {
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    unsubscribe();
    stopSelection?.();
    watches.delete(watch);
  };
  const watch: Watch = {
    nodeId,
    seq,
    stop,
    settle(outcome) {
      if (done) return;
      stop();
      onSettled(outcome);
    },
  };
  const timer = setTimeout(
    () =>
      watch.settle({
        kind: "failed",
        reason: "It did not show the form in time. It may be unreachable or still loading.",
      }),
    timeoutMs,
  );
  const supersede = () => watch.settle({ kind: "superseded" });
  const commandSequence = () => {
    const { request, requestSequence } = useAppDialogStore.getState();
    return request?.kind === "create-environment" ? requestSequence : undefined;
  };
  const remoteSequence = () => useRemoteWorkspaceStore.getState().requests[nodeId]?.seq;
  const currentSequence = nodeId ? remoteSequence : commandSequence;
  const onRequestChange = () => {
    if (currentSequence() !== seq) supersede();
  };
  const unsubscribe = nodeId
    ? useRemoteWorkspaceStore.subscribe(onRequestChange)
    : useAppDialogStore.subscribe(onRequestChange);
  const stopSelection = nodeId ? undefined : getWindowScope().selection.subscribe(supersede);
  watches.add(watch);
  onRequestChange();
  return stop;
}

function settleWatches(
  nodeId: string,
  seq: number | null,
  outcome: CreateEnvironmentRequestOutcome,
): void {
  for (const watch of Array.from(watches)) {
    if (watch.nodeId === nodeId && (seq === null || watch.seq === seq)) watch.settle(outcome);
  }
}

/** The node's own New Environment dialog is showing request `seq`. */
export function reportCreateEnvironmentOpened(nodeId: string, seq: number): void {
  settleWatches(nodeId, seq, { kind: "opened" });
}

/**
 * The node cannot show request `seq` (`null`: any request to it, as when its
 * workspace itself could not be opened). `reason` is shown to the user.
 */
export function reportCreateEnvironmentFailed(
  nodeId: string,
  seq: number | null,
  reason: string,
): void {
  settleWatches(nodeId, seq, { kind: "failed", reason });
}

/** Ends every watch without settling it. For tests' `afterEach`. */
export function stopCreateEnvironmentWatches(): void {
  for (const watch of Array.from(watches)) watch.stop();
}
