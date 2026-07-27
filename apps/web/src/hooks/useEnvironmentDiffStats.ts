import { useEffect, useRef, useMemo } from "react";
import { useEnvironmentStore, useConfigStore } from "@/stores";
import { useEnvironmentDiffStore } from "@/stores/environmentDiffStore";
import * as backend from "@/lib/backend";
import { resolveComparisonRef } from "@/lib/diff-baseline";
import type { Environment } from "@/types";

/** Polling interval for diff stats (15 seconds - less frequent than files panel) */
export const POLL_INTERVAL = 15000;

/** Fields needed from each environment for diff polling */
interface DiffPollEnv {
  id: string;
  projectId: string;
  environmentType: Environment["environmentType"];
  worktreePath?: string;
  status: string;
  containerId?: string | null;
  comparisonRef: string;
}

type DiffPollTarget =
  | { kind: "local"; worktreePath: string }
  | { kind: "container"; containerId: string };

/** Returns the backend target to poll, or undefined when the environment cannot be polled yet. */
function resolveDiffPollTarget(env: DiffPollEnv): DiffPollTarget | undefined {
  if (env.environmentType === "local") {
    return env.worktreePath ? { kind: "local", worktreePath: env.worktreePath } : undefined;
  }
  if (env.status !== "running" || !env.containerId) return undefined;
  return { kind: "container", containerId: env.containerId };
}

/**
 * Whether an environment's last known counts should stay on screen.
 *
 * Deliberately weaker than `resolveDiffPollTarget`: "cannot be read right now"
 * is not "no longer exists". A container spends time in `creating`, `stopping`
 * and `error`, and is commonly left `stopped` - its work is still on disk, and
 * the counts are the last true reading, which is exactly what a user needs when
 * deciding whether to resume or delete it. Dropping them on every transition
 * would also make the badge flicker across an ordinary restart.
 *
 * A local environment with no worktree path has genuinely lost the thing the
 * counts described, so those are dropped.
 */
function retainsDiffStats(env: DiffPollEnv): boolean {
  if (env.environmentType === "local") return Boolean(env.worktreePath);
  return true;
}

function getDiffPollEnvKey(env: DiffPollEnv): string {
  return JSON.stringify([
    env.id,
    env.projectId,
    env.environmentType,
    env.worktreePath ?? "",
    env.status,
    env.containerId ?? "",
    env.comparisonRef,
  ]);
}

/**
 * Hook that polls git diff stats for all environments and updates the diff store.
 * Should be mounted once at the sidebar/app level.
 */
export function useEnvironmentDiffStats() {
  const environments = useEnvironmentStore((s) => s.environments);
  const repositoryConfigs = useConfigStore((s) => s.config?.repositories);
  const setStats = useEnvironmentDiffStore((s) => s.setStats);
  const pruneStats = useEnvironmentDiffStore((s) => s.pruneStats);
  const loadingRef = useRef(new Set<string>());

  // Derive a stable snapshot of only the fields we need, keyed by a string
  // of IDs so the effect only re-runs when availability or the comparison
  // baseline changes (not on unrelated field updates like name changes).
  const envSnapshot = useMemo<DiffPollEnv[]>(
    () =>
      environments.map((e) => ({
        id: e.id,
        projectId: e.projectId,
        environmentType: e.environmentType,
        worktreePath: e.worktreePath,
        status: e.status,
        containerId: e.containerId,
        comparisonRef: resolveComparisonRef(
          e.createdFromCommit,
          repositoryConfigs?.[e.projectId],
        ),
      })),
    [environments, repositoryConfigs]
  );

  // Stable identity string that only changes when the set of environments
  // or their availability/baseline fields change.
  const envKey = useMemo(
    () => JSON.stringify(envSnapshot.map(getDiffPollEnvKey)),
    [envSnapshot]
  );

  // Keep a ref to the latest snapshot so the interval callback always
  // reads current data without needing to be in the dependency array.
  const envRef = useRef(envSnapshot);
  envRef.current = envSnapshot;

  useEffect(() => {
    const fetchStatsForEnvironment = async (env: DiffPollEnv) => {
      // Serialise on the environment id, not the snapshot key. Each request runs a
      // `git fetch` inside the environment, so keying the guard by snapshot would
      // let a field changing mid-flight start a second concurrent request against
      // the same container. Staleness is handled separately, below.
      if (loadingRef.current.has(env.id)) return;

      // Availability and dispatch are derived from one narrowing so there is no
      // second, unreachable "neither path is usable" branch to keep in sync.
      const target = resolveDiffPollTarget(env);
      if (!target) return;

      const requestKey = getDiffPollEnvKey(env);

      loadingRef.current.add(env.id);
      try {
        const changes: backend.GitFileChange[] = target.kind === "local"
          ? await backend.getLocalGitStatus(target.worktreePath, env.comparisonRef, true)
          : await backend.getGitStatus(target.containerId, env.comparisonRef, true);

        // The snapshot this result describes may have been replaced while the
        // request was open, including a change to the ref the stats use.
        const isCurrentEnvironment = envRef.current.some(
          (currentEnv) => getDiffPollEnvKey(currentEnv) === requestKey,
        );
        if (!isCurrentEnvironment) return;

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
        // A discarded result would otherwise leave stale stats on screen until the
        // next tick, because the effect re-run that changed the snapshot was itself
        // suppressed by the in-flight guard above. Refetch once for the new snapshot.
        const latest = envRef.current.find((currentEnv) => currentEnv.id === env.id);
        if (latest && getDiffPollEnvKey(latest) !== requestKey) {
          void fetchStatsForEnvironment(latest);
        }
      }
    };

    const fetchAll = () => {
      const currentEnvs = envRef.current;
      // Drop stats for environments that are gone, plus the ones whose counts can
      // no longer describe anything real. A merely-unpollable environment keeps
      // its last reading; see `retainsDiffStats`.
      const retainedIds = new Set(
        currentEnvs.filter(retainsDiffStats).map((env) => env.id),
      );
      pruneStats(retainedIds);

      currentEnvs.forEach(fetchStatsForEnvironment);
    };

    // Initial fetch
    fetchAll();

    // Poll
    const interval = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [envKey, setStats, pruneStats]);
}
