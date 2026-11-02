import {
  readStoredApplicationLogPolicy,
  type InstalledApplicationLogging,
} from "@orkestrator/protocol/node/application-logging";
import { applyApplicationLogPolicy } from "@orkestrator/protocol/node/log-policy";
import { RESOURCE_CHANGED_EVENT, type ResourceChange } from "@orkestrator/protocol/resource-events";

/** Main-process policy handler, shared by the stdout relay and resource-event fallback. */
export function createLiveLogPolicy(options: {
  dataDir: string;
  logging: Pick<InstalledApplicationLogging, "updateSettings"> | null;
  env?: NodeJS.ProcessEnv;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}) {
  let cancelCheck: (() => void) | undefined;
  const schedule =
    options.schedule ??
    ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const apply = (audit?: () => void) => {
    const policy = readStoredApplicationLogPolicy(options.dataDir);
    if (policy) applyApplicationLogPolicy(policy, options.logging, audit, options.env);
    else audit?.();
  };
  return {
    apply,
    onEvent(event: string, payload: unknown) {
      if (
        event !== RESOURCE_CHANGED_EVENT ||
        (payload as ResourceChange | null)?.resource !== "config"
      )
        return;
      // Do not overtake the audit on stdout: disabling saving before it arrives
      // loses the line that explains the change. This fallback is for a dropped line.
      cancelCheck?.();
      cancelCheck = schedule(() => {
        cancelCheck = undefined;
        apply();
      }, 2_000);
    },
    dispose() {
      cancelCheck?.();
      cancelCheck = undefined;
    },
  };
}
