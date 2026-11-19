import { GitCommitHorizontal } from "lucide-react";
import { Label } from "@/components/ui/label";
import type { Environment } from "@/types";

/**
 * The exact commit an environment's checkout was created from, and the base
 * branch it was resolved from when one was pinned at creation. Shown in full so
 * the starting point can be copied and reproduced. Nothing is shown for the
 * project home, which works in the user's own checkout, or before the
 * checkout exists.
 */
export function EnvironmentStartingCommit({
  environment,
}: {
  environment: Pick<Environment, "createdFromCommit" | "delegationBaseBranch" | "projectHome">;
}) {
  const commit = environment.createdFromCommit?.trim();
  if (!commit || environment.projectHome) return null;
  const branch = environment.delegationBaseBranch?.trim();
  return (
    <div className="space-y-2" data-testid="environment-starting-commit">
      <Label>Started from</Label>
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-zinc-900 p-2 font-mono text-sm">
        <GitCommitHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {branch && <span className="text-muted-foreground">{branch} @</span>}
        <span className="min-w-0 select-all break-all">{commit}</span>
      </div>
    </div>
  );
}
