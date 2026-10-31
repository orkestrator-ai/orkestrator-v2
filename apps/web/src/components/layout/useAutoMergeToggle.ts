import { useCallback, useState } from "react";
import { toast } from "sonner";
import * as backend from "@/lib/backend";
import { useEnvironmentStore } from "@/stores";
import type { Environment } from "@/types";

/**
 * The action bar's auto-merge switch. The flag lives on the environment
 * record and the backend does the merging (`pr-auto-merge.ts`), so this only
 * flips the durable setting and mirrors the answer into the store; every other
 * client learns of it through the environment channel.
 */
export function useAutoMergeToggle(environment: Pick<Environment, "id" | "autoMerge"> | null) {
  const environmentId = environment?.id ?? null;
  const enabled = environment?.autoMerge === true;
  const [savingEnvironmentId, setSavingEnvironmentId] = useState<string | null>(null);
  const saving = savingEnvironmentId !== null && savingEnvironmentId === environmentId;

  const toggle = useCallback(async () => {
    if (!environmentId || savingEnvironmentId === environmentId) return;
    const next = !enabled;
    setSavingEnvironmentId(environmentId);
    try {
      const updated = await backend.setEnvironmentAutoMerge(environmentId, next);
      useEnvironmentStore
        .getState()
        .updateEnvironment(environmentId, { autoMerge: updated?.autoMerge === true });
    } catch (error) {
      toast.error(next ? "Could not turn on auto-merge" : "Could not turn off auto-merge", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingEnvironmentId((current) => (current === environmentId ? null : current));
    }
  }, [enabled, environmentId, savingEnvironmentId]);

  return { enabled, saving, toggle };
}
