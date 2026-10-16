import { lazy, useEffect } from "react";
import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import * as backend from "@/lib/backend";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useEnvironmentStore } from "@/stores/environmentStore";

const LazyEnvironmentSettingsDialog = lazy(async () => ({
  default: (await import("@/components/environments/EnvironmentSettingsDialog"))
    .EnvironmentSettingsDialog,
}));

/** Renders the dialog `useAppDialogStore` holds, outside every drawer and row. */
export function AppDialogHost() {
  const request = useAppDialogStore((state) => state.request);
  const close = useAppDialogStore((state) => state.close);
  const environmentId = request?.kind === "environment-settings" ? request.environmentId : null;
  const environment = useEnvironmentStore((state) =>
    environmentId
      ? (state.environments.find((candidate) => candidate.id === environmentId) ?? null)
      : null,
  );
  const updateEnvironment = useEnvironmentStore((state) => state.updateEnvironment);

  // The environment disappeared (deleted, or the list was replaced). Drop the
  // request too, so a later environment that reuses the id cannot reopen it.
  useEffect(() => {
    if (environmentId && !environment) close();
  }, [close, environment, environmentId]);

  if (!environment) return null;
  return (
    <LazyLoadBoundary
      loadingFallback={<LazyDialogLoadingFallback label="Loading environment settings…" />}
    >
      <LazyEnvironmentSettingsDialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        environment={environment}
        onUpdate={(updated) => updateEnvironment(updated.id, updated)}
        onRestart={backend.recreateEnvironment}
      />
    </LazyLoadBoundary>
  );
}
