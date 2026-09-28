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
  const revoked = status.revokedProviders ?? [];

  const allowAgain = async (provider: string) => {
    setRevoking(provider);
    try {
      await backend.restoreProviderCredentials(environmentId, provider);
      toast.success(`${providerLabel(provider)} allowed again`, {
        description: "Its credentials return when the container is next started or rebuilt.",
      });
    } catch {
      toast.error(`Could not allow ${providerLabel(provider)} again`);
    } finally {
      setRevoking(null);
      void load();
    }
  };

  const revoke = async (provider: string) => {
    setRevoking(provider);
    try {
      const result = await backend.revokeProviderCredentials(environmentId, provider);
      if (!result.removed) {
        toast.error(
          `${providerLabel(provider)} is revoked, but the container could not be reached`,
          {
            description:
              "It will not be given these credentials again. Files already in the container are removed when it is next reachable or rebuilt.",
          },
        );
      } else if (result.pendingRebuild) {
        toast.warning(`${providerLabel(provider)} credentials removed from the container`, {
          description:
            "This older container still has them available read-only until it is rebuilt, and terminals you started may hold them until they exit.",
        });
      } else {
        toast.success(`${providerLabel(provider)} credentials removed from the container`, {
          description: result.processesStopped
            ? "Its agent process was stopped and restarts without them. Terminals you started may hold them until they exit."
            : "Terminals and agents already running may hold them until they exit.",
        });
      }
    } catch {
      toast.error(`Could not revoke ${providerLabel(provider)} credentials`);
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
          {status.providers
            .filter((entry) => !revoked.includes(entry.provider))
            .map((entry) => {
              const skipped = Object.values(entry.skipped).reduce(
                (sum, count) => sum + (count ?? 0),
                0,
              );
              return (
                <li key={entry.provider} className="flex items-center justify-between gap-2">
                  <span>
                    {providerLabel(entry.provider)} · {entry.files} files ·{" "}
                    {formatBytes(entry.bytes)}
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
      {revoked.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {revoked.map((provider) => (
            <li key={provider} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {providerLabel(provider)} · revoked for this environment
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={revoking !== null}
                onClick={() => void allowAgain(provider)}
              >
                Allow again
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
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
