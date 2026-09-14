import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type SVGProps,
} from "react";
import { CircuitBoard, Cpu, HardDrive, MemoryStick, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getEnvironmentProcessUsage,
  getSystemUsage,
  type EnvironmentProcessGroup,
  type EnvironmentProcessUsageSnapshot,
  type SystemUsageSnapshot,
} from "@/lib/backend";
import { useProjectStore } from "@/stores";
import { cn } from "@/lib/utils";
import {
  isSystemUsageFresh,
  SYSTEM_USAGE_STALE_AFTER_MS,
  SystemUsagePanel,
} from "./AgentInfoButton.panels";

/** Cadence for the always-mounted title-bar meters. */
export const SYSTEM_USAGE_POLL_INTERVAL_MS = 5_000;

/** Cadence for the process list while the popover is open. */
export const ENVIRONMENT_PROCESS_POLL_INTERVAL_MS = 3_000;

const SECRET_FLAG_PATTERN =
  /(--(?:token|api-?key|password|passwd|secret|authorization|auth-token)|-p)(=|\s+)\S+/gi;
const AUTHORIZATION_HEADER_PATTERN = /\bAuthorization\s+\S+/gi;
const MAX_COMMAND_DISPLAY_LENGTH = 240;

/** Redact known secret flags before a command is shown in a tooltip. */
export function sanitizeProcessCommand(command: string): string {
  const redacted = command
    .replace(SECRET_FLAG_PATTERN, (_, flag: string, separator: string) => `${flag}${separator}***`)
    .replace(AUTHORIZATION_HEADER_PATTERN, "Authorization ***");
  if (redacted.length <= MAX_COMMAND_DISPLAY_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_COMMAND_DISPLAY_LENGTH)}…`;
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value)}%` : "—";
}

/** Process RSS as whole MB, or GB with one decimal only when it is not a whole number. */
export function formatProcessRamKb(rssKb: number): string {
  const megabytes = rssKb / 1024;
  if (!Number.isFinite(megabytes) || megabytes < 1024) {
    return `${Math.round(Number.isFinite(megabytes) ? Math.max(0, megabytes) : 0)} MB`;
  }
  const gigabytes = Math.round((megabytes / 1024) * 10) / 10;
  return Number.isInteger(gigabytes) ? `${gigabytes} GB` : `${gigabytes.toFixed(1)} GB`;
}

/** Summed process CPU for ranking an environment group. */
export function environmentProcessGroupCpu(group: EnvironmentProcessGroup): number {
  return typeof group.totalCpuPercent === "number"
    ? group.totalCpuPercent
    : group.processes.reduce((total, process) => total + process.cpuPercent, 0);
}

/** Summed process RSS for an environment group total. */
export function environmentProcessGroupRamKb(group: EnvironmentProcessGroup): number {
  return typeof group.totalRssKb === "number"
    ? group.totalRssKb
    : group.processes.reduce((total, process) => total + process.rssKb, 0);
}

/** Selected process count, including rows omitted by snapshot bounds. */
export function environmentProcessGroupCount(group: EnvironmentProcessGroup): number {
  return typeof group.processCount === "number" ? group.processCount : group.processes.length;
}

/** Highest-CPU environments first; name then id break ties so the open-time order is stable. */
export function sortEnvironmentProcessGroupsByCpu(
  groups: readonly EnvironmentProcessGroup[],
): EnvironmentProcessGroup[] {
  return [...groups].sort((left, right) => {
    const cpuDelta = environmentProcessGroupCpu(right) - environmentProcessGroupCpu(left);
    if (cpuDelta !== 0) return cpuDelta;
    const nameDelta = left.environmentName.localeCompare(right.environmentName);
    if (nameDelta !== 0) return nameDelta;
    return left.environmentId.localeCompare(right.environmentId);
  });
}

/**
 * Keep the order captured when the panel first received environments.
 * Later polls update the same rows in place; newcomers append by current CPU.
 * A poll that returns a subset still consults `frozenIds` so a later full
 * snapshot can restore the original open-time ranking.
 */
export function orderEnvironmentProcessGroups(
  groups: readonly EnvironmentProcessGroup[],
  frozenIds: readonly string[] | null,
): EnvironmentProcessGroup[] {
  if (groups.length === 0) return [];
  if (frozenIds === null || frozenIds.length === 0) {
    return sortEnvironmentProcessGroupsByCpu(groups);
  }
  const remaining = new Map(groups.map((group) => [group.environmentId, group]));
  const ordered: EnvironmentProcessGroup[] = [];
  for (const id of frozenIds) {
    const group = remaining.get(id);
    if (!group) continue;
    ordered.push(group);
    remaining.delete(id);
  }
  if (remaining.size > 0) {
    ordered.push(...sortEnvironmentProcessGroupsByCpu([...remaining.values()]));
  }
  return ordered;
}

