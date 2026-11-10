import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type {
  DatabaseFileSummary,
  DatabaseStats,
  DatabaseTopTables,
} from "@orkestrator/protocol/backend-diagnostics";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useAccountMachine } from "./account-machine";

export function formatDiagnosticsBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

function fileLine(file: DatabaseFileSummary): string {
  return [
    formatDiagnosticsBytes(file.fileBytes),
    `write-ahead log ${formatDiagnosticsBytes(file.walBytes)}`,
    file.freelistBytes === null ? null : `free ${formatDiagnosticsBytes(file.freelistBytes)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function DatabaseFile({
  label,
  file,
  tables,
  missing,
}: {
  label: string;
  file: DatabaseFileSummary | null;
  tables: DatabaseTopTables | null;
  missing: string;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{file ? fileLine(file) : missing}</p>
      </div>
      {tables && tables.tables.length > 0 ? (
        <ul aria-label={`Largest tables in ${label}`} className="space-y-0.5">
          {tables.tables.slice(0, 5).map((table) => (
            <li
              key={table.name}
              className="flex justify-between gap-3 text-xs text-muted-foreground"
            >
              <span className="min-w-0 truncate font-mono">{table.name}</span>
              <span className="shrink-0">{formatDiagnosticsBytes(table.bytes)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {tables?.stores && tables.stores.length > 0 ? (
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">
            Inside <span className="font-mono">store_rows</span>, by store
          </p>
          <ul aria-label={`Largest stores in ${label}`} className="space-y-0.5">
            {tables.stores.slice(0, 5).map((store) => (
              <li
                key={store.family}
                className="flex justify-between gap-3 pl-3 text-xs text-muted-foreground"
              >
                <span className="min-w-0 truncate font-mono">{store.family}</span>
                <span className="shrink-0">
                  {`${formatDiagnosticsBytes(store.bytes)} · ${store.rows} ${store.rows === 1 ? "row" : "rows"}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function retentionLine(stats: DatabaseStats): string {
  const { retention } = stats;
  if (!retention) return "Change retention has not run since this backend started";
  if (retention.outcome === "failed") {
    return `Last change retention failed at ${formatTime(retention.at)}`;
  }
  const report = retention.report;
  return report
    ? `Last change retention ${formatTime(retention.at)}: ${formatDiagnosticsBytes(report.storedBytes)} stored, ${formatDiagnosticsBytes(report.removedBytes)} removed`
    : `Last change retention ${formatTime(retention.at)}`;
}

/**
 * The databases' sizes, what fills them, backups and retention, fetched when the
 * Debug page opens: figures can be a minute old, and the top tables as old as
 * the last backup copy.
 */
export function DatabaseStorageCard() {
  const { machine } = useAccountMachine();
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const requestRef = useRef(0);

  // Switching machine shows that machine's figures, never the last one's.
  const [loadedMachine, setLoadedMachine] = useState(machine);
  if (loadedMachine !== machine) {
    setLoadedMachine(machine);
    setStats(null);
    setIsLoading(true);
  }

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    let next: DatabaseStats | null = null;
    try {
      next = await backend.getDatabaseStats(machine);
    } catch {
      // A backend older than this command, or one that cannot answer.
    }
    if (request !== requestRef.current) return;
    setStats(next);
    setIsLoading(false);
  }, [machine]);
  const refresh = useCallback(() => {
    setIsLoading(true);
    return load();
  }, [load]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const hasTopTables = Boolean(stats?.topTables.main || stats?.topTables.ledger);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Database</p>
          <p className="text-xs text-muted-foreground mt-1" aria-live="polite">
            {isLoading && !stats
              ? "Reading database figures…"
              : stats
                ? "File sizes, free space and what fills them"
                : "Database figures unavailable"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => void refresh()}
          disabled={isLoading}
          aria-label="Refresh database figures"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
        </Button>
      </div>
      {stats ? (
        <div className="space-y-3">
          <DatabaseFile
            label="Main database"
            file={stats.main}
            tables={stats.topTables.main}
            missing="No file yet"
          />
          <DatabaseFile
            label="Change-tracking database"
            file={stats.ledger}
            tables={stats.topTables.ledger}
            missing="No file yet"
          />
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {stats.backups.count === 0
                ? "No backups yet"
                : `${stats.backups.count} ${stats.backups.count === 1 ? "backup" : "backups"}, ${formatDiagnosticsBytes(stats.backups.bytes)}${stats.backups.newestAt ? `, newest ${formatTime(stats.backups.newestAt)}` : ""}`}
            </p>
            <p>{retentionLine(stats)}</p>
            {hasTopTables ? null : (
              <p>Largest tables appear after the next backup copy of a changed database.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
