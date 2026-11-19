import { useCallback, useEffect, useState } from "react";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  classifyLaunchBaseTip,
  type LaunchBaseState,
  type ProjectBaseBranchTip,
} from "@/lib/launch-base";

const log = createLogger("web.environment");

export type LoadLaunchBaseTip = (
  projectId: string,
  retry: boolean,
) => Promise<ProjectBaseBranchTip>;

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
  const [request, setRequest] = useState({ enabled, projectId, load, retry: false });
  if (enabled !== request.enabled || projectId !== request.projectId || load !== request.load) {
    setRequest({ enabled, projectId, load, retry: false });
  }
  const [result, setResult] = useState<{ request: typeof request; state: LaunchBaseState } | null>(
    null,
  );

  useEffect(() => {
    const { enabled, projectId, load, retry } = request;
    if (!enabled || !projectId) return;
    let current = true;
    // A load that throws synchronously (an older node's backend without the
    // read) is an unavailable base like any rejected one.
    Promise.resolve()
      .then(() => load(projectId, retry))
      .then(
        (tip) => {
          if (current) setResult({ request, state: classifyLaunchBaseTip(tip) });
        },
        (error: unknown) => {
          log.warn("launch-base.unavailable", { error: formatLogError(error) });
          if (current) {
            setResult({
              request,
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
  }, [request]);

  const refresh = useCallback(() => setRequest((current) => ({ ...current, retry: true })), []);
  const state: LaunchBaseState =
    !enabled || !projectId
      ? { status: "idle" }
      : result?.request === request
        ? result.state
        : { status: "resolving" };
  return { state, refresh };
}
