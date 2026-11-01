import { useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFederation } from "@/components/federation/FederationProvider";
import * as backend from "@/lib/backend";
import type { EnvironmentSetupApproval } from "@/lib/backend";
import {
  approveSetupCommandsOnNodes,
  type SetupApprovalNodeResult,
} from "@/lib/portal/setup-approvals";
import { approveSetupRuntime, forceResolveSetupRuntime } from "@/lib/setup-commands";

type Operation = "once" | "project" | "everywhere" | "skip";

const NODE_STATUS_TEXT: Record<SetupApprovalNodeResult["status"], string> = {
  approved: "approved",
  "no-project": "does not have this project",
  "not-connected": "not connected; approve it there later",
  "outcome-unknown": "connection lost; check that machine",
  "needs-update": "runs an older Orkestrator; update it",
  failed: "failed",
};

function CommandList({ commands }: { commands: readonly string[] }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-left font-mono text-xs whitespace-pre-wrap break-all text-foreground">
      {commands.join("\n")}
    </pre>
  );
}

/**
 * The held-setup panel: a local environment's setup commands differ from the
 * default branch's and from every list approved for the project on this
 * machine, so they did not run. The user reads them and runs them once,
 * approves them for the project here or on every machine, or skips setup.
 */
export function SetupApprovalPanel({ environmentId }: { environmentId: string }) {
  const federation = useFederation();
  const [approval, setApproval] = useState<EnvironmentSetupApproval | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [nodeResults, setNodeResults] = useState<SetupApprovalNodeResult[] | null>(null);

  useEffect(() => {
    // The parent keys this panel by environment, so state starts empty.
    let active = true;
    backend.getEnvironmentSetupApproval(environmentId).then(
      (value) => {
        if (active) setApproval(value);
      },
      (reason: unknown) => {
        if (active) {
          setLoadError(reason instanceof Error ? reason.message : "Could not read setup commands");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId]);

  const run = async (kind: Operation) => {
    setError(null);
    setOperation(kind);
    try {
      if (kind === "skip") {
        await forceResolveSetupRuntime(environmentId);
        return;
      }
      if (!approval) return;
      if (kind === "everywhere") {
        const nodeId = federation.bound?.backendId;
        if (!nodeId) throw new Error("This window is not connected to a command node.");
        const result = await approveSetupCommandsOnNodes(nodeId, approval.projectId, approval.hash);
        setNodeResults(result.nodes);
        return;
      }
      await approveSetupRuntime(environmentId, approval.hash, kind !== "once");
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "Setup approval failed");
      // Never retry a rejected hash automatically. Show the current commands
      // and require another explicit decision, even if the failure was transient.
      if (kind !== "skip") {
        setApproval(null);
        setNodeResults(null);
        try {
          setApproval(await backend.getEnvironmentSetupApproval(environmentId));
        } catch (reason) {
          setLoadError(reason instanceof Error ? reason.message : "Could not read setup commands");
        }
      }
    } finally {
      setOperation(null);
    }
  };

  const busy = operation !== null;
  const spinner = (kind: Operation) =>
    operation === kind ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null;

  return (
    <div
      data-testid="setup-approval-panel"
      className="flex w-full max-w-xl flex-col items-center gap-3 text-muted-foreground"
    >
      <ShieldAlert className="h-8 w-8 text-yellow-500" />
      <p className="text-sm text-foreground">Setup needs your approval</p>
      <p className="max-w-md text-center text-xs">
        This branch changes the setup commands, and they run in your shell on this machine. Review
        them before they run.
      </p>
      {loadError ? (
        <p role="alert" className="max-w-sm text-center text-xs text-destructive">
          {loadError}
        </p>
      ) : !approval ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <div className="flex w-full flex-col gap-2">
          <p className="text-xs">This branch runs:</p>
          <CommandList commands={approval.commands} />
          <p className="text-xs">
            {approval.defaultBranchCommands === null
              ? `The ${approval.defaultBranch} branch could not be read to compare.`
              : approval.defaultBranchCommands.length === 0
                ? `The ${approval.defaultBranch} branch runs no setup commands.`
                : `The ${approval.defaultBranch} branch runs:`}
          </p>
          {approval.defaultBranchCommands?.length ? (
            <CommandList commands={approval.defaultBranchCommands} />
          ) : null}
        </div>
      )}
      {approval && !confirmingSkip ? (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={busy}
            onClick={() => void run("once")}
          >
            {spinner("once")}
            Run once
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={busy}
            onClick={() => void run("project")}
          >
            {spinner("project")}
            Approve for this project
          </Button>
          {federation.enabled ? (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={busy}
              onClick={() => void run("everywhere")}
            >
              {spinner("everywhere")}
              Approve on every machine
            </Button>
          ) : null}
        </div>
      ) : null}
      {confirmingSkip ? (
        <div className="mt-1 flex flex-col items-center gap-2">
          <p className="max-w-xs text-center text-xs">
            The environment stays without setup. Agents start in it as it is.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={busy}
              onClick={() => setConfirmingSkip(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs"
              disabled={busy}
              onClick={() => void run("skip")}
            >
              {spinner("skip")}
              Skip setup
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          disabled={busy}
          onClick={() => setConfirmingSkip(true)}
        >
          Skip setup
        </Button>
      )}
      {nodeResults ? (
        <p className="max-w-md text-center text-xs">
          Review the results below. Machines still needing approval must be handled there. Choose
          Run once or Approve for this project to start setup here.
        </p>
      ) : null}
      {nodeResults ? (
        <ul aria-label="Approval on each machine" className="text-xs">
          {nodeResults.map((result) => (
            <li key={result.nodeId}>
              {result.nodeName}: {NODE_STATUS_TEXT[result.status]}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="max-w-sm text-center text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
