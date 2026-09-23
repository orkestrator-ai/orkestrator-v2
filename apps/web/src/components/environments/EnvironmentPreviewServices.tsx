import { useEffect, useState } from "react";
import { Pencil, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import {
  previewErrorFromUnknown,
  type PreviewServiceDefinition,
  type PreviewServiceSnapshot,
} from "@orkestrator/protocol/preview-services";
import { toast } from "sonner";

import { PreviewServiceDialog } from "@/components/browser/PreviewServiceDialog";
import { ReadinessDot } from "@/components/browser/PreviewServicePicker";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import {
  diagnoseService,
  serviceReadiness,
  serviceTargetLabel,
} from "@/lib/preview-service-display";
import { ensurePreviewServiceSync, usePreviewServiceStore } from "@/stores/previewServiceStore";
import type { Environment } from "@/types";

export interface EnvironmentPreviewServicesProps {
  environment: Pick<Environment, "id" | "environmentType">;
  /** Offer a mapping for a container port that is not published (requires recreation). */
  onAddPortMapping?: (containerPort: number) => void;
}

function message(error: unknown): string {
  return (
    previewErrorFromUnknown(error)?.message ??
    (error instanceof Error ? error.message : String(error))
  );
}

/**
 * Registered preview services for one environment: what the browser button and
 * terminal links resolve to. Everything is validated by the backend again.
 */
export function EnvironmentPreviewServices({
  environment,
  onAddPortMapping,
}: EnvironmentPreviewServicesProps) {
  const status = usePreviewServiceStore((state) => state.status);
  const capabilities = usePreviewServiceStore((state) => state.capabilities);
  const snapshot = usePreviewServiceStore(
    (state) => state.environments[environment.id]?.snapshot ?? null,
  );
  const refresh = usePreviewServiceStore((state) => state.refreshEnvironment);
  const [editing, setEditing] = useState<PreviewServiceDefinition | null | "new">(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    ensurePreviewServiceSync();
    void refresh(environment.id, { force: true });
  }, [environment.id, refresh]);

  if (status === "unsupported") {
    return (
      <p className="text-sm text-muted-foreground">
        This backend predates preview services. Browser tabs use backend ports directly.
      </p>
    );
  }
  const services = snapshot?.services ?? [];
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      await refresh(environment.id, { force: true });
    } catch (error) {
      toast.error("Preview service change failed", { description: message(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Browser tabs remember the service, not a host port, so they follow it when a container is
          recreated. Services are generated from the entry port and TCP port mappings; register
          others here.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing("new")}>
          <Plus className="mr-1 h-4 w-4" />
          Register
        </Button>
      </div>
      {services.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No preview services are registered for this environment.
        </p>
      )}
      <ul className="space-y-2">
        {services.map((service: PreviewServiceSnapshot) => {
          const readiness = serviceReadiness(service);
          const diagnosis = diagnoseService(service, { capabilities });
          const { definition, endpoint } = service;
          return (
            <li
              key={definition.serviceId}
              className="rounded-md border border-zinc-700 bg-zinc-800/40 p-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <ReadinessDot tone={readiness.tone} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{definition.label}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {definition.scheme} · {serviceTargetLabel(definition)}
                    {endpoint.hostPort ? ` → host ${endpoint.hostPort}` : ""} · {readiness.label}
                  </span>
                </span>
                {definition.entry ? (
                  <span className="text-[10px] uppercase text-muted-foreground">entry</span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Open ${definition.label} from the browser button`}
                    title="Open from the environment's browser button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`entry:${definition.serviceId}`, () =>
                        backend.updatePreviewService(
                          definition.serviceId,
                          definition.definitionRevision,
                          { entry: true },
                        ),
                      )
                    }
                  >
                    <Star className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={`Check ${definition.label} now`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`probe:${definition.serviceId}`, () =>
                      backend.probePreviewService(definition.serviceId),
                    )
                  }
                >
                  <RefreshCw
                    className={
                      busy === `probe:${definition.serviceId}`
                        ? "h-3.5 w-3.5 animate-spin"
                        : "h-3.5 w-3.5"
                    }
                  />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={`Edit ${definition.label}`}
                  onClick={() => setEditing(definition)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={`Remove ${definition.label}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`remove:${definition.serviceId}`, () =>
                      backend.removePreviewService(
                        definition.serviceId,
                        definition.definitionRevision,
                      ),
                    )
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {diagnosis && (
                <div className="mt-1 flex flex-wrap items-center gap-2 pl-4 text-xs text-muted-foreground">
                  <span>
                    {diagnosis.title}. {diagnosis.detail}
                  </span>
                  {diagnosis.actions.includes("configure-mapping") &&
                    onAddPortMapping &&
                    definition.targetKind === "container" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => onAddPortMapping(definition.applicationPort)}
                      >
                        Publish port {definition.applicationPort} (auto)
                      </Button>
                    )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editing !== null && (
        <PreviewServiceDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          environmentId={environment.id}
          environmentType={environment.environmentType === "local" ? "local" : "containerized"}
          existing={editing === "new" ? null : editing}
          onSaved={() => void refresh(environment.id, { force: true })}
        />
      )}
    </div>
  );
}
