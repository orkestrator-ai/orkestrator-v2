import { useEffect, useState } from "react";
import * as backend from "@/lib/backend";

export interface ThreadChangeResource {
  segmentId: string;
  resourceKey: string;
}

function isThreadChangeResource(value: unknown): value is ThreadChangeResource {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.segmentId === "string" &&
    typeof candidate.resourceKey === "string" &&
    candidate.resourceKey.length > 0
  );
}

/**
 * The backend's current thread segment resource for a logical session, or
 * `null` when no turn has opened a segment yet (or the backend has no change
 * tracking). Re-read whenever `turnActive` flips: dispatch can open a new
 * segment and the turn-end edge publishes the thread measurement.
 *
 * Read-only: nothing the backend tracks depends on this hook being mounted.
 */
export function useThreadChangeResource(
  environmentId: string | null | undefined,
  logicalSessionKey: string | null | undefined,
  turnActive: boolean,
): ThreadChangeResource | null {
  const owner =
    environmentId && logicalSessionKey ? `${environmentId}\0${logicalSessionKey}` : null;
  const [state, setState] = useState<{
    owner: string;
    resource: ThreadChangeResource | null;
  } | null>(null);

  useEffect(() => {
    if (!owner || !environmentId || !logicalSessionKey) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => backend.getChangeThread(environmentId, logicalSessionKey))
      .then(
        (result: unknown) => {
          if (cancelled) return;
          const next = isThreadChangeResource(result) ? result : null;
          setState((current) =>
            current?.owner === owner &&
            current.resource?.segmentId === next?.segmentId &&
            current.resource?.resourceKey === next?.resourceKey
              ? current
              : { owner, resource: next },
          );
        },
        () => {
          // An older backend without change tracking or a transient failure:
          // keep what was shown; the next turn edge asks again.
        },
      );
    return () => {
      cancelled = true;
    };
  }, [owner, environmentId, logicalSessionKey, turnActive]);

  // A previous session's answer never shows under a new owner.
  return state && state.owner === owner ? state.resource : null;
}
