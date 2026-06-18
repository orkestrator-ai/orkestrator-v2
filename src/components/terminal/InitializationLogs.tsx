import { useEffect, useRef, useState } from "react";
import { listen } from "@/lib/native/events";
import { getContainerLogs, streamContainerLogs } from "@/lib/tauri";
import { Loader2, Terminal as TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContainerLogPayload {
  container_id: string;
  text: string;
}

interface InitializationLogsProps {
  containerId: string;
  className?: string;
}

/**
 * Displays container initialization logs during the "creating" phase.
 * Shows the actual Docker container output so users can see what's happening
 * during environment startup.
 */
const MAX_LOG_LINES = 500;

export function InitializationLogs({ containerId, className }: InitializationLogsProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  // Fetch initial logs and start streaming
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const setup = async () => {
      try {
        // Get initial logs (last 100 lines)
        const initialLogs = await getContainerLogs(containerId, "100");
        if (initialLogs) {
          // Split by newline and filter empty lines
          const lines = initialLogs.split("\n").filter(line => line.length > 0);
          setLogs(lines.slice(-MAX_LOG_LINES));
        }
        setIsLoading(false);

        // Start streaming new logs
        await streamContainerLogs(containerId);

        // Listen for new log events
        const unlisten = await listen<ContainerLogPayload>("container-log", (event) => {
          if (event.payload.container_id === containerId) {
            const newLines = event.payload.text.split("\n").filter(line => line.length > 0);
            setLogs(prev => {
              const updated = [...prev, ...newLines];
              // Keep only the last MAX_LOG_LINES to prevent memory growth
              return updated.length > MAX_LOG_LINES ? updated.slice(-MAX_LOG_LINES) : updated;
            });
          }
        });

        unsubscribe = unlisten;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        console.error("[InitializationLogs] Error setting up logs:", errorMessage);
        setError(`Failed to load container logs: ${errorMessage}`);
        setIsLoading(false);
      }
    };

    setup();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [containerId]);

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        <span className="text-sm font-medium">Initializing Container</span>
      </div>

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
