import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isBuildPipeline, type BuildPipeline } from "@/stores/buildPipelineStore";
import type { BuildLaunchMachine } from "@/components/build/build-machines";
import { useNodeScope } from "@/lib/node-scope/providers";
import { machineBackendClient, scopeBackendClient } from "@/lib/backend/client";
import { createBuildPipelinesApi } from "@/lib/backend/build-pipelines";

export type LocatedBuildPipeline = BuildPipeline & { buildMachine?: BuildLaunchMachine };

/** Remote records stay on their owner; this is a disposable projection of snapshots. */
export function useLinearBuildPipelines(
  own: Map<string, BuildPipeline>,
  machines: readonly BuildLaunchMachine[],
) {
  const scope = useNodeScope();
  // Target objects may be recreated by summary refreshes without changing routing.
  const targetsKey = JSON.stringify(machines.filter((machine) => !machine.current));
  const targets = useMemo(() => JSON.parse(targetsKey) as BuildLaunchMachine[], [targetsKey]);
  const [remote, setRemote] = useState<Map<string, LocatedBuildPipeline>>(new Map());
  const [checkedTargets, setCheckedTargets] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const records = await Promise.all(
        targets.map(async (target) => {
          if (!target.available) throw new Error("A build machine is unavailable");
          const rows = await createBuildPipelinesApi(
            machineBackendClient(scopeBackendClient(scope), target.machine),
          ).listBuildPipelines(target.projectId);
          return rows
            .map((record) => {
              const row = record.snapshot;
              if (
                !isBuildPipeline(row) ||
                !Number.isSafeInteger(record.revision) ||
                record.revision < 1 ||
                row.id !== record.id ||
                row.projectId !== target.projectId
              ) {
                throw new Error("Invalid remote build snapshot");
              }
              return { ...row, backendRevision: record.revision, buildMachine: target };
            })
            .filter((row) => row.source?.type === "linear")
            .map((row) => [`${target.key}:${row.id}`, row] as const);
        }),
      );
      const snapshot = new Map(records.flat());
      if (request === generation.current) {
        setRemote(snapshot);
        setCheckedTargets(targetsKey);
        setError(false);
      }
      return snapshot;
    } catch (error) {
      if (request === generation.current) setError(true);
      throw error;
    }
  }, [scope, targets, targetsKey]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        await refresh();
      } catch {
        if (!stopped) setError(true);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      stopped = true;
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [refresh]);

  const pipelines = useMemo(
    () =>
      new Map<string, LocatedBuildPipeline>([
        ...own,
        ...(checkedTargets === targetsKey ? remote : []),
      ]),
    [own, remote, checkedTargets, targetsKey],
  );
  return {
    pipelines,
    refresh,
    unavailable: targets.length > 0 && (error || checkedTargets !== targetsKey),
  };
}
