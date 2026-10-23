import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import * as backend from "@/lib/backend";
import { subscribeNativeObservationInvalidations } from "@/lib/native-observation-events";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";
import {
  describeAgentRegistrySummary,
  type AgentRegistryEnvironmentSummary,
  type AgentRegistrySnapshot,
} from "@orkestrator/protocol/agent-registry";

/** Coalesces a burst of activity edges into one registry read. */
const REFRESH_DEBOUNCE_MS = 250;

/** Where an environment's agent registry is read from, and what invalidates it. */
export interface AgentSummarySource {
  read(environmentId: string): Promise<AgentRegistrySnapshot>;
  /** Calls `refresh` whenever the environment's registry may have changed. */
  subscribe(environmentId: string, refresh: () => void): () => void;
}

/** This window's own backend. */
export const LOCAL_AGENT_SUMMARY_SOURCE: AgentSummarySource = {
  read: (environmentId) => backend.getAgentRegistry({ environmentId }),
  subscribe(environmentId, refresh) {
    const stops = [
      subscribeNativeObservationInvalidations((invalidation) => {
        if (invalidation.kind === "all" || invalidation.environmentId === environmentId) refresh();
      }),
      onResourceChanged("environment", (change) => {
        if (change.id === environmentId) refresh();
      }),
      onResourceChanged("pane-layout", (change) => {
        if (change.id === environmentId) refresh();
      }),
      onResourceResync(() => refresh()),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  },
};

/**
 * "3 agent tabs · 1 working" for an environment's hover card.
 *
 * Read from the backend agent registry when the card opens, and again while it
 * stays open whenever something the registry is derived from changes: a native
 * session's activity, the environment (which carries tmux activity), its tabs,
 * or a resync. Right for environments that are not on screen, and free while
 * the card is closed. Another machine's environments pass that machine's
 * source; `source` must be stable across renders.
 */
export function EnvironmentAgentSummary({
  environmentId,
  open,
  source = LOCAL_AGENT_SUMMARY_SOURCE,
}: {
  environmentId: string;
  open: boolean;
  source?: AgentSummarySource;
}) {
  const [summary, setSummary] = useState<AgentRegistryEnvironmentSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const request = ++latest;
      void source
        .read(environmentId)
        .then((snapshot) => {
          // Only the newest read may land: an older one can finish last.
          if (cancelled || request !== latest) return;
          setSummary(
            snapshot.environments.find((item) => item.environmentId === environmentId) ?? null,
          );
        })
        .catch(() => {
          if (!cancelled && request === latest) setSummary(null);
        });
    };
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, REFRESH_DEBOUNCE_MS);
    };
    read();
    const stop = source.subscribe(environmentId, refresh);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [environmentId, open, source]);

  if (!summary) return null;
  return (
    <p className="text-xs text-muted-foreground flex items-center gap-1">
      <Bot className="h-3 w-3" />
      {describeAgentRegistrySummary(summary)}
    </p>
  );
}
