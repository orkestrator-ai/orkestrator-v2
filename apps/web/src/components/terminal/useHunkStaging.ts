import { useCallback, useRef, useState } from "react";
import type { ChangesStageHunkRequest } from "@orkestrator/protocol/change-resources";
import { backendForScope } from "@/lib/backend/scope-backend";
import { changeReason } from "@/lib/changes/labels";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { StagingFeedback } from "./DiffNavigationBar";

/**
 * Staging one hunk from the diff tab. The backend does the work and the
 * checks (`changes_stage_hunk`): this hook sends the reviewed identity and
 * hunk, reports the outcome, and asks the tab to resolve a fresh diff after a
 * success. A refusal leaves the shown diff as it is and says why.
 */

/** Refusals that mean the reviewed diff is out of date. */
const STALE_CODES = new Set(["stale-revision", "precondition-failed", "owner-replaced"]);

export function hunkStagingKey(identityId: string, hunkIndex: number): string {
  return `${identityId}\0${hunkIndex}`;
}

export function useHunkStaging(scope: NodeScope, onApplied: () => void) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<StagingFeedback | null>(null);
  const inFlight = useRef(false);

  const stage = useCallback(
    async (request: ChangesStageHunkRequest, label: string, note = "") => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPendingKey(hunkStagingKey(request.diffIdentityId, request.hunk.index));
      setFeedback(null);
      const verb = request.action === "stage" ? "Staged" : "Unstaged";
      try {
        const result = await backendForScope(scope).stageChangeHunk(request);
        if (result.kind === "applied") {
          setFeedback({ kind: "applied", text: `${verb} ${label}.${note}`, stale: false });
          onApplied();
        } else {
          setFeedback({
            kind: "refused",
            text: `Not ${request.action}d: ${changeReason(result.error.reasonKey)}`,
            stale: STALE_CODES.has(result.error.code),
          });
        }
      } catch (error) {
        setFeedback({
          kind: "failed",
          text: `Could not ${request.action} ${label}: ${error instanceof Error ? error.message : String(error)}`,
          stale: false,
        });
      } finally {
        inFlight.current = false;
        setPendingKey(null);
      }
    },
    [onApplied, scope],
  );

  const dismiss = useCallback(() => setFeedback(null), []);

  return { pendingKey, feedback, stage, dismiss };
}
