/**
 * The action bar's green "Merge PR" button, decided once so the sidebar's
 * "Merge PR" menu item appears and is enabled exactly when the button is.
 */
import type { Environment } from "@/types";

export type MergePrControlEnvironment = Pick<
  Environment,
  | "prUrl"
  | "prState"
  | "hasMergeConflicts"
  | "environmentType"
  | "worktreePath"
  | "status"
  | "lifecycleOperation"
>;

export interface MergePrControl {
  /** Shown but not pressable: the environment is not ready, or a merge is in flight. */
  disabled: boolean;
}

/**
 * `null` while the button is hidden: no pull request, a merged or closed one,
 * or one GitHub has not confirmed is free of conflicts.
 */
export function mergePrControl(
  environment: MergePrControlEnvironment,
  options: { dockerAvailable: boolean; merging?: boolean },
): MergePrControl | null {
  if (!environment.prUrl) return null;
  if (environment.prState === "merged" || environment.prState === "closed") return null;
  if (environment.hasMergeConflicts !== false) return null;
  const running =
    environment.environmentType === "local"
      ? Boolean(environment.worktreePath)
      : options.dockerAvailable && environment.status === "running";
  const merging = options.merging === true || environment.lifecycleOperation === "merging";
  return { disabled: !running || merging };
}
