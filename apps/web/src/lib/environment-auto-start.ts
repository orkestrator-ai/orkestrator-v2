import type { Environment } from "@/types";

/** A local environment without a worktree yet starts when it is selected, so a terminal can open. */
export function startsOnSelection(environment: Environment): boolean {
  return (
    environment.environmentType === "local" &&
    !environment.worktreePath &&
    environment.status !== "creating"
  );
}
