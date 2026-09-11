import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountQuotaList } from "@/components/layout/AgentInfoButton.panels";
import { getPlanUsage } from "@/lib/backend";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

/**
 * Provider plan/quota shown at the top of a platform's settings pane.
 *
 * OpenCode's read is a cheap HTTPS request, so it loads on mount. Claude, Codex
 * and Cursor reads each spawn a short-lived bridge — and Claude's in turn spawns
 * a whole Claude CLI — so those are read on demand, keeping a process spawn off
 * the pane-switch path and behind the refresh control.
 */
export function PlanUsageSection({ platform }: { platform: AgentPlatform }) {
  const autoLoad = platform === "opencode";
  const [snapshot, setSnapshot] = useState<PlanUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(autoLoad);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(
    async (force = false) => {
      const requestId = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const next = await getPlanUsage(platform, { force });
        if (requestId !== requestRef.current) return;
        setSnapshot(next);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setError(err instanceof Error ? err.message : "Could not load plan usage");
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [platform],
  );

  useEffect(() => {
    if (autoLoad) void load();
    return () => {
      requestRef.current += 1;
    };
  }, [autoLoad, load]);

  const windows = snapshot?.windows ?? [];
  const message = error ?? (snapshot?.status === "error" ? snapshot.message : null);
  const unavailable = snapshot?.status === "unavailable" ? snapshot.message : null;

  return (
    <section
      aria-label="Plan usage"
      className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Plan usage</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            How much of this account&apos;s plan has been used in each quota window.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label="Refresh plan usage"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="mt-4">
        {message ? (
          <p className="flex items-start gap-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {message}
          </p>
        ) : unavailable ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{unavailable}</p>
        ) : loading && !snapshot ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking plan usage…
          </div>
        ) : windows.length > 0 ? (
          <>
            <AccountQuotaList account={windows} />
            {snapshot ? (
              <p className="mt-3 text-[10px] text-muted-foreground/70">
                Updated {new Date(snapshot.fetchedAt).toLocaleTimeString()}
              </p>
            ) : null}
          </>
        ) : !snapshot && !autoLoad ? (
          <p className="text-xs text-muted-foreground">
            Plan usage is read on demand so this pane does not start an agent process. Use refresh
            to check it.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            This account does not report any metered plan limits.
          </p>
        )}
      </div>
    </section>
  );
}
