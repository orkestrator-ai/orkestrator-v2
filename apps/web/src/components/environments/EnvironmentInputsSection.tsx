import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { EnvironmentInputStatus } from "@orkestrator/protocol/container-recovery";
import { AGENT_PLATFORM_LABELS, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { formatBytes } from "@/components/docker/docker-stats-format";

function providerLabel(provider: string): string {
  if (provider === "git") return "Git identity";
  return isAgentPlatform(provider) ? AGENT_PLATFORM_LABELS[provider] : provider;
}

interface EnvironmentInputsSectionProps {
  environmentId: string;
  dockerAvailable: boolean;
}

/**
 * What agent configuration and credentials the container was given. Reads the
 * backend's record of the staged revision, so it reflects the running
 * container rather than the current settings; a difference is shown as
 * something a rebuild would change.
 */
export function EnvironmentInputsSection({
  environmentId,
  dockerAvailable,
}: EnvironmentInputsSectionProps) {
  const [status, setStatus] = useState<EnvironmentInputStatus | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await backend.getEnvironmentInputs(environmentId));
    } catch {
      setStatus(null);
    }
  }, [environmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status || status.mode === "none") return null;

  const revoke = async (provider: string) => {
    setRevoking(provider);
    try {
      const result = await backend.revokeProviderCredentials(environmentId, provider);
      if (!result.removed) {
        toast.error(`Could not remove ${providerLabel(provider)} credentials`, {
          description: "The container could not be reached. Nothing was reported as removed.",
        });
      } else if (result.pendingRebuild) {
        toast.warning(`${providerLabel(provider)} credentials removed from the container`, {
          description:
            "The container still has them available read-only until it is rebuilt, and running agents may hold them until they restart.",
        });
      } else {
        toast.success(`${providerLabel(provider)} credentials removed from the container`);
      }
    } finally {
      setRevoking(null);
      void load();
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <p className="font-medium">Agent inputs</p>
      {status.mode === "host-mounts" ? (
        <p className="text-muted-foreground">
          This container was created with your agent home directories mounted read-only. Rebuilding
          it gives it only the configuration and credentials of enabled agents.
        </p>
      ) : status.mode === "unknown" ? (
        <p className="text-muted-foreground">
          The record of this container&apos;s inputs is unavailable.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {status.providers.map((entry) => {
            const skipped = Object.values(entry.skipped).reduce(
              (sum, count) => sum + (count ?? 0),
              0,
            );
            return (
              <li key={entry.provider} className="flex items-center justify-between gap-2">
                <span>
                  {providerLabel(entry.provider)} · {entry.files} files · {formatBytes(entry.bytes)}
                  {skipped > 0 ? ` · ${skipped} skipped (links, oversized or unreadable)` : ""}
                </span>
                {entry.provider !== "git" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!dockerAvailable || revoking !== null}
                    onClick={() => void revoke(entry.provider)}
                  >
                    Remove credentials
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {status.missingProviders.length > 0 ? (
        <p className="text-yellow-700 dark:text-yellow-400">
          Enabled since this container was created:{" "}
          {status.missingProviders.map(providerLabel).join(", ")}. Rebuild to give it their
          configuration.
        </p>
      ) : null}
      {status.disabledProviders.length > 0 ? (
        <p className="text-yellow-700 dark:text-yellow-400">
          No longer enabled: {status.disabledProviders.map(providerLabel).join(", ")}. Remove their
          credentials or rebuild.
        </p>
      ) : null}
    </div>
  );
}
