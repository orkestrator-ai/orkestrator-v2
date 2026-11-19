import { useState } from "react";
import { AlertDialog } from "@/components/ui/alert-dialog";
import type { EnvironmentPrDestination } from "@/lib/backend/config-integrations";
import { prTargetMismatch, pullRequestLabel } from "@/lib/pr-target-mismatch";
import { NonTargetBranchConfirmation } from "./MergePrDialog";
import type { useAutoMergeToggle } from "./useAutoMergeToggle";

/** Both toolbar and ticket switches use the same PR-specific confirmation. */
export function useAutoMergeConfirmation(
  prIdentity: string | null,
  destination: EnvironmentPrDestination | null,
  autoMerge: ReturnType<typeof useAutoMergeToggle>,
) {
  const key = destination && JSON.stringify([prIdentity, destination]);
  const [pending, setPending] = useState<string | null>(null);
  if (pending && (pending !== key || autoMerge.enabled)) setPending(null);
  const disabled = autoMerge.saving || (!autoMerge.enabled && !destination);
  const mismatch = prTargetMismatch({
    actualBase: destination?.expectedBaseRef,
    configuredBase: destination?.expectedTargetBranch,
  });
  const close = () => setPending(null);
  const toggle = () => {
    if (disabled) return;
    if (autoMerge.enabled) void autoMerge.toggle();
    else if (mismatch) setPending(key);
    else if (destination) void autoMerge.set(true, undefined, destination);
  };
  const confirmation =
    pending && pending === key && destination && mismatch ? (
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <NonTargetBranchConfirmation
          mismatch={mismatch}
          later
          prLabel={pullRequestLabel(destination.expectedPrUrl)}
          acceptDisabled={disabled}
          onBack={close}
          onAccept={() => {
            close();
            if (!disabled && !autoMerge.enabled) void autoMerge.set(true, undefined, destination);
          }}
        />
      </AlertDialog>
    ) : null;
  return { toggle, disabled, confirmation, mismatch };
}
