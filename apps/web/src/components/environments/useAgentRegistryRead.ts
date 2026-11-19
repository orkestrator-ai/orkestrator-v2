import { useEffect, useState } from "react";
import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import type { AgentSummarySource } from "./EnvironmentAgentSummary";

/** Coalesces a burst of activity edges into one registry read. */
const REFRESH_DEBOUNCE_MS = 250;

/**
 * One environment's agent registry while `open`, read from `source` and read
 * again (debounced) whenever something it is derived from changes. `null`
 * until the first read lands, after a failed read, and while closed: nothing
 * is read or subscribed while closed (a reopen may show the last read until
 * the next one lands). `source` must be stable across renders.
 */
export function useAgentRegistryRead(
  environmentId: string,
  open: boolean,
  source: AgentSummarySource,
  options: { includePending?: boolean } = {},
): AgentRegistrySnapshot | null {
  const [snapshot, setSnapshot] = useState<AgentRegistrySnapshot | null>(null);
  const includePending = options.includePending === true;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const request = ++latest;
      void source
        .read(environmentId, includePending ? { includePending } : undefined)
        .then((result) => {
          // Only the newest read may land: an older one can finish last.
          if (cancelled || request !== latest) return;
          setSnapshot(result);
        })
        .catch(() => {
          if (!cancelled && request === latest) setSnapshot(null);
        });
    };
    const refresh = (immediate = false) => {
      latest++;
      if (timer) clearTimeout(timer);
      if (immediate) read();
      else timer = setTimeout(read, REFRESH_DEBOUNCE_MS);
    };
    const stop = source.subscribe(environmentId, refresh);
    if (!source.resyncOnSubscribe) read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [environmentId, open, source, includePending]);

  return open ? snapshot : null;
}
