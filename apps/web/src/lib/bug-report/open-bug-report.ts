import { portalStore } from "@/lib/portal/portal-store";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

/**
 * The machine a report runs on, by node id. `null` is the window's own
 * backend, its command node.
 */
export type BugReportMachineId = string | null;

/** The node this window's own backend is, when it knows. */
export function ownBugReportMachineId(): string | null {
  return portalStore.getState().selfId ?? null;
}

/**
 * The machine a report should default to: the one whose workspace is in
 * front, another node's if the central region shows one.
 */
export function currentBugReportMachine(): BugReportMachineId {
  return useRemoteWorkspaceStore.getState().active?.nodeId ?? null;
}

/**
 * Open the Report a bug sheet for `nodeId`.
 *
 * A report's agent session talks to the backend of the node it reports on.
 * Another node is shown in the window's own tree (plan item 5003), so the
 * window shows that node and opens the sheet on its scope
 * (`BugReportSheetHost`): the report is created, captured and filed through
 * the node's own client. `undefined` means the machine in front.
 */
export function openBugReport(nodeId?: BugReportMachineId): void {
  const target = nodeId === undefined ? currentBugReportMachine() : nodeId;
  const own = ownBugReportMachineId();
  if (target === null || target === own) {
    useBugReportStore.getState().openSheet();
    return;
  }
  const remote = useRemoteWorkspaceStore.getState();
  // Not in front yet: show it, on its launcher.
  if (remote.active?.nodeId !== target) remote.open(target, {});
  useBugReportStore.getState().openSheet(target);
}
