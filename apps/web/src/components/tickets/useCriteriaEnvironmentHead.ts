import { useEffect, useState } from "react";
import { isCriterionCommit, type TicketSections } from "@orkestrator/protocol/ticket-sections";
import { useWorktreeSnapshotStore } from "@/stores/worktreeSnapshotStore";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/**
 * The HEAD of a ticket's build environment, read while the ticket is
 * shown and only when a Verify check names a commit to compare it with. A
 * deleted, stopped or unreachable environment answers undefined: the
 * criteria then show their commit with no claim about the current code.
 * Refresh on worktree revisions, linked pipeline changes and focus return.
 * Late responses never replace a newer read or update an unmounted view.
 */
export function useCriteriaEnvironmentHead(
  environmentId: string | undefined,
  sections: TicketSections | undefined,
  enabled: boolean,
  pipelineRevision?: string,
): string | undefined {
  const backend = useScopeBackend();
  const worktreeRevision = useWorktreeSnapshotStore((state) => {
    const entry = environmentId ? state.entries.get(environmentId) : undefined;
    return `${state.generation}:${entry?.targetGeneration}:${entry?.fileListRevision}`;
  });
  const commits = (sections?.acceptanceCriteria ?? [])
    .map((criterion) => criterion.check?.commit)
    .filter(isCriterionCommit);
  const key =
    enabled && environmentId && commits.length
      ? `${environmentId}:${commits.join(",")}:${worktreeRevision}:${pipelineRevision}`
      : "";
  const [read, setRead] = useState<{ key: string; head?: string } | null>(null);
  useEffect(() => {
    if (!key || !environmentId) return;
    let cancelled = false;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void backend.getEnvironmentHead(environmentId).then((head) => {
        if (!cancelled && request === current) setRead({ key, ...(head ? { head } : {}) });
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    refresh();
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [backend, environmentId, key]);
  return key && read?.key === key ? read.head : undefined;
}
