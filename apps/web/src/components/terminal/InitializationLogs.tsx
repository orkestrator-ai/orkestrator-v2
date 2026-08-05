import { useEffect, useRef, useState } from "react";
import { getContainerLogs } from "@/lib/backend";
import { Loader2, Terminal as TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface InitializationLogsProps {
  containerId: string;
  className?: string;
  /** Override only for deterministic tests; production refreshes once a second. */
  pollIntervalMs?: number;
}

/**
 * Displays container initialization logs during the "creating" phase.
 * Shows the actual Docker container output so users can see what's happening
 * during environment startup.
 */
const MAX_LOG_LINES = 500;
/**
 * A single dropped poll is routine — the daemon is busy, the container is
 * restarting. Several in a row means the tail on screen is no longer tracking
 * the container, and the header's spinner would otherwise keep claiming it is.
 */
const STALE_LOG_FAILURE_THRESHOLD = 3;

export function InitializationLogs({
  containerId,
  className,
  pollIntervalMs = 1_000,
}: InitializationLogsProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  // Docker is the durable log buffer. Refresh from its authoritative tail so
  // remounts recover everything still in the bounded snapshot without relying
  // on a renderer-owned follower process or a gap-prone live event stream.
  useEffect(() => {
    let disposed = false;
    let refreshInFlight = false;
    let consecutiveFailures = 0;
    const refresh = async (initial: boolean) => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const snapshot = await getContainerLogs(containerId, String(MAX_LOG_LINES));
        if (disposed) return;
        const snapshotLines = snapshot
          ? snapshot.split("\n").filter(line => line.length > 0)
          : [];
        consecutiveFailures = 0;
        setLogs(snapshotLines.slice(-MAX_LOG_LINES));
        setError(null);
        setIsStale(false);
        setIsLoading(false);
      } catch (err) {
        if (disposed) return;
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        if (initial) {
          console.error("[InitializationLogs] Error loading logs:", errorMessage);
          setError(`Failed to load container logs: ${errorMessage}`);
          setIsLoading(false);
          return;
        }
        // A later failure keeps the last good tail — it is still the best view
        // of the container — but says so rather than presenting stale output
        // under a spinner that implies it is live.
        consecutiveFailures += 1;
        if (consecutiveFailures === STALE_LOG_FAILURE_THRESHOLD) {
          console.warn(
            "[InitializationLogs] Container logs stopped refreshing:",
            errorMessage,
          );
        }
        if (consecutiveFailures >= STALE_LOG_FAILURE_THRESHOLD) setIsStale(true);
      } finally {
        refreshInFlight = false;
      }
    };

    void refresh(true);
    const interval = setInterval(() => void refresh(false), pollIntervalMs);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [containerId, pollIntervalMs]);

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        <span className="text-sm font-medium">Initializing Container</span>
      </div>

      {isStale && !error && (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-300"
        >
          Container logs stopped refreshing. The output below may be out of date.
        </div>
      )}

      {/* Log content */}
      <div className="flex-1 overflow-auto p-4 font-mono text-xs">
        {error ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <TerminalIcon className="h-8 w-8 mx-auto mb-2 opacity-50 text-red-400" />
              <p className="text-red-400">{error}</p>
            </div>
          </div>
        ) : isLoading && logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <TerminalIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>Loading container logs...</p>
            </div>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <TerminalIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>Waiting for container output...</p>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {logs.map((line, index) => (
              <div
                key={index}
                className={cn(
                  "whitespace-pre-wrap break-all leading-relaxed",
                  // Color code based on content
                  line.includes("ERROR") || line.includes("error") || line.includes("Failed") || line.includes("failed")
                    ? "text-red-400"
                    : line.includes("WARNING") || line.includes("Warning") || line.includes("warning")
                    ? "text-yellow-400"
                    : line.includes("===") || line.includes(">>>")
                    ? "text-blue-400 font-semibold"
                    : line.includes("success") || line.includes("Success") || line.includes("ready") || line.includes("Ready")
                    ? "text-green-400"
                    : "text-foreground/80"
                )}
              >
                {line}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
