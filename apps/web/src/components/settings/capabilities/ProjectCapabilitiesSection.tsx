import { useState } from "react";
import { Download, Upload } from "lucide-react";

import type { CapabilityImportPreview } from "@orkestrator/protocol/capability-resources-api";

import { Button } from "@/components/ui/button";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import { describeError } from "./capability-format";
import { CapabilityScopeCard } from "./CapabilityScopeCard";
import { useCapabilityResource } from "./useCapabilityResource";

/**
 * A project's capabilities: the toolkits its sessions use, and the portable
 * manifest and lockfile in its repository. Writing the files and importing
 * them both go through a preview; credentials and machine choices stay out
 * of Git.
 */
export function ProjectCapabilitiesSection({ projectId }: { projectId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<CapabilityImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const effective = useCapabilityResource(
    () => capabilitiesApi.getEffectiveAgentResources({ target: { provider: "claude", projectId } }),
    [projectId],
  );
  const projectSetups = (effective.state.data?.setupRevisions ?? [])
    .map((entry) => entry.id)
    .filter((id) => id !== "my-setup");
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <CapabilityScopeCard scope="project" scopeId={projectId} projectId={projectId} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || projectSetups.length === 0}
          onClick={() =>
            void run(async () => {
              await capabilitiesApi.exportCapabilitySetup(projectSetups, projectId, true);
              setMessage(
                "Wrote orkestrator.capabilities.yaml and its lockfile to the project. Commit them to share the setup.",
              );
            })
          }
        >
          <Download className="h-3.5 w-3.5" /> Write to the repository
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setPreview(await capabilitiesApi.previewCapabilityImport({ projectId })),
            )
          }
        >
          <Upload className="h-3.5 w-3.5" /> Import from the repository
        </Button>
      </div>
      {preview ? (
        <div className="space-y-1 rounded-md border border-zinc-800 p-3 text-xs">
          {preview.issues.map((issue) => (
            <p key={`${issue.path}:${issue.message}`} className="text-rose-300">
              {issue.path}: {issue.message}
            </p>
          ))}
          {preview.setups.map((setup) => (
            <p key={setup.name}>
              {setup.name}: {setup.action} ({setup.packages} packages)
            </p>
          ))}
          {preview.packages.map((pkg) => (
            <p key={pkg.packageId}>
              {pkg.packageId}: {pkg.action}
              {pkg.reason ? ` (${pkg.reason})` : ""}
            </p>
          ))}
          {preview.approvalReasons.map((reason) => (
            <p key={reason} className="text-amber-200">
              {reason}
            </p>
          ))}
          {preview.valid ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await capabilitiesApi.importCapabilitySetup(preview.previewId);
                  setPreview(null);
                  setMessage(
                    "Imported. Each machine fetches the pinned revisions and uses its own credentials.",
                  );
                  effective.reload();
                })
              }
            >
              Approve and import
            </Button>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
