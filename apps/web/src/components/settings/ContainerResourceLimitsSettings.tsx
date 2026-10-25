import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  ContainerResourceLimits,
  DockerCapacity,
} from "@orkestrator/protocol/container-resources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import * as backend from "@/lib/backend";
import { useAccountMachine } from "./account-machine";
import { useSettingsConfig } from "./settings-config";

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

type BudgetMode = "default" | "custom" | "unrestricted";

function initialMode(limits: ContainerResourceLimits | null | undefined): BudgetMode {
  if (!limits) return "default";
  return limits.cpus === null && limits.memoryMiB === null && limits.pids === null
    ? "unrestricted"
    : "custom";
}

const AXIS_LABELS: Record<keyof ContainerResourceLimits, string> = {
  cpus: "CPU",
  memoryMiB: "memory",
  pids: "processes",
};

/** "8 GB memory · 4096 processes · no CPU limit" */
export function describeBuiltInDefault(limits: ContainerResourceLimits): string {
  return [
    limits.memoryMiB !== null
      ? `${Math.round((limits.memoryMiB / 1024) * 10) / 10} GB memory`
      : "no memory limit",
    limits.pids !== null ? `${limits.pids} processes` : "no process limit",
    limits.cpus !== null ? `${limits.cpus} CPU` : "no CPU limit",
  ].join(" · ");
}

/**
 * The budget for new containers: the built-in default for this Docker (unless
 * the backend predates it), custom limits, or none. Existing containers keep
 * what they were created with until they are rebuilt.
 */
export function ContainerResourceLimitsSettings({
  initial,
}: {
  initial: ContainerResourceLimits | null | undefined;
}) {
  const [mode, setMode] = useState<BudgetMode>(initialMode(initial));
  const [draft, setDraft] = useState(
    limitsToDraft(initialMode(initial) === "custom" ? initial : null),
  );
  const [capacity, setCapacity] = useState<DockerCapacity | null>(null);
  const [saving, setSaving] = useState(false);
  const { machine } = useAccountMachine();
  const { setConfig } = useSettingsConfig();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await backend.getDockerCapacity(false, machine);
        if (!cancelled) setCapacity(next);
      } catch {
        if (!cancelled) setCapacity(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [machine]);

  // An older backend reports no built-in default and applies none.
  const builtIn = capacity?.builtInDefault;
  const legacyBackend = capacity !== null && !builtIn;

  const save = async () => {
    setSaving(true);
    try {
      await backend.setContainerResourceLimits(
        mode === "custom"
          ? draftToLimits(draft)
          : mode === "unrestricted"
            ? { cpus: null, memoryMiB: null, pids: null }
            : null,
        machine,
      );
      setConfig(await backend.getConfig(machine));
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
      <div className="space-y-2">
        <Label className="text-sm">Limit resources of new containers</Label>
        <SegmentedSelector
          ariaLabel="Limit resources of new containers"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "default", label: "Built-in default", disabled: legacyBackend },
            { value: "custom", label: "Custom" },
            { value: "unrestricted", label: "No limits" },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {mode === "default"
            ? builtIn
              ? `On this Docker: ${describeBuiltInDefault(builtIn.limits)}. ${Object.values(builtIn.limits).some((limit) => limit !== null) ? "Contains a runaway environment without slowing normal work." : "No built-in limit applies on this Docker."}`
              : "Measured limits that contain a runaway environment without slowing normal work."
            : mode === "unrestricted"
              ? "No limits: one environment can use all of Docker's memory and processes."
              : "Blank fields are unrestricted."}{" "}
          Environments can override this in their own settings.
        </p>
        {mode === "default" && builtIn && builtIn.unenforced.length > 0 ? (
          <p className="text-xs text-yellow-700 dark:text-yellow-400">
            This Docker engine cannot enforce the default{" "}
            {builtIn.unenforced.map((axis) => AXIS_LABELS[axis]).join(" and ")} limit, so it is left
            off.
          </p>
        ) : null}
        {legacyBackend ? (
          <p className="text-xs text-muted-foreground">
            This backend has no built-in default; without custom limits it applies none.
          </p>
        ) : null}
      </div>
      <ResourceLimitFields
        draft={draft}
        onChange={setDraft}
        disabled={mode !== "custom"}
        capacity={capacity}
      />
      <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
        Save limits
      </Button>
    </div>
  );
}
