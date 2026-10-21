import { useSyncExternalStore } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { UnknownOutcome } from "@/lib/federation/operation-recovery";
import { useFederation } from "./FederationProvider";

const NO_OUTCOMES: UnknownOutcome[] = [];

/**
 * Writes whose outcome is unknown after a lost connection. They are shown
 * against their original machine and are never resent automatically; the
 * user checks that machine's state, then dismisses the notice.
 */
export function UnknownOutcomesNotice({ connectionId }: { connectionId: string }) {
  const { registry } = useFederation();
  const runtime = registry.get(connectionId);
  const outcomes = useSyncExternalStore(
    (onChange) => runtime?.recovery.store.subscribe(onChange) ?? (() => undefined),
    () => runtime?.recovery.store.getState().outcomes ?? NO_OUTCOMES,
  );
  if (!runtime || outcomes.length === 0) return null;
  return (
    <div
      role="status"
      className="mx-2 my-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200"
      data-testid="unknown-outcomes"
    >
      {outcomes.slice(0, 5).map((outcome) => (
        <div key={outcome.id} className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            Outcome unknown: <strong>{outcome.label}</strong>. Check this machine before trying
            again.
          </span>
          <button
            type="button"
            className="shrink-0 text-amber-200/70 hover:text-amber-100"
            aria-label={`Dismiss ${outcome.label}`}
            onClick={() => runtime.recovery.dismiss(outcome.id)}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
