import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import * as backend from "@/lib/backend";
import { subscribeNativeObservationInvalidations } from "@/lib/native-observation-events";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";
import {
  describeAgentRegistrySummary,
  type AgentRegistryEnvironmentSummary,
} from "@orkestrator/protocol/agent-registry";

/** Coalesces a burst of activity edges into one registry read. */
const REFRESH_DEBOUNCE_MS = 250;

/**
 * "3 agent tabs · 1 working" for an environment's hover card.
 *
 * Read from the backend agent registry when the card opens, and again while it
 * stays open whenever something the registry is derived from changes: a native
 * session's activity, the environment (which carries tmux activity), its tabs,
 * or a resync. Right for environments that are not on screen, and free while
 * the card is closed.
 */
export function EnvironmentAgentSummary({
  environmentId,
  open,
}: {
  environmentId: string;
  open: boolean;
}) {
  const [summary, setSummary] = useState<AgentRegistryEnvironmentSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const request = ++latest;
      void backend
        .getAgentRegistry({ environmentId })
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
      cancelled = true;
      if (timer) clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }, [environmentId, open]);

  if (!summary) return null;
  return (
    <p className="text-xs text-muted-foreground flex items-center gap-1">
      <Bot className="h-3 w-3" />
      {describeAgentRegistrySummary(summary)}
    </p>
  );
}
