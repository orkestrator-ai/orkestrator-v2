import { useCallback, useEffect, useState } from "react";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  classifyLaunchBaseTip,
  type LaunchBaseState,
  type ProjectBaseBranchTip,
} from "@/lib/launch-base";

const log = createLogger("web.environment");

export type LoadLaunchBaseTip = (projectId: string) => Promise<ProjectBaseBranchTip>;

/**
 * Refreshes and resolves the base a new local environment starts from while
 * the creation dialog is open (`lib/launch-base.ts`).
 *
 * Every time `enabled` turns on (the dialog opens, or Local is chosen) the
 * base is read again, so a dialog left closed for an hour never offers the
 * commit it showed last time. `refresh` reads it again on request. A read the
 * dialog no longer wants (closed, another project, superseded) is ignored.
 */
export function useLaunchBase({
  enabled,
  projectId,
  load,
}: {
  enabled: boolean;
  projectId: string | null;
  load: LoadLaunchBaseTip;
}): { state: LaunchBaseState; refresh: () => void } {
  const [generation, setGeneration] = useState(0);
  const [wasEnabled, setWasEnabled] = useState(enabled);
  // Adjusting state while rendering, React's pattern for a prop change: each
  // time the base becomes wanted again it is a new read, never a cached one.
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled);
    if (enabled) setGeneration((value) => value + 1);
  }
  const [result, setResult] = useState<{ key: string; state: LaunchBaseState } | null>(null);
  const key = enabled && projectId ? `${projectId}\u0000${generation}` : null;

  useEffect(() => {
    if (!key || !projectId) return;
    let current = true;
    // A load that throws synchronously (an older node's backend without the
    // read) is an unavailable base like any rejected one.
    Promise.resolve()
      .then(() => load(projectId))
      .then(
        (tip) => {
          if (current) setResult({ key, state: classifyLaunchBaseTip(tip) });
        },
        (error: unknown) => {
          log.warn("launch-base.unavailable", { error: formatLogError(error) });
          if (current) {
            setResult({
              key,
              state: {
                status: "unavailable",
                reason: "The base could not be read; it resolves when the environment starts",
              },
            });
          }
        },
      );
    return () => {
      current = false;
    };
  }, [key, projectId, load]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const state: LaunchBaseState = !key
    ? { status: "idle" }
    : result?.key === key
      ? result.state
      : { status: "resolving" };
  return { state, refresh };
}