/** Grow-only id list: seed from the first ranking, then append newcomers. */
export function mergeFrozenEnvironmentIds(
  frozenIds: readonly string[],
  groups: readonly EnvironmentProcessGroup[],
): string[] {
  if (groups.length === 0) return [...frozenIds];
  if (frozenIds.length === 0) {
    return sortEnvironmentProcessGroupsByCpu(groups).map((group) => group.environmentId);
  }
  const seen = new Set(frozenIds);
  const newcomers = groups.filter((group) => !seen.has(group.environmentId));
  if (newcomers.length === 0) return [...frozenIds];
  return [
    ...frozenIds,
    ...sortEnvironmentProcessGroupsByCpu(newcomers).map((group) => group.environmentId),
  ];
}

interface UsageMetric {
  key: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  value: number | null | undefined;
}

/**
 * Compact CPU/RAM/GPU/disk readouts for the desktop title bar.
 *
 * Clicking any meter opens a popover that lists child processes for each
 * running environment, grouped by environment, with live CPU and RAM.
 * The same host CPU/RAM/GPU/disk readings from the title bar are repeated
 * under the Process usage title, in the header above the divider. Each
 * environment shows summed CPU and RAM to the right of its name, and the
 * selected process count in brackets after the Process column title.
 * Environments are ranked by total CPU when the panel first loads and then
 * stay in that order while it remains open.
 * Host meters keep polling whether the panel is open; `isSystemUsageFresh`
 * is the same staleness rule the agent-information popover uses.
 */
export function SystemUsageIndicator({ className }: { className?: string }) {
  const [usage, setUsage] = useState<SystemUsageSnapshot | null>(null);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  const close = useCallback(() => {
    restoreFocusRef.current = true;
    setOpen(false);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const clearTimer = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    const schedule = () => {
      clearTimer();
      if (!active || document.visibilityState === "hidden") return;
      timer = window.setTimeout(refresh, SYSTEM_USAGE_POLL_INTERVAL_MS);
    };
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const snapshot = await getSystemUsage();
        if (active && snapshot) {
          setUsage(snapshot);
          setCheckedAt(Date.now());
        }
      } catch {
        // Resource meters are supplementary. Keep the last authoritative
        // snapshot if a transient backend request fails.
        if (active) setCheckedAt(Date.now());
      } finally {
        if (active) schedule();
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        clearTimer();
        return;
      }
      void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    void refresh();
    return () => {
      active = false;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [close, open]);

  const freshUsage = isSystemUsageFresh(usage, checkedAt) ? usage : null;
  const metrics: UsageMetric[] = [
    {
      key: "cpu",
      label: "Central processing unit (CPU) usage",
      icon: Cpu,
      value: freshUsage?.cpuPercent,
    },
    {
      key: "ram",
      label: "Random-access memory (RAM) usage",
      icon: MemoryStick,
      value: freshUsage?.ramPercent,
    },
    {
      key: "gpu",
      label: "Graphics processing unit (GPU) usage",
      icon: CircuitBoard,
      value: freshUsage?.gpuPercent,
    },
    {
      key: "disk",
      label: "Disk storage usage",
      icon: HardDrive,
      value: freshUsage?.diskPercent,
    },
  ];

  return (
    <div
      className={cn("relative flex items-center", className)}
      data-testid="system-usage-indicator"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="flex items-center gap-1.5 rounded-md px-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={open ? "Close environment process usage" : "Open environment process usage"}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="environment-process-usage-popover"
      >
        {metrics.map(({ key, label, icon: Icon, value }) => {
          const formatted = formatPercent(value);
          return (
            <span
              key={key}
              role="img"
              aria-label={`${label}: ${formatted}`}
              title={`${label}: ${formatted}`}
              className="flex items-center gap-0.5 font-mono text-[10px] tabular-nums"
            >
              <Icon className="h-3 w-3" aria-hidden="true" />
              <span>{formatted}</span>
            </span>
          );
        })}
      </button>

      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default bg-transparent"
          onClick={close}
          aria-label="Close environment process usage"
        />
      ) : null}

      <section
        id="environment-process-usage-popover"
        role="dialog"
        aria-label="Environment process usage"
        aria-hidden={!open}
        className={cn(
          "absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(calc(100vw-1rem),28rem)] origin-top-right overflow-hidden rounded-xl border border-border/80 bg-popover/98 shadow-[0_22px_70px_rgba(0,0,0,0.52)] backdrop-blur-xl transition duration-150",
          open
            ? "visible scale-100 opacity-100"
            : "pointer-events-none invisible scale-95 opacity-0",
        )}
      >
        <header className="border-b border-border/60 px-4 py-3.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
                Environments
              </div>
              <h2 className="mt-1 truncate text-sm font-semibold text-foreground">Process usage</h2>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1 -mt-1 h-7 w-7 shrink-0 text-muted-foreground"
              onClick={close}
              aria-label="Close environment process usage"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          {open ? (
            <div className="mt-3">
              <SystemUsagePanel usage={usage} checkedAt={checkedAt} heading={false} />
            </div>
          ) : null}
        </header>
        <div className="max-h-[min(76vh,42rem)] overflow-y-auto p-4">
          {open ? <EnvironmentProcessPanel /> : null}
        </div>
      </section>
    </div>
  );
}

