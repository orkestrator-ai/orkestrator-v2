import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Container,
  FolderOpen,
  Laptop,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

import {
  EnvironmentDiskUsageBreakdown,
  formatDiskBytes,
} from "@/components/disk-usage/EnvironmentDiskUsageBreakdown";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import * as backend from "@/lib/backend";
import type {
  DiskUsageEnvironmentSummary,
  EnvironmentDiskUsage,
  WorktreeLocationsSnapshot,
} from "@/lib/backend";
import { pickHostPath } from "@/lib/host-path-picker";
import { isWindowMachine, useAccountMachine } from "./account-machine";
import { cn } from "@/lib/utils";
import {
  SETTINGS_CARD_CLASS,
  SettingsPageLayout,
  SettingsSectionHeader,
} from "./SettingsPageLayout";

/** Environments measured at once; the backend also bounds its `du` walks. */
const MEASURE_CONCURRENCY = 3;

type Measurement =
  | { state: "pending" }
  | { state: "done"; usage: EnvironmentDiskUsage }
  | { state: "failed"; error: string };

function LocationRow({
  label,
  description,
  value,
  placeholder,
  disabled,
  canPick = true,
  saving,
  onPick,
  onReset,
}: {
  label: string;
  description: React.ReactNode;
  value: string | null;
  placeholder: string;
  disabled?: boolean;
  canPick?: boolean;
  saving: boolean;
  onPick: () => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-2 p-4">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-9 min-w-0 flex-1 items-center rounded-md border border-border/70 bg-input-surface px-3 font-mono text-xs",
            !value && "text-muted-foreground",
          )}
          title={value ?? placeholder}
        >
          <span className="truncate">{value ?? placeholder}</span>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label={`Choose ${label.toLowerCase()}`}
          onClick={onPick}
          disabled={disabled || saving || !canPick}
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Reset ${label.toLowerCase()} to default`}
          title="Use the default location"
          onClick={onReset}
          disabled={disabled || saving || !value}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function WorktreeLocations() {
  const [locations, setLocations] = useState<WorktreeLocationsSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const { machine } = useAccountMachine();
  // The folder picker browses this window's backend, not another machine.
  const canPick = isWindowMachine(machine);

  useEffect(() => {
    let cancelled = false;
    backend
      .getWorktreeLocations(machine)
      .then((result) => {
        if (!cancelled) setLocations(result);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error("Could not load worktree locations", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  const save = async (next: { environments: string | null; dev: string | null }) => {
    setSaving(true);
    try {
      setLocations(await backend.updateWorktreeLocations(next, machine));
    } catch (error) {
      toast.error("Worktree location was not saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!locations) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading locations…
      </div>
    );
  }

  const current = {
    environments: locations.environments.configured,
    dev: locations.dev.configured,
  };
  const pick = async (key: "environments" | "dev", title: string, fallback: string) => {
    const chosen = await pickHostPath({
      mode: "directory",
      title,
      defaultPath: current[key] ?? fallback,
    });
    if (chosen) await save({ ...current, [key]: chosen });
  };
  const override = locations.environments.startupOverride;

  return (
    <div className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800")}>
      <LocationRow
        label="New environment worktrees"
        description={
          override ? (
            <>
              This backend was started with a worktree directory, so new environments go to{" "}
              <span className="font-mono">{override}</span>.
            </>
          ) : (
            "Where new local environments create their worktree. An environment can still pick its own folder when it is created; existing environments stay where they are."
          )
        }
        value={current.environments}
        placeholder={`Default · ${locations.environments.defaultPath}`}
        disabled={!!override}
        canPick={canPick}
        saving={saving}
        onPick={() =>
          void pick(
            "environments",
            "Choose where new environment worktrees go",
            locations.environments.effective,
          )
        }
        onReset={() => void save({ ...current, environments: null })}
      />
      <LocationRow
        label="New dev worktrees"
        description={
          locations.dev.readOnly
            ? "Change this setting in the production app. Development profiles read the production app’s dev worktree location."
            : "Where new development profiles keep their worktrees, in a folder named after the profile. Existing profiles stay where they are."
        }
        disabled={locations.dev.readOnly}
        value={current.dev}
        placeholder={`Default · inside each profile in ${locations.dev.defaultPath}`}
        canPick={canPick}
        saving={saving}
        onPick={() =>
          void pick("dev", "Choose where new dev worktrees go", locations.dev.defaultPath)
        }
        onReset={() => void save({ ...current, dev: null })}
      />
    </div>
  );
}

function EnvironmentUsageRow({
  environment,
  measurement,
  expanded,
  onToggle,
  onMeasured,
}: {
  environment: DiskUsageEnvironmentSummary;
  measurement: Measurement | undefined;
  expanded: boolean;
  onToggle: () => void;
  onMeasured: (usage: EnvironmentDiskUsage) => void;
}) {
  const { machine } = useAccountMachine();
  const usage = measurement?.state === "done" ? measurement.usage : undefined;
  const devCount =
    usage?.dev.profiles.reduce(
      (sum, profile) => sum + (profile.worktreeCount ?? profile.worktrees.length),
      0,
    ) ?? 0;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-900/60"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        {environment.environmentType === "containerized" ? (
          <Container className="h-4 w-4 shrink-0 text-sky-400" aria-label="Container" />
        ) : (
          <Laptop className="h-4 w-4 shrink-0 text-blue-500" aria-label="Local" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">
            {environment.name}
            {environment.projectHome && (
              <span className="ml-2 text-xs text-muted-foreground">project home</span>
            )}
          </span>
          {environment.location && (
            <span
              className="block truncate font-mono text-[11px] text-muted-foreground"
              title={environment.location}
            >
              {environment.location}
            </span>
          )}
        </span>
        {devCount > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {devCount} dev worktree{devCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="w-20 shrink-0 text-right text-sm tabular-nums">
          {!measurement || measurement.state === "pending" ? (
            <Loader2
              className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground"
              aria-label="Measuring"
            />
          ) : measurement.state === "failed" ? (
            <span className="text-xs text-destructive" title={measurement.error}>
              Failed
            </span>
          ) : (
            formatDiskBytes(measurement.usage.totalBytes)
          )}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 bg-zinc-950/60 px-4 py-4 sm:pl-10">
          <EnvironmentDiskUsageBreakdown
            environmentId={environment.environmentId}
            initial={usage}
            onMeasured={onMeasured}
            machine={machine}
          />
        </div>
      )}
    </li>
  );
}

function EnvironmentUsage() {
  const [environments, setEnvironments] = useState<DiskUsageEnvironmentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<Map<string, Measurement>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);
  const generationRef = useRef(0);
  const { machine } = useAccountMachine();

  const measureAll = useCallback(
    async (list: DiskUsageEnvironmentSummary[], refresh: boolean, generation: number) => {
      setMeasurements(new Map(list.map((item) => [item.environmentId, { state: "pending" }])));
      const queue = [...list];
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const id = next.environmentId;
          let result: Measurement;
          try {
            result = {
              state: "done",
              usage: await backend.getEnvironmentDiskUsage(id, refresh, machine),
            };
          } catch (error) {
            result = {
              state: "failed",
              error: error instanceof Error ? error.message : String(error),
            };
          }
          if (generation !== generationRef.current) return;
          setMeasurements((current) => new Map(current).set(id, result));
        }
      };
      await Promise.all(Array.from({ length: MEASURE_CONCURRENCY }, worker));
    },
    [machine],
  );

  // Switching machine clears the previous machine's failure before it reloads;
  // Refresh clears it itself.
  const [loadedMachine, setLoadedMachine] = useState(machine);
  if (loadedMachine !== machine) {
    setLoadedMachine(machine);
    setLoadError(null);
  }

  const load = useCallback(
    (refresh: boolean) => {
      const generation = ++generationRef.current;
      return backend
        .listDiskUsageEnvironments(machine)
        .then(async (list) => {
          if (generation !== generationRef.current) return;
          setEnvironments(list);
          await measureAll(list, refresh, generation);
        })
        .catch((error: unknown) => {
          if (generation === generationRef.current)
            setLoadError(error instanceof Error ? error.message : String(error));
        });
    },
    [machine, measureAll],
  );

  useEffect(() => {
    void load(false);
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  const byProject = useMemo(() => {
    const groups = new Map<string, { name: string; items: DiskUsageEnvironmentSummary[] }>();
    for (const environment of environments ?? []) {
      const group = groups.get(environment.projectId) ?? {
        name: environment.projectName,
        items: [],
      };
      group.items.push(environment);
      groups.set(environment.projectId, group);
    }
    const size = (id: string) => {
      const measurement = measurements.get(id);
      return measurement?.state === "done" ? (measurement.usage.totalBytes ?? 0) : 0;
    };
    return [...groups.entries()]
      .map(([projectId, group]) => ({
        projectId,
        name: group.name,
        items: [...group.items].sort((a, b) => size(b.environmentId) - size(a.environmentId)),
        bytes: group.items.reduce((sum, item) => sum + size(item.environmentId), 0),
      }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [environments, measurements]);

  const measured = [...measurements.values()].filter((item) => item.state !== "pending").length;
  const total = [...measurements.values()].reduce(
    (sum, item) => sum + (item.state === "done" ? (item.usage.totalBytes ?? 0) : 0),
    0,
  );
  const measuring = environments !== null && measured < environments.length;
  const incomplete = [...measurements.values()].some(
    (item) =>
      item.state === "failed" ||
      (item.state === "done" &&
        (item.usage.totalBytes === null || !!item.usage.primary.unavailable)),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <SettingsSectionHeader title="Environments">
          {environments === null
            ? "Loading environments…"
            : measuring
              ? `Measured ${measured} of ${environments.length} · ${formatDiskBytes(total)} so far`
              : `${formatDiskBytes(total)}${incomplete ? " measured (some sizes unavailable)" : ""} across ${environments.length} environment${environments.length === 1 ? "" : "s"}, including dev worktrees`}
        </SettingsSectionHeader>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadError(null);
            void load(true);
          }}
          disabled={environments === null || measuring}
        >
          {measuring ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Refresh
        </Button>
      </div>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      {environments?.length === 0 && (
        <p className="text-sm text-muted-foreground">There are no environments yet.</p>
      )}

      {byProject.map((project) => (
        <div key={project.projectId} className="space-y-1.5">
          <div className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
            <span className="truncate">{project.name}</span>
            <span className="tabular-nums">{formatDiskBytes(project.bytes)}</span>
          </div>
          <ul className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800 overflow-hidden")}>
            {project.items.map((environment) => (
              <EnvironmentUsageRow
                key={environment.environmentId}
                environment={environment}
                measurement={measurements.get(environment.environmentId)}
                expanded={expanded === environment.environmentId}
                onToggle={() =>
                  setExpanded((current) =>
                    current === environment.environmentId ? null : environment.environmentId,
                  )
                }
                onMeasured={(usage) =>
                  setMeasurements((current) =>
                    new Map(current).set(environment.environmentId, { state: "done", usage }),
                  )
                }
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function DiskUsageSettings() {
  return (
    <SettingsPageLayout
      title="Disk usage"
      description="Space used by each environment's worktree or container, and by the dev worktrees of development profiles started from it."
    >
      <div className="space-y-3">
        <SettingsSectionHeader title="Default locations" />
        <WorktreeLocations />
      </div>

      <EnvironmentUsage />
    </SettingsPageLayout>
  );
}
