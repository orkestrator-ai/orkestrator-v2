import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  dismissNodeOutcome,
  listNodeOutcomes,
  type NodeOutcomeRecord,
} from "@/lib/portal/portal-store";
import { portalListen } from "@/lib/portal/portal-transport";
import { NODE_SUMMARY_CHANGED_EVENT } from "@orkestrator/protocol/node-summaries";
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
    void listNodeOutcomes(connectionId)
      .then(setOutcomes)
      .catch(() => undefined);
  }, [connectionId]);

  useEffect(() => {
    if (outcomesRevision > 0) refresh();
  }, [outcomesRevision, refresh]);

  useEffect(() => {
    refresh();
    let stop: (() => void) | null = null;
    let active = true;
    void portalListen(NODE_SUMMARY_CHANGED_EVENT, refresh).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [refresh]);

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
