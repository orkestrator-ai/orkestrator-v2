import { useEffect, useState } from "react";
import { dockerClient } from "@orkestrator/protocol/contract/domains/docker";
import {
  machineBackendClient,
  scopeBackendClient,
  type AccountMachine,
} from "@/lib/backend/client";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";

/**
 * Whether Docker runs on another machine, for the build launcher's Container
 * choice. `null` while it is unknown (not asked, loading); an unreadable
 * answer is `false`, so a machine that cannot be asked is never offered a
 * container it may not be able to run.
 *
 * Pass `enabled: false` for this tab's own machine: its availability comes
 * from `useDockerAvailability`.
 */
export function useMachineDockerAvailability(
  machine: AccountMachine,
  enabled: boolean,
): boolean | null {
  const { scope } = useScopesWithCommandFallback();
  const [answer, setAnswer] = useState<{
    scope: unknown;
    machine: AccountMachine;
    available: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const client = machineBackendClient(scopeBackendClient(scope), machine);
    domainApi(client, dockerClient)
      .checkDocker()
      .then((result) => result.available === true)
      .catch(() => false)
      .then((available) => {
        if (active) setAnswer({ scope, machine, available });
      });
    return () => {
      active = false;
    };
  }, [enabled, machine, scope]);

  if (!enabled || !answer || answer.scope !== scope || answer.machine !== machine) return null;
  return answer.available;
}
