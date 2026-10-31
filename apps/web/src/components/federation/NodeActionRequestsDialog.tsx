import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  listNodeActionRequests,
  resolveNodeActionRequest,
  type NodeActionRequestView,
} from "@/lib/portal/portal-store";
import { portalListenAuthoritative } from "@/lib/portal/portal-transport";
import { useProjectCopyStore } from "@/stores/projectCopyStore";
import { useFederation } from "./FederationProvider";
import { RootChangesApprovalDialog } from "./RootChangesApprovalDialog";
import { AgentsMdApprovalDialog } from "./AgentsMdApprovalDialog";

export const NODE_ACTION_REQUESTS_CHANGED_EVENT = "node-action-requests-changed";

function targetLabel(request: NodeActionRequestView): string {
  return request.targets
    .map((target) =>
      request.kind === "delete-environment"
        ? `“${target.environmentName ?? target.environmentId}” on ${target.nodeName}`
        : request.kind === "create-project"
          ? `${target.projectName ?? target.gitRemote ?? "a project"} to ${target.nodeName}${target.location ? ` at ${target.location}` : ""}`
          : request.kind === "apply-root-changes"
            ? `uncommitted changes to “${target.environmentName ?? target.environmentId}”`
            : request.kind === "update-agents-md"
              ? `the ## Orkestrator section of AGENTS.md on ${target.nodeName}`
              : request.kind === "switch-agent-account"
                ? `the active ${target.platform === "codex" ? "Codex" : "Claude"} account on ${target.nodeName} to “${target.accountLabel ?? target.accountId}”`
                : `${(target.files ?? []).join(", ")}${target.keys?.length ? ` (${target.keys.join(", ")})` : ""} on ${target.nodeName}`,
    )
    .join(", ");
}

const TITLES: Record<NodeActionRequestView["kind"], string> = {
  "delete-environment": "Delete",
  "create-project": "Copy",
  "update-project-files": "Update project files",
  "reveal-env-value": "Show a value in plain text",
  "apply-root-changes": "Apply",
  "update-agents-md": "Update",
  "switch-agent-account": "Switch",
};

/**
 * A coordinator asked for something only the user may do (delete an
 * environment, create a project on a node, push project files, show a
 * secret value, copy the checkout's uncommitted changes into a worker, save
 * decisions to the project's AGENTS.md through a pull request, switch the
 * active provider account on a machine).
 * Nothing happens until the user approves here; the dialog names every node
 * and environment involved.
 */
export function NodeActionRequestsDialog() {
  const { kind, portalState } = useFederation();
  const copyRequest = useProjectCopyStore((state) => state.request);
  const openCopy = useProjectCopyStore((state) => state.open);
  const [pending, setPending] = useState<NodeActionRequestView[]>([]);
  const [busy, setBusy] = useState(false);

  const revision = useRef(0);
  const refresh = useCallback(() => {
    const request = ++revision.current;
    void listNodeActionRequests()
      .then((value) => {
        if (revision.current === request) setPending(value);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (kind === "none") return;
    let stop: (() => void) | null = null;
    let active = true;
    void portalListenAuthoritative(NODE_ACTION_REQUESTS_CHANGED_EVENT, refresh, {
      onResync: refresh,
      resyncOnSubscribe: true,
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [kind, refresh]);

  const request = pending[0];
  if (!request) return null;
  // A copy request is reviewed in the copy dialog, where the user settles
  // the location and files before approving.
  if (copyRequest?.actionRequestId === request.requestId) return null;
  // The user picks which changed files go to the worker in their own dialog.
  if (request.kind === "apply-root-changes")
    return (
      <RootChangesApprovalDialog key={request.requestId} request={request} onSettled={refresh} />
    );
  // The user reviews the section diff and may edit the entries in their own dialog.
  if (request.kind === "update-agents-md")
    return <AgentsMdApprovalDialog key={request.requestId} request={request} onSettled={refresh} />;
  const label = targetLabel(request);
  const reviewCopy =
    request.kind === "create-project" && request.requestedBy && portalState.selfId
      ? () =>
          openCopy({
            source: { nodeId: portalState.selfId!, projectId: request.requestedBy!.projectId },
            targetNodeId: request.targets[0]?.nodeId,
            ...(request.targets[0]?.location ? { location: request.targets[0].location } : {}),
            paths: request.targets[0]?.files ?? [],
            actionRequestId: request.requestId,
            ...(request.reason ? { reason: request.reason } : {}),
          })
      : null;

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const resolved = await resolveNodeActionRequest(request.requestId, decision);
      if (decision === "approve") {
        if (resolved.state === "executed") toast.success(resolved.result?.message ?? "Done.");
        else
          toast.warning(`${TITLES[request.kind]}: ${resolved.state}`, {
            description: resolved.result?.message,
          });
      }
    } catch (error) {
      toast.error("Could not resolve the request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <AlertDialog open>
      <AlertDialogContent data-testid="node-action-request">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {TITLES[request.kind]} {label}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The project coordinator asked for this. Nothing happens unless you approve it.
            {request.reason ? ` Its reason: “${request.reason}”` : ""}
            {request.kind === "delete-environment"
              ? " Deleting removes the environment, its container, storage and recovery copies on that node. It cannot be undone."
              : request.kind === "switch-agent-account"
                ? " New turns of every session of that provider on that machine run on, and are billed to, this account; a turn already running finishes on the current one. You can switch back in Settings."
                : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={() => void decide("reject")}>
            Reject
          </AlertDialogCancel>
          {reviewCopy ? (
            <Button type="button" disabled={busy} onClick={reviewCopy}>
              Review and copy…
            </Button>
          ) : (
            <Button
              type="button"
              variant={request.kind === "delete-environment" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void decide("approve")}
            >
              {request.kind === "delete-environment"
                ? `Delete on ${request.targets.map((target) => target.nodeName).join(", ")}`
                : "Approve"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
