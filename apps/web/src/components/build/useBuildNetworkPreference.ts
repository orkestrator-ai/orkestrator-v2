import { useEffect, useState } from "react";
import { useNodeScope } from "@/lib/node-scope/providers";
import { machineBackendClient, scopeBackendClient } from "@/lib/backend/client";
import type { AppConfig, NetworkAccessMode } from "@/types";
import type { BuildLaunchMachineChoice } from "./build-machines";

/** Read the preference where admission records it, using that node's project id. */
export function useBuildNetworkPreference(
  target: BuildLaunchMachineChoice | undefined,
  open: boolean,
  ownDefault: NetworkAccessMode,
) {
  const scope = useNodeScope();
  const machine = target?.machine;
  const projectId = target?.projectId;
  const [session, setSession] = useState({ open, machine, projectId, scope, revision: 0 });
  if (
    session.open !== open ||
    session.machine !== machine ||
    session.projectId !== projectId ||
    session.scope !== scope
  ) {
    setSession({ open, machine, projectId, scope, revision: session.revision + 1 });
  }
  const revision = session.revision;
  const [answer, setAnswer] = useState<{
    machine: typeof machine;
    projectId: string;
    revision: number;
    scope: typeof scope;
    mode?: NetworkAccessMode;
    error?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!open || !projectId) return;
    let stopped = false;
    void machineBackendClient(scopeBackendClient(scope), machine)
      .invokeRaw<AppConfig>("get_config")
      .then((config) => {
        const mode = config.repositories[projectId]?.lastBuildNetworkAccessMode ?? "full";
        if (mode !== "full" && mode !== "restricted") throw new Error("Invalid network preference");
        if (!stopped) setAnswer({ machine, projectId, revision, scope, mode });
      })
      .catch(() => {
        if (!stopped) setAnswer({ machine, projectId, revision, scope, error: true });
      });
    return () => {
      stopped = true;
    };
  }, [scope, machine, projectId, open, revision]);
  const current =
    answer?.scope === scope &&
    answer?.revision === revision &&
    answer?.machine === machine &&
    answer?.projectId === projectId
      ? answer
      : null;
  return {
    mode: target ? current?.mode : ownDefault,
    pending: Boolean(target) && !current,
    error: Boolean(target && current?.error),
  };
}
