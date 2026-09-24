import { useEffect, useState } from "react";
import { designApi, getCapabilities } from "./design-client";

interface Summary {
  total: number;
  unexported: number;
  outdated: number;
}

/**
 * Explains, before an environment is deleted, that its designs are held by
 * the workspace (not the repository) and are removed with it unless exported.
 * Best effort: an old backend or a failed read shows nothing rather than a
 * misleading "no designs" claim.
 */
export function DesignEnvironmentDeletionNotice({
  environmentId,
  open,
}: {
  environmentId: string;
  open: boolean;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    if (!open) {
      setSummary(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        if (!(await getCapabilities())?.library) return;
        const page = await designApi.library(environmentId, { filter: "all", limit: 50 });
        if (!active) return;
        const live = page.entries.filter((entry) => entry.state !== "deleted");
        setSummary({
          total: page.total,
          unexported: live.filter((entry) => !entry.export).length,
          outdated: live.filter((entry) => entry.export?.outdated).length,
        });
      } catch {
        // Informational only; the deletion itself is unaffected.
      }
    })();
    return () => {
      active = false;
    };
  }, [environmentId, open]);
  if (!summary || summary.total === 0) return null;
  const designs = summary.total === 1 ? "1 design" : `${summary.total} designs`;
  const notExported =
    summary.unexported + summary.outdated > 0
      ? ` ${summary.unexported + summary.outdated} ${summary.unexported + summary.outdated === 1 ? "has" : "have"} changes that were never exported to the repository.`
      : "";
  return (
    <span className="mt-2 block text-orange-500" data-testid="design-deletion-notice">
      This environment holds {designs} in its workspace, which will be deleted with it.
      {notExported} Export or download any design you want to keep first.
    </span>
  );
}
