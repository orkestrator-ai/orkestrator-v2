import { isWorkspaceRealm, postToShell } from "@/lib/federation/workspace-realm";
import { portalStore } from "@/lib/portal/portal-store";
import { workspaceTarget } from "@/lib/portal/portal-transport";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

/**
 * The machine a report runs on, by node id. `null` is this view's own
 * backend: the command node in the window, or the realm's node in a realm.
 */
export type BugReportMachineId = string | null;

/** The node this renderer's own backend is, when it knows. */
export function ownBugReportMachineId(): string | null {
  return isWorkspaceRealm()
    ? (workspaceTarget()?.nodeId ?? null)
    : (portalStore.getState().selfId ?? null);
}

/**
 * The machine a report should default to: the one whose workspace is in
 * front. In the window that is the realm on show, if any; in a realm, the
 * realm's own node.
 */
export function currentBugReportMachine(): BugReportMachineId {
  if (isWorkspaceRealm()) return null;
  return useRemoteWorkspaceStore.getState().active?.nodeId ?? null;
}

/**
 * Open the Report a bug sheet for `nodeId`.
 *
 * A report's agent session talks to the backend of the renderer that shows
 * it, so another machine's report is shown by that machine's realm: the
 * window opens (or brings forward) the realm and asks it to open its sheet.
 * A realm asked for any machine but its own hands the request to its window.
 * `undefined` means the machine in front.
 */
export function openBugReport(nodeId?: BugReportMachineId): void {
  const target = nodeId === undefined ? currentBugReportMachine() : nodeId;
  const own = ownBugReportMachineId();
  if (target === null || target === own) {
    useBugReportStore.getState().openSheet();
    return;
  }
  if (isWorkspaceRealm()) {
    useBugReportStore.getState().closeSheet();
    // The window's own machine is `null` to the window.
    postToShell({
      type: "bugReport",
      nodeId: target === portalStore.getState().selfId ? null : target,
    });
    return;
  }
  useBugReportStore.getState().closeSheet();
  const remote = useRemoteWorkspaceStore.getState();
  const active = remote.active?.nodeId === target ? remote.active : null;
  remote.open(target, {
    ...(active?.projectId ? { projectId: active.projectId } : {}),
    ...(active?.projectId && active.environmentId ? { environmentId: active.environmentId } : {}),
    bugReport: true,
  });
}
