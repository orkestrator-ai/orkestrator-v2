import { useCallback, useEffect, useRef, useState } from "react";
import { Container, FolderGit2, HardDrive, Loader2, RefreshCw } from "lucide-react";

import { formatBytes, formatRelativeTime } from "@/components/docker/docker-stats-format";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import type { AccountMachine, DiskUsageItem, EnvironmentDiskUsage } from "@/lib/backend";
import { cn } from "@/lib/utils";

export function formatDiskBytes(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? "Unknown" : formatBytes(bytes);
}

/**
 * Loads one environment's disk usage. The backend keeps a recent measurement,
 * so mounting this for an environment the overview already measured is cheap.
 */
export function useEnvironmentDiskUsage(
  environmentId: string,
  options: { enabled?: boolean; initial?: EnvironmentDiskUsage; machine?: AccountMachine } = {},
) {
  const enabled = options.enabled ?? true;
  const machine = options.machine;
  const [usage, setUsage] = useState<EnvironmentDiskUsage | null>(options.initial ?? null);
  const [loading, setLoading] = useState(!options.initial && enabled);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const incomingIdentityRef = useRef<string | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await backend.getEnvironmentDiskUsage(environmentId, refresh, machine);
        if (request !== requestRef.current) return null;
        setUsage(result);
        return result;
      } catch (loadError) {
        if (request === requestRef.current) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
        return null;
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [environmentId, machine],
  );

  const initial = options.initial?.environmentId === environmentId ? options.initial : undefined;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    incomingIdentityRef.current = null;
    usageRef.current = initialRef.current ?? null;
    setUsage(usageRef.current);
    setError(null);
    setLoading(false);
    if (enabled && !initialRef.current) void load(false);
    return () => {
      requestRef.current += 1;
    };
  }, [enabled, load]);

  useEffect(() => {
    if (!initial) return;
    const identity = `${initial.environmentId}:${initial.measuredAt}`;
    if (incomingIdentityRef.current === identity) return;
    incomingIdentityRef.current = identity;
    const current = usageRef.current;
    if (
      current?.environmentId === initial.environmentId &&
      Date.parse(current.measuredAt) > Date.parse(initial.measuredAt)
    )
      return;
    // The overview is authoritative. Retire older requests and explicitly settle
    // loading when it supplies a newer snapshot, rather than relying on finally.
    requestRef.current += 1;
    setUsage(initial);
    setLoading(false);
    setError(null);
  }, [initial]);

  return { usage, loading, error, refresh: () => load(true) };
}

function UsageRow({ item, max }: { item: DiskUsageItem; max: number }) {
  const share = max > 0 && item.bytes ? Math.max(1, Math.round((item.bytes / max) * 100)) : 0;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-x-3 gap-y-1 py-1.5">
      <span className="truncate font-mono text-xs" title={item.path ?? item.label}>
        {item.label}
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">
        {formatDiskBytes(item.bytes)}
      </span>
      <span className="col-span-2 h-1 overflow-hidden rounded-full bg-zinc-800" aria-hidden="true">
        <span className="block h-full rounded-full bg-sky-500/70" style={{ width: `${share}%` }} />
      </span>
    </li>
  );
}

function UsageList({ items }: { items: DiskUsageItem[] }) {
  const max = Math.max(0, ...items.map((item) => item.bytes ?? 0));
  return (
    <ul className="divide-y divide-transparent">
      {items.map((item) => (
        <UsageRow key={`${item.label}:${item.path ?? ""}`} item={item} max={max} />
      ))}
    </ul>
  );
}

function SectionHeader({
  icon,
  title,
  bytes,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  bytes: number | null;
  detail?: string | null;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        {detail && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={detail}>
            {detail}
          </p>
        )}
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums">{formatDiskBytes(bytes)}</span>
    </div>
  );
}

export function EnvironmentDiskUsageView({
  usage,
  loading,
  error,
  onRefresh,
  className,
}: {
  usage: EnvironmentDiskUsage | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  className?: string;
}) {
  if (!usage) {
    return (
      <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Measuring disk usage…
          </>
        ) : (
          <>
            <span className="text-destructive">{error ?? "Disk usage is unavailable."}</span>
            <Button variant="ghost" size="sm" onClick={onRefresh}>
              Retry
            </Button>
          </>
        )}
      </div>
    );
  }

  const { primary, dev } = usage;
  const devWorktreeCount = dev.profiles.reduce(
    (sum, profile) => sum + (profile.worktreeCount ?? profile.worktrees.length),
    0,
  );
  const measuredAt = Math.floor(new Date(usage.measuredAt).getTime() / 1000);

  return (
    <div className={cn("space-y-5", className)}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold tabular-nums">
            {formatDiskBytes(usage.totalBytes)}
          </div>
          <p className="text-xs text-muted-foreground">
            Allocated on disk · measured {formatRelativeTime(measuredAt)}
            {error && <span className="text-destructive"> · {error}</span>}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Refresh
        </Button>
      </div>

      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
        <SectionHeader
          icon={
            primary.kind === "container" ? (
              <Container className="h-4 w-4 text-sky-400" aria-hidden="true" />
            ) : (
              <FolderGit2 className="h-4 w-4 text-sky-400" aria-hidden="true" />
            )
          }
          title={primary.kind === "container" ? "Container" : "Worktree"}
          bytes={primary.bytes}
          detail={primary.path}
        />
        {primary.unavailable && (
          <p className="text-xs text-muted-foreground">{primary.unavailable}</p>
        )}
        {primary.items.length > 0 && <UsageList items={primary.items} />}
        {primary.kind === "container" && (
          <p className="text-[11px] text-muted-foreground">
            The image is shared by every container and is not counted.
          </p>
        )}
      </div>

      {usage.environmentType === "local" && (
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <SectionHeader
            icon={<HardDrive className="h-4 w-4 text-violet-400" aria-hidden="true" />}
            title={`Dev worktrees${devWorktreeCount > 0 ? ` (${devWorktreeCount})` : ""}`}
            bytes={dev.worktreeBytes}
          />
          {dev.profiles.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No development profiles were started from this environment.
            </p>
          ) : (
            dev.profiles.map((profile) => (
              <div key={profile.id} className="space-y-1 border-t border-zinc-800 pt-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate font-mono" title={profile.profileRoot}>
                    {profile.id}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatDiskBytes(profile.bytes)} total · profile data{" "}
                    {formatDiskBytes(profile.stateBytes)}
                  </span>
                </div>
                <p
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={profile.worktreeDir}
                >
                  {profile.worktreeDir}
                </p>
                {profile.worktrees.length > 0 ? (
                  <UsageList items={profile.worktrees} />
                ) : (
                  <p className="text-xs text-muted-foreground">No worktrees in this profile.</p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Self-loading breakdown for one environment. */
export function EnvironmentDiskUsageBreakdown({
  environmentId,
  initial,
  onMeasured,
  machine,
  className,
}: {
  environmentId: string;
  initial?: EnvironmentDiskUsage;
  onMeasured?: (usage: EnvironmentDiskUsage) => void;
  /** The machine the environment is on, from Settings; see `AccountMachine`. */
  machine?: AccountMachine;
  className?: string;
}) {
  const { usage, loading, error, refresh } = useEnvironmentDiskUsage(environmentId, {
    initial,
    machine,
  });
  return (
    <EnvironmentDiskUsageView
      usage={usage}
      loading={loading}
      error={error}
      className={className}
      onRefresh={() => {
        void refresh().then((result) => {
          if (result) onMeasured?.(result);
        });
      }}
    />
  );
}
