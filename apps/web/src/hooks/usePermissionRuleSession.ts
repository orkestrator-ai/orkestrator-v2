import { useEffect, useRef, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentPermissionRule,
  PermissionRuleApplication,
} from "@orkestrator/protocol/permission-rules";

import { listPermissionRules } from "@/lib/backend";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

const EMPTY_APPLICATIONS: PermissionRuleApplication[] = [];
const EMPTY_RULES: NativeAgentPermissionRule[] = [];

/**
 * The Orkestrator permission rules (todo 0723) and the approvals they answered
 * in one session, read from the backend that owns them. Re-read on every
 * `permission-rule` hint (a rule saved, removed or used) and on any resync, so
 * a hidden or remounted tab shows the same notes. Out-of-order reads are
 * dropped.
 */
export function usePermissionRuleSession(
  environmentId: string | undefined,
  agent: AgentPlatform | undefined,
  logicalSessionKey: string | undefined,
): {
  applications: PermissionRuleApplication[];
  rules: NativeAgentPermissionRule[];
  refresh: () => void;
} {
  const key =
    environmentId && agent && logicalSessionKey
      ? `${environmentId}\0${agent}\0${logicalSessionKey}`
      : null;
  const [state, setState] = useState<{
    key: string;
    applications: PermissionRuleApplication[];
    rules: NativeAgentPermissionRule[];
  } | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!key || !environmentId || !agent || !logicalSessionKey) return;
    let disposed = false;
    let sequence = 0;
    const reread = () => {
      const request = ++sequence;
      void listPermissionRules({ environmentId, agent, logicalSessionKey })
        .then((snapshot) => {
          if (!disposed && request === sequence) {
            setState({ key, applications: snapshot.applications, rules: snapshot.rules });
          }
        })
        .catch(() => undefined);
    };
    refreshRef.current = reread;
    reread();
    const offChange = onResourceChanged("permission-rule", reread);
    const offSafety = onViewSafetyCheck(reread);
    const offResync = onResourceResync(reread);
    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      offChange();
      offSafety();
      offResync();
    };
  }, [agent, environmentId, key, logicalSessionKey]);

  const current = state && state.key === key ? state : null;
  return {
    applications: current?.applications ?? EMPTY_APPLICATIONS,
    rules: current?.rules ?? EMPTY_RULES,
    refresh: () => refreshRef.current(),
  };
}
