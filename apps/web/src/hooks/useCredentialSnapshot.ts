import { useCallback, useEffect, useRef, useState } from "react";
import type { CredentialTabSnapshot } from "@orkestrator/protocol/agent-credentials";
import { backendForScope } from "@/lib/backend/scope-backend";
import { useNodeScope } from "@/lib/node-scope/providers";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/**
 * One agent tab's credential requests and grants, read from the backend of
 * the node the tab runs on (docs/architecture/agent-credentials.md). Re-read
 * on every `credential` hint for the environment or the saved connections,
 * on resync and on the safety cadence, so a tab that was hidden or remounted
 * shows the same pending requests: the backend snapshot is authoritative.
 * Out-of-order reads are dropped.
 */
export function useCredentialSnapshot(
  environmentId: string | undefined,
  tabId: string | undefined,
): { snapshot: CredentialTabSnapshot | null; refresh: () => void } {
  const scope = useNodeScope();
  const key = environmentId && tabId ? `${environmentId}\0${tabId}` : null;
  const [state, setState] = useState<{ key: string; snapshot: CredentialTabSnapshot } | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!key || !environmentId || !tabId) return;
    let disposed = false;
    let sequence = 0;
    const reread = () => {
      const request = ++sequence;
      void backendForScope(scope)
        .getCredentialSnapshot({ environmentId, tabId })
        .then((snapshot) => {
          if (!disposed && request === sequence) setState({ key, snapshot });
        })
        .catch(() => undefined);
    };
    refreshRef.current = reread;
    reread();
    const offChange = onResourceChanged(
      "credential",
      (change) => {
        if (change.id === environmentId || change.id === "connections") reread();
      },
      scope,
    );
    const offSafety = onViewSafetyCheck(reread, scope);
    const offResync = onResourceResync(reread, scope);
    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      offChange();
      offSafety();
      offResync();
    };
  }, [scope, key, environmentId, tabId]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { snapshot: state && state.key === key ? state.snapshot : null, refresh };
}
