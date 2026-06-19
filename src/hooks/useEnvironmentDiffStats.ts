import { useEffect, useRef, useMemo } from "react";
import { useEnvironmentStore, useConfigStore } from "@/stores";
import { useEnvironmentDiffStore } from "@/stores/environmentDiffStore";
import * as tauri from "@/lib/tauri";
import type { Environment } from "@/types";

/** Polling interval for diff stats (15 seconds - less frequent than files panel) */
const POLL_INTERVAL = 15000;

/** Fields needed from each environment for diff polling */
interface DiffPollEnv {
  id: string;
  projectId: string;
  environmentType: Environment["environmentType"];
  worktreePath?: string;
  status: string;
  containerId?: string | null;
  createdFromCommit?: string;
}

/**
 * Hook that polls git diff stats for all environments and updates the diff store.
 * Should be mounted once at the sidebar/app level.
 */
export function useEnvironmentDiffStats() {
  const environments = useEnvironmentStore((s) => s.environments);
  const getRepositoryConfig = useConfigStore((s) => s.getRepositoryConfig);
  const setStats = useEnvironmentDiffStore((s) => s.setStats);
  const pruneStats = useEnvironmentDiffStore((s) => s.pruneStats);
  const loadingRef = useRef(new Set<string>());

  // Derive a stable snapshot of only the fields we need, keyed by a string
  // of IDs so the effect only re-runs when the environment list itself changes
  // (not on unrelated field updates like name changes).
  const envSnapshot = useMemo<DiffPollEnv[]>(
    () =>
      environments.map((e) => ({
        id: e.id,
        projectId: e.projectId,
        environmentType: e.environmentType,
        worktreePath: e.worktreePath,
        status: e.status,
        containerId: e.containerId,
        createdFromCommit: e.createdFromCommit,
      })),
    [environments]
  );

  // Stable identity string that only changes when the set of environments
  // or their availability-relevant fields change.
  const envKey = useMemo(
    () =>
      envSnapshot
        .map((e) => `${e.id}:${e.status}:${e.worktreePath ?? ""}:${e.containerId ?? ""}:${e.createdFromCommit ?? ""}`)
        .join("|"),
    [envSnapshot]
  );

  // Keep a ref to the latest snapshot so the interval callback always
  // reads current data without needing to be in the dependency array.
  const envRef = useRef(envSnapshot);
  envRef.current = envSnapshot;

  const getRepositoryConfigRef = useRef(getRepositoryConfig);
  getRepositoryConfigRef.current = getRepositoryConfig;

  useEffect(() => {
    const fetchStatsForEnvironment = async (env: DiffPollEnv) => {
      if (loadingRef.current.has(env.id)) return;

      const isLocal = env.environmentType === "local";
      const isAvailable = isLocal
        ? !!env.worktreePath
        : env.status === "running" && !!env.containerId;

      if (!isAvailable) return;

      const repoConfig = getRepositoryConfigRef.current(env.projectId);
      const comparisonRef = env.createdFromCommit || repoConfig?.prBaseBranch || "main";

      loadingRef.current.add(env.id);
      try {
        let changes: tauri.GitFileChange[];
        if (isLocal && env.worktreePath) {
          changes = await tauri.getLocalGitStatus(env.worktreePath, comparisonRef);
        } else if (env.containerId) {
          changes = await tauri.getGitStatus(env.containerId, comparisonRef);
        } else {
          return;
        }

        const totalAdditions = changes.reduce((sum, c) => sum + c.additions, 0);
        const totalDeletions = changes.reduce((sum, c) => sum + c.deletions, 0);

        setStats(env.id, {
          additions: totalAdditions,
          deletions: totalDeletions,
          filesChanged: changes.length,
        });
      } catch {
        // Silently ignore - stats are non-critical
      } finally {
        loadingRef.current.delete(env.id);
      }
    };

    const fetchAll = () => {
      const currentEnvs = envRef.current;
      // Prune stats for environments that no longer exist
      const currentIds = new Set(currentEnvs.map((e) => e.id));
      pruneStats(currentIds);

      currentEnvs.forEach(fetchStatsForEnvironment);
    };

    // Initial fetch
    fetchAll();

    // Poll
    const interval = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [envKey, setStats, pruneStats]);
}
