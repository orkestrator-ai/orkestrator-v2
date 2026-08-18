/**
 * Projects backend-owned environment activity into the small UI store.
 * Resource sync updates `environmentStore`; this hook deliberately owns no
 * clocks, poll leases, provider subscriptions, or persistence side effects.
 */
import { useEffect } from "react";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useAgentActivityStore } from "@/stores/agentActivityStore";

export function useGlobalActivityMonitor(): void {
  const environments = useEnvironmentStore((state) => state.environments);
  const replaceActivitySnapshot = useAgentActivityStore((state) => state.replaceActivitySnapshot);

  useEffect(() => {
    replaceActivitySnapshot(environments);
  }, [environments, replaceActivitySnapshot]);
}
