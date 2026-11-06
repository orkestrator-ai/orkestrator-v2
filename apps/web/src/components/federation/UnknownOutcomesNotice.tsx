import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  dismissNodeOutcome,
  nodeOutcomesStore,
  type NodeOutcomeRecord,
} from "@/lib/portal/portal-store";
import { useFederation } from "./FederationProvider";

type NodeOutcome = NodeOutcomeRecord;

const COMMAND_LABELS: Record<string, string> = {
  start_environment_background: "Start environment",
  stop_environment: "Stop environment",
  delete_environment: "Delete environment",
  create_environment: "Create environment",
  reorder_environments: "Reorder environments",
  update_backend_profile: "Update machine profile",
};

/**
 * Writes whose outcome is unknown after a lost connection, as recorded by
 * the command node against their original node. They are never resent
 * automatically; the user checks that node's state, then dismisses them.
 */
export function UnknownOutcomesNotice({ connectionId }: { connectionId: string }) {
  const [outcomes, setOutcomes] = useState<NodeOutcome[]>([]);
  const outcomesRevision = useFederation().portalState.outcomesRevision;
  const refresh = useCallback(() => {
    void nodeOutcomesStore.refresh(connectionId);
  }, [connectionId]);

  useEffect(() => {
    if (outcomesRevision > 0) refresh();
  }, [outcomesRevision, refresh]);

  // One shared subscription per window: it re-reads this machine's records only
  // when a change names it, however many notices are mounted.
  useEffect(() => nodeOutcomesStore.subscribe(connectionId, setOutcomes), [connectionId]);

  if (outcomes.length === 0) return null;
  return (
    <div
      role="status"
      className="mx-2 my-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200"
      data-testid="unknown-outcomes"
    >
      {outcomes.slice(0, 5).map((outcome) => {
        const label = COMMAND_LABELS[outcome.command] ?? outcome.command;
        return (
          <div key={outcome.outcomeId} className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              Outcome unknown: <strong>{label}</strong>. Check this machine before trying again.
            </span>
            <button
              type="button"
              className="shrink-0 text-amber-200/70 hover:text-amber-100"
              aria-label={`Dismiss ${label}`}
              onClick={() => void dismissNodeOutcome(outcome.outcomeId).then(refresh)}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
