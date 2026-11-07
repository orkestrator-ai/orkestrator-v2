import { useCallback, useState } from "react";
import { toast } from "sonner";
import { backendForScope } from "@/lib/backend/scope-backend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { useEnvironmentStore } from "@/stores";
import type { Environment } from "@/types";

/**
 * The auto-merge switch, shared by the action bar's toggle and the pipeline's
 * Integrate dialog. The flag lives on the environment record and the backend
 * does the merging (`pr-auto-merge.ts`), so this only writes the durable
 * setting and mirrors the answer into the store; every other client learns of
 * it through the environment channel.
 *
 * `set(true, true)` also asks the backend to delete the environment once the
 * merge is confirmed. Every call restates that choice, so the plain toggle
 * turns a cleanup request off.
 */
export function useAutoMergeToggle(
  environment: Pick<Environment, "id" | "autoMerge" | "autoMergeCleanup"> | null,
) {
  const environmentId = environment?.id ?? null;
  // This node's backend (plan item 4001); the command node outside a node scope.
  const backendScope = useScopesWithCommandFallback().scope;
  const enabled = environment?.autoMerge === true;
  const cleanup = enabled && environment?.autoMergeCleanup === true;
  const [savingEnvironmentId, setSavingEnvironmentId] = useState<string | null>(null);
  const saving = savingEnvironmentId !== null && savingEnvironmentId === environmentId;
  const updateEnvironment = useEnvironmentStore((state) => state.updateEnvironment);

  /** Resolves to whether auto-merge is on afterwards, as the backend answered. */
  const set = useCallback(
    async (next: boolean, cleanupAfterMerge?: boolean): Promise<boolean | null> => {
      if (!environmentId || savingEnvironmentId === environmentId) return null;
      setSavingEnvironmentId(environmentId);
      try {
        const updated = await backendForScope(backendScope).setEnvironmentAutoMerge(
          environmentId,
          next,
          cleanupAfterMerge,
        );
        const on = updated?.autoMerge === true;
        updateEnvironment(environmentId, {
          autoMerge: on,
          autoMergeCleanup: on && updated?.autoMergeCleanup === true,
        });
        // The backend only arms auto-merge for an open PR.
        if (next && !on) {
          toast.error("Could not turn on auto-merge", {
            description: "This environment has no open pull request.",
          });
        }
        if (next && on && (updated?.autoMergeCleanup === true) !== (cleanupAfterMerge === true)) {
          toast.error("Integration options were not saved");
          return null;
        }
        return on;
      } catch (error) {
        toast.error(next ? "Could not turn on auto-merge" : "Could not turn off auto-merge", {
          description: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        setSavingEnvironmentId((current) => (current === environmentId ? null : current));
      }
    },
    [backendScope, environmentId, savingEnvironmentId, updateEnvironment],
  );

  const toggle = useCallback(() => set(!enabled), [enabled, set]);

  return { enabled, cleanup, saving, set, toggle };
}
