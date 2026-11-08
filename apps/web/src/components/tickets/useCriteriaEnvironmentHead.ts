import { useEffect, useState } from "react";
import { isCriterionCommit, type TicketSections } from "@orkestrator/protocol/ticket-sections";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/**
 * The HEAD of a ticket's build environment, read once while the ticket is
 * shown and only when a Verify check names a commit to compare it with. A
 * deleted, stopped or unreachable environment answers undefined: the
 * criteria then show their commit with no claim about the current code.
 * Read again when a new Verify records a different commit.
 */
export function useCriteriaEnvironmentHead(
  environmentId: string | undefined,
  sections: TicketSections | undefined,
  enabled: boolean,
): string | undefined {
  const backend = useScopeBackend();
  const commits = (sections?.acceptanceCriteria ?? [])
    .map((criterion) => criterion.check?.commit)
    .filter(isCriterionCommit);
  const key =
    enabled && environmentId && commits.length ? `${environmentId}:${commits.join(",")}` : "";
  const [read, setRead] = useState<{ key: string; head?: string } | null>(null);
  useEffect(() => {
    if (!key || !environmentId) return;
    let cancelled = false;
    void backend.getEnvironmentHead(environmentId).then((head) => {
      if (!cancelled) setRead({ key, ...(head ? { head } : {}) });
    });
    return () => {
      cancelled = true;
    };
  }, [backend, environmentId, key]);
  return key && read?.key === key ? read.head : undefined;
}
