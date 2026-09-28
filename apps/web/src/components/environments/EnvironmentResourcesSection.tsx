import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import type {
  ContainerResourceLimits,
  ContainerUsageSample,
  DockerCapacity,
  EnvironmentResourcePolicy,
} from "@orkestrator/protocol/container-resources";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { formatBytes } from "@/components/docker/docker-stats-format";
import {
  ResourceLimitFields,
  draftToLimits,
  limitsToDraft,
} from "@/components/settings/ContainerResourceLimitsSettings";

function describeLimits(limits: ContainerResourceLimits | null): string {
  if (!limits) return "unknown";
  const parts = [
    limits.cpus !== null ? `${limits.cpus} CPU` : null,
    limits.memoryMiB !== null ? `${Math.round((limits.memoryMiB / 1024) * 10) / 10} GB` : null,
    limits.pids !== null ? `${limits.pids} processes` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "unrestricted";
}

function describeUsage(sample: ContainerUsageSample | undefined, stale: boolean): string {
  if (!sample) return "No measurement";
  if (sample.state !== "running") {
    return sample.oomKilled ? "Stopped after running out of memory" : "Not running";
  }
  const parts = [
    sample.cpuCores !== null ? `${sample.cpuCores} cores` : "CPU unknown",
    sample.memoryBytes !== null ? formatBytes(sample.memoryBytes) : "memory unknown",
    sample.pids !== null ? `${sample.pids} processes` : null,
  ].filter(Boolean);
  return `${parts.join(" · ")}${stale ? " (stale)" : ""}`;
}

/**
 * Requested budget (and where it comes from) next to what Docker applied and
 * what the container is using now. Changes can apply to the running
 * container, or wait for the next rebuild.
 */
export function EnvironmentResourcesSection({
  environmentId,
  containerId,
  dockerAvailable,
}: {
  environmentId: string;
  containerId: string | null;
  dockerAvailable: boolean;
}) {
  const [policy, setPolicy] = useState<EnvironmentResourcePolicy | null>(null);
  const [usage, setUsage] = useState<{ sample?: ContainerUsageSample; stale: boolean } | null>(
    null,
  );
  const [capacity, setCapacity] = useState<DockerCapacity | null>(null);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(limitsToDraft(null));
  const [applyNow, setApplyNow] = useState(true);
  const [saving, setSaving] = useState(false);
  /** The backend asked for confirmation: the limit is below current use. */
  const [confirmBelowUsage, setConfirmBelowUsage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextPolicy, snapshot, nextCapacity] = await Promise.all([
        backend.getEnvironmentResources(environmentId),
        backend.getContainerUsage(),
        backend.getDockerCapacity(),
      ]);
      setPolicy(nextPolicy);
      setCustom(nextPolicy.source === "environment");
      setDraft(limitsToDraft(nextPolicy.source === "environment" ? nextPolicy.requested : null));
      setUsage({
        sample: snapshot.containers.find((entry) => entry.containerId === containerId),
        stale: snapshot.stale,
      });
      setCapacity(nextCapacity);
    } catch {
      setPolicy(null);
    }
  }, [environmentId, containerId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!policy) return null;

  const save = async (allowBelowUsage = false) => {
    setSaving(true);
    setConfirmBelowUsage(null);
    // Kept as typed while the user decides; nothing was changed.
    let awaitingConfirmation = false;
    try {
      const next = await backend.updateEnvironmentResources(environmentId, {
        limits: custom ? draftToLimits(draft) : null,
        applyNow: applyNow && Boolean(containerId),
        ...(allowBelowUsage ? { allowBelowUsage: true } : {}),
      });
      setPolicy(next);
      toast.success(applyNow && containerId ? "Resource limits applied" : "Resource limits saved", {
        description:
          applyNow && containerId
            ? `Docker now reports: ${describeLimits(next.applied)}.`
            : "They apply when the container is rebuilt.",
      });
    } catch (err) {
      const lifecycle = parseContainerLifecycleError(err);
      if (lifecycle?.code === "confirmation-required") {
        awaitingConfirmation = true;
        setConfirmBelowUsage(lifecycle.message);
        return;
      }
      toast.error("Could not change resource limits", {
        description: lifecycle?.message ?? (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setSaving(false);
      if (!awaitingConfirmation) void load();
    }
  };

  const mismatch =
    policy.applied !== null &&
    containerId !== null &&
    describeLimits(policy.applied) !== describeLimits(policy.requested);

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
      <p className="font-medium">Resources</p>
      <dl className="grid grid-cols-[8rem_1fr] gap-1 text-xs">
        <dt className="text-muted-foreground">Requested</dt>
        <dd>
          {describeLimits(policy.requested)}{" "}
          <span className="text-muted-foreground">
            (
            {policy.source === "environment"
              ? "this environment"
              : policy.source === "global"
                ? "default"
                : "no limits set"}
            )
          </span>
        </dd>
        {containerId ? (
          <>
            <dt className="text-muted-foreground">Applied by Docker</dt>
            <dd>{describeLimits(policy.applied)}</dd>
            <dt className="text-muted-foreground">In use</dt>
            <dd>{describeUsage(usage?.sample, usage?.stale ?? true)}</dd>
          </>
        ) : null}
      </dl>
      {mismatch ? (
        <p className="text-xs text-yellow-700 dark:text-yellow-400">
          The container runs with different limits than requested; they apply when it is rebuilt or
          when you apply them now.
        </p>
      ) : null}
      {policy.unsupported.length > 0 ? (
        <p className="text-xs text-yellow-700 dark:text-yellow-400">
          This Docker engine cannot enforce: {policy.unsupported.join(", ")}.
        </p>
      ) : null}
      {policy.daemonRootless ? (
        <p className="text-xs text-muted-foreground">
          Docker runs rootless: limits are enforced only through the cgroup controllers delegated to
          its user. &ldquo;Applied by Docker&rdquo; is what it reports.
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={custom}
          onChange={(event) => setCustom(event.target.checked)}
        />
        Use limits specific to this environment
      </label>
      <ResourceLimitFields
        draft={draft}
        onChange={setDraft}
        disabled={!custom}
        capacity={capacity}
      />
      {containerId ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={applyNow}
            onChange={(event) => setApplyNow(event.target.checked)}
          />
          Apply to the running container now
        </label>
      ) : null}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void save()}
          disabled={saving || !dockerAvailable}
        >
          Save resource limits
        </Button>
      </div>
      {confirmBelowUsage ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-destructive/40 p-2"
          role="alert"
        >
          <p className="text-xs">{confirmBelowUsage}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => void save(true)}
              disabled={saving}
            >
              Apply anyway
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmBelowUsage(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