function EnvironmentProcessPanel() {
  const [snapshot, setSnapshot] = useState<EnvironmentProcessUsageSnapshot | null>(null);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [frozenIds, setFrozenIds] = useState<string[]>([]);
  const projects = useProjectStore((state) => state.projects);

  useEffect(() => {
    let active = true;
    let requestPending = false;
    let timer: number | undefined;
    const refresh = async () => {
      if (requestPending) return;
      requestPending = true;
      try {
        const next = await getEnvironmentProcessUsage();
        if (active && next) {
          setSnapshot(next);
          setCheckedAt(Date.now());
        }
      } catch {
        if (active) setCheckedAt(Date.now());
      } finally {
        requestPending = false;
        if (active) timer = window.setTimeout(refresh, ENVIRONMENT_PROCESS_POLL_INTERVAL_MS);
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const sampledAt = snapshot ? Date.parse(snapshot.sampledAt) : Number.NaN;
  const fresh =
    Number.isFinite(sampledAt) && checkedAt - sampledAt <= SYSTEM_USAGE_STALE_AFTER_MS
      ? snapshot
      : null;
  const stale = snapshot !== null && fresh === null;
  const rawGroups = fresh?.environments ?? snapshot?.environments ?? [];
  const groups = orderEnvironmentProcessGroups(rawGroups, frozenIds);

  useEffect(() => {
    const nextGroups = snapshot?.environments ?? [];
    if (nextGroups.length === 0) return;
    setFrozenIds((current) => {
      const next = mergeFrozenEnvironmentIds(current, nextGroups);
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [snapshot]);

  if (snapshot === null) {
    return <p className="text-xs text-muted-foreground">Loading processes…</p>;
  }

  if (groups.length === 0) {
    return <p className="text-xs text-muted-foreground">No running environment processes</p>;
  }

  return (
    <div className="space-y-4">
      {stale ? (
        <p
          className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70"
          role="status"
        >
          Data unavailable
        </p>
      ) : null}
      {snapshot.truncated ? (
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
          List truncated
        </p>
      ) : null}
      {groups.map((group) => (
        <EnvironmentProcessGroupList
          key={group.environmentId}
          group={group}
          projectName={projects.find((project) => project.id === group.projectId)?.name}
        />
      ))}
    </div>
  );
}

function EnvironmentProcessGroupList({
  group,
  projectName,
}: {
  group: EnvironmentProcessGroup;
  projectName?: string;
}) {
  const subtitle = [projectName, group.environmentType === "local" ? "local" : "container"]
    .filter(Boolean)
    .join(" · ");
  const totalCpu = formatPercent(environmentProcessGroupCpu(group));
  const totalRam = formatProcessRamKb(environmentProcessGroupRamKb(group));
  const processCount = environmentProcessGroupCount(group);
  return (
    <section aria-label={`${group.environmentName} processes`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="truncate text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
          {group.environmentName}
        </h3>
        <div
          className="flex shrink-0 items-baseline gap-2 font-mono text-[10px] tabular-nums text-muted-foreground/70"
          role="group"
          aria-label={`${group.environmentName} total usage: ${totalCpu} CPU, ${totalRam} RAM`}
        >
          <span className="w-10 text-right">{totalCpu}</span>
          <span className="w-14 text-right">{totalRam}</span>
        </div>
      </div>
      {subtitle ? (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60">{subtitle}</p>
      ) : null}
      {processCount === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No processes</p>
      ) : (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
            <span className="min-w-0 flex-1">Process ({processCount})</span>
            <span className="w-10 text-right">CPU</span>
            <span className="w-14 text-right">RAM</span>
          </div>
          <ul className="space-y-1">
            {group.processes.map((process) => (
              <li
                key={`${group.environmentId}-${process.pid}`}
                className="flex items-center gap-2 text-xs"
                title={sanitizeProcessCommand(process.command)}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                  {process.name}
                </span>
                <span className="w-10 text-right font-mono tabular-nums text-muted-foreground">
                  {formatPercent(process.cpuPercent)}
                </span>
                <span className="w-14 text-right font-mono tabular-nums text-muted-foreground">
                  {formatProcessRamKb(process.rssKb)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
