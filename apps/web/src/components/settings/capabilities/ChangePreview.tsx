import { useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

import type { CapabilityOperationSnapshot } from "@orkestrator/protocol/capability-resources";

import { Button } from "@/components/ui/button";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import {
  describeError,
  liveSemanticsLabel,
  newRequestKey,
  providerLabel,
  shortDigest,
  StatusBadge,
} from "./capability-format";

const ACTION_LABEL: Record<string, string> = {
  install: "Install",
  update: "Update",
  remove: "Remove",
  keep: "Keep",
  skip: "Not delivered",
};

/**
 * The plan for one change, target by target: what each machine and agent
 * gets, what is not delivered and why, and what it means for a running
 * session. Approve records the user's approval for exactly this plan's digest.
 */
export function ChangePreview({
  operation,
  machineNames,
  componentNames,
  onApplied,
  onCancel,
}: {
  operation: CapabilityOperationSnapshot;
  machineNames: Record<string, string>;
  componentNames: Record<string, string>;
  onApplied: (operation: CapabilityOperationSnapshot) => void;
  onCancel: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(!operation.requiresApproval);
  const [requestKey] = useState(newRequestKey);
  const writes = operation.targets.filter(
    (target) => target.action !== "skip" && target.action !== "keep",
  );
  const skipped = operation.targets.filter((target) => target.action === "skip");
  const counts = useMemo(() => {
    const byAction: Record<string, number> = {};
    for (const target of operation.targets)
      byAction[target.action] = (byAction[target.action] ?? 0) + 1;
    return byAction;
  }, [operation.targets]);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const result = await capabilitiesApi.applyCapabilityChange(
        operation.id,
        operation.planDigest,
        requestKey,
      );
      onApplied(result.operation);
    } catch (applyError) {
      setError(describeError(applyError));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="min-w-0 space-y-4" data-testid="capability-change-preview">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {Object.entries(counts).map(([action, count]) => (
          <span key={action}>
            {ACTION_LABEL[action] ?? action}: <strong className="text-foreground">{count}</strong>
          </span>
        ))}
      </div>
      {operation.approvalReasons.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-200">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" /> Review before approving
          </div>
          <ul className="list-disc space-y-1 pl-5">
            {operation.approvalReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <label className="mt-2 flex items-center gap-2 text-amber-100">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              aria-label="I reviewed what this package runs"
            />
            I reviewed what this package runs and connects to.
          </label>
        </div>
      ) : null}
      <div className="max-h-72 overflow-auto rounded-md border border-zinc-800">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-zinc-950 text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">Machine</th>
              <th className="px-2 py-1.5 font-medium">Agent</th>
              <th className="px-2 py-1.5 font-medium">Component</th>
              <th className="px-2 py-1.5 font-medium">Change</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900">
            {[...writes, ...skipped].map((target) => (
              <tr key={target.key} className="align-top">
                <td className="px-2 py-1.5">
                  {machineNames[target.target.nodeId] ?? target.target.nodeId}
                </td>
                <td className="px-2 py-1.5">
                  {providerLabel(target.target.provider)}
                  {target.alsoVisibleTo?.length ? (
                    <div className="text-[11px] text-muted-foreground">
                      Also visible to {target.alsoVisibleTo.map(providerLabel).join(", ")}
                    </div>
                  ) : null}
                </td>
                <td className="px-2 py-1.5">
                  {componentNames[target.componentId] ?? target.componentId.split(":").pop()}
                </td>
                <td className="px-2 py-1.5">
                  {ACTION_LABEL[target.action] ?? target.action}
                  {target.toDigest ? (
                    <span className="ml-1 text-muted-foreground">
                      {shortDigest(target.toDigest)}
                    </span>
                  ) : null}
                  {liveSemanticsLabel(target.liveSemantics) && target.action !== "skip" ? (
                    <div className="text-[11px] text-muted-foreground">
                      {liveSemanticsLabel(target.liveSemantics)}
                    </div>
                  ) : null}
                  {target.sharedWith ? (
                    <div className="text-[11px] text-muted-foreground">
                      Shared with {target.sharedWith} other setup(s)
                    </div>
                  ) : null}
                </td>
                <td className="px-2 py-1.5">
                  <StatusBadge status={target.status} title={target.reason} />
                  {target.reason ? (
                    <div className="mt-1 max-w-xs text-[11px] text-muted-foreground">
                      {target.reason}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
            {operation.targets.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-3 text-muted-foreground">
                  Nothing changes on any machine.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={applying}>
          Back
        </Button>
        <Button
          size="sm"
          onClick={() => void apply()}
          disabled={applying || !acknowledged}
          data-testid="capability-approve"
        >
          {applying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {operation.requiresApproval ? "Approve and apply" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
