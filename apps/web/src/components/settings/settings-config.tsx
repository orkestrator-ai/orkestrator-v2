/** Settings keeps independently targeted config separate from the workspace store. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import * as backend from "@/lib/backend";
import { subscribeNodeEvents } from "@/lib/federation/node-events";
import type { BackendId } from "@orkestrator/protocol/federation";
import { RESOURCE_CHANGED_EVENT, isResourceChange } from "@orkestrator/protocol/resource-events";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { configStore, useConfigStore } from "@/stores";
import type { AppConfig } from "@/types";
import { Button } from "@/components/ui/button";
import { isWindowMachine } from "./account-machine";
import { errorText } from "./machines/machine-ui";
import { SettingsPageLayout } from "./SettingsPageLayout";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.settings");

interface SettingsConfigValue {
  config: AppConfig;
  setConfig: (config: AppConfig) => void;
  ready: boolean;
}

const MachineConfigContext = createContext<SettingsConfigValue | null>(null);

export function useSettingsConfig(): SettingsConfigValue {
  const machineConfig = useContext(MachineConfigContext);
  const config = useConfigStore((state) => state.config);
  const setConfig = useConfigStore((state) => state.setConfig);
  return machineConfig ?? { config, setConfig, ready: true };
}

/** Only this window's backend can use its effective config store. */
export function MachineConfigProvider({
  machine,
  connected,
  includeUnavailable,
  children,
}: {
  machine: string | null | undefined;
  connected?: boolean;
  includeUnavailable?: boolean;
  children: ReactNode;
}) {
  if (!machine || isWindowMachine(machine)) return <>{children}</>;
  return (
    <RemoteMachineConfig
      key={machine}
      machine={machine}
      connected={connected}
      includeUnavailable={includeUnavailable}
    >
      {children}
    </RemoteMachineConfig>
  );
}

function RemoteMachineConfig({
  machine,
  connected,
  includeUnavailable,
  children,
}: {
  machine: string;
  connected?: boolean;
  includeUnavailable?: boolean;
  children: ReactNode;
}) {
  const [config, setLocalConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { scope } = useScopesWithCommandFallback();
  const windowConfig = useConfigStore((state) => state.config);
  const refresh = useCallback(() => setAttempt((current) => current + 1), []);
  const request = useRef(0);
  const hasConfig = useRef(false);
  const [settledConnection, setSettledConnection] = useState(connected);
  const [seenConnection, setSeenConnection] = useState(connected);
  if (seenConnection !== connected) {
    setSeenConnection(connected);
    setSettledConnection(undefined);
  }

  useEffect(() => {
    if (connected === false) return;
    const id = ++request.current;
    let active = true;
    backend.getConfig(machine).then(
      (loaded) => {
        if (!active || id !== request.current) return;
        hasConfig.current = true;
        setLocalConfig(loaded);
        setError(null);
        setSettledConnection(connected);
      },
      (cause: unknown) => {
        if (!active || id !== request.current) return;
        setError(errorText(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [machine, attempt, connected]);

  useEffect(() => {
    const stops = [
      onResourceChanged("config", refresh, scope),
      onViewSafetyCheck(refresh, scope),
      onResourceResync(({ resources }) => {
        if (!resources || resources.has("config")) refresh();
      }, scope),
    ];
    if (connected !== false) {
      let first = true;
      stops.push(
        subscribeNodeEvents(machine as BackendId, {
          events: [RESOURCE_CHANGED_EVENT],
          onEvent: (_event, change) => {
            if (isResourceChange(change) && change.resource === "config") refresh();
          },
          onResync: () => {
            // Repair the initial read if it completed before the relay attached.
            // A first failed read remains visible with its manual Retry action.
            if (!first || hasConfig.current) refresh();
            first = false;
          },
        }),
      );
    }
    return () => {
      for (const stop of stops) stop();
    };
  }, [machine, refresh, scope, connected]);

  // Re-read inherited preferences through the workspace split so leaf-owned
  // settings and repositories remain in the window store.
  const setConfig = useCallback(
    (next: AppConfig) => {
      request.current++;
      setLocalConfig(next);
      backend.getConfig().then(scope.store(configStore).getState().setConfig, (cause: unknown) => {
        log.error("config.reload-failed", { error: formatLogError(cause) });
      });
    },
    [scope],
  );

  const ready = Boolean(config && !error && connected !== false && settledConnection === connected);
  const value = useMemo(
    () => ({ config: config ?? windowConfig, setConfig, ready }),
    [config, windowConfig, setConfig, ready],
  );
  const unavailable = connected === false ? "This machine is disconnected." : error;
  return (
    <MachineConfigContext.Provider value={value}>
      {!includeUnavailable && unavailable ? (
        <SettingsPageLayout role="alert" className="space-y-2 text-sm text-failure">
          <p>This machine's settings could not be read: {unavailable}</p>
          {connected !== false ? (
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              Retry
            </Button>
          ) : null}
        </SettingsPageLayout>
      ) : null}
      {!includeUnavailable && !unavailable && !ready ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {includeUnavailable ? (
        children
      ) : config ? (
        <div hidden={!ready} inert={!ready} className="h-full">
          {children}
        </div>
      ) : null}
    </MachineConfigContext.Provider>
  );
}
