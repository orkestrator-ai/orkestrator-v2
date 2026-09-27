import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  ContainerResourceLimits,
  DockerCapacity,
} from "@orkestrator/protocol/container-resources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import * as backend from "@/lib/backend";

export interface ResourceLimitDraft {
  cpus: string;
  memoryGb: string;
  pids: string;
}

export function limitsToDraft(
  limits: ContainerResourceLimits | null | undefined,
): ResourceLimitDraft {
  return {
    cpus: limits?.cpus != null ? String(limits.cpus) : "",
    memoryGb:
      limits?.memoryMiB != null ? String(Math.round((limits.memoryMiB / 1024) * 100) / 100) : "",
    pids: limits?.pids != null ? String(limits.pids) : "",
  };
}

/** Blank means unrestricted for that axis. */
export function draftToLimits(draft: ResourceLimitDraft): ContainerResourceLimits {
  const number = (value: string) => (value.trim() === "" ? null : Number(value));
  const memoryGb = number(draft.memoryGb);
  return {
    cpus: number(draft.cpus),
    memoryMiB: memoryGb === null ? null : Math.round(memoryGb * 1024),
    pids: number(draft.pids),
  };
}

export function ResourceLimitFields({
  draft,
  onChange,
  disabled,
  capacity,
}: {
  draft: ResourceLimitDraft;
  onChange: (draft: ResourceLimitDraft) => void;
  disabled?: boolean;
  capacity: DockerCapacity | null;
}) {
  const field = (key: keyof ResourceLimitDraft, label: string, hint: string, step: string) => (
    <div className="space-y-1">
      <Label htmlFor={`limit-${key}`} className="text-sm">
        {label}
      </Label>
      <Input
        id={`limit-${key}`}
        type="number"
        min={0}
        step={step}
        value={draft[key]}
        placeholder="Unrestricted"
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
        className="max-w-[12rem]"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {field(
        "cpus",
        "CPU cores",
        capacity?.cpus ? `Docker has ${capacity.cpus}` : "Docker's CPU count is unknown",
        "0.25",
      )}
      {field(
        "memoryGb",
        "Memory (GB)",
        capacity?.memoryBytes
          ? `Docker has ${Math.floor(capacity.memoryBytes / 1024 ** 3)} GB; no swap`
          : "Docker's memory is unknown",
        "0.5",
      )}
      {field("pids", "Processes", "Limits runaway process creation", "1")}
    </div>
  );
}

/**
 * Default budget for new containers. Off by default: no limits are applied
 * until chosen here, and existing containers keep what they were created with.
 */
export function ContainerResourceLimitsSettings({
  initial,
}: {
  initial: ContainerResourceLimits | null | undefined;
}) {
  const [enabled, setEnabled] = useState(Boolean(initial));
  const [draft, setDraft] = useState(limitsToDraft(initial));
  const [capacity, setCapacity] = useState<DockerCapacity | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await backend.getDockerCapacity();
        if (!cancelled) setCapacity(next);
      } catch {
        if (!cancelled) setCapacity(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await backend.setContainerResourceLimits(enabled ? draftToLimits(draft) : null);
      toast.success("Resource limits saved", {
        description: "They apply to containers created or rebuilt from now on.",
      });
    } catch (err) {
      toast.error("Could not save resource limits", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="limit-enabled" className="text-sm">
            Limit resources of new containers
          </Label>
          <p className="text-xs text-muted-foreground">
            Off means no limits. Environments can override this in their own settings.
          </p>
        </div>
        <Switch id="limit-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>
      <ResourceLimitFields
        draft={draft}
        onChange={setDraft}
        disabled={!enabled}
        capacity={capacity}
      />
      <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
        Save limits
      </Button>
    </div>
  );
}
