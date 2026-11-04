import { DesignEnvironmentDeletionNotice } from "@/components/design/DesignEnvironmentDeletionNotice";
import { useFederation } from "@/components/federation/FederationProvider";
import { useEnvironmentDisplayActivity } from "@/hooks/useEnvironmentDisplayActivity";
import type { Environment } from "@/types";
import { EnvironmentDeleteDialog } from "./EnvironmentDeleteDialog";
import { environmentDisplayName } from "./environment-row-model";

/**
 * The confirmation a row's Delete shows, for a control outside the row. It
 * says the same things as `EnvironmentRow`'s dialog for the same environment.
 * Mounted only while the confirmation is open.
 */
export function LocalEnvironmentDeleteDialog({
  environment,
  onCancel,
  onConfirm,
}: {
  environment: Environment;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { boundMachine, supported: multiMachineClient } = useFederation();
  const { isRunning } = useEnvironmentDisplayActivity(environment);
  const projectHome = environment.projectHome === true;
  return (
    <EnvironmentDeleteDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onConfirm={onConfirm}
      name={environmentDisplayName(environment.name, projectHome)}
      machineName={multiMachineClient ? (boundMachine?.name ?? null) : null}
      projectHome={projectHome}
      local={environment.environmentType === "local"}
      running={isRunning}
      hasPullRequest={Boolean(environment.prUrl)}
      notice={<DesignEnvironmentDeletionNotice environmentId={environment.id} open />}
    />
  );
}
