/** Settings keeps independently targeted config separate from the workspace store. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import * as backend from "@/lib/backend";
import { useConfigStore } from "@/stores";
import type { AppConfig } from "@/types";
import { Button } from "@/components/ui/button";
import { isWindowMachine } from "./account-machine";
import { errorText } from "./machines/machine-ui";
import { SettingsPageLayout } from "./SettingsPageLayout";

interface SettingsConfigValue {
  config: AppConfig;
  setConfig: (config: AppConfig) => void;
}

const MachineConfigContext = createContext<SettingsConfigValue | null>(null);

export function useSettingsConfig(): SettingsConfigValue {
  const machineConfig = useContext(MachineConfigContext);
  const config = useConfigStore((state) => state.config);
  const setConfig = useConfigStore((state) => state.setConfig);
  return machineConfig ?? { config, setConfig };
}

/** Only this window's backend can use its effective config store. */
export function MachineConfigProvider({
  machine,
  children,
}: {
  machine: string | null | undefined;
  children: ReactNode;
}) {
  if (machine === undefined || isWindowMachine(machine)) return <>{children}</>;
  return (
    <RemoteMachineConfig key={machine ?? "command-node"} machine={machine}>
      {children}
    </RemoteMachineConfig>
  );
}

function RemoteMachineConfig({
  machine,
  children,
}: {
  machine: string | null;
  children: ReactNode;
}) {
  const [config, setLocalConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    backend.getConfig(machine).then(
      (loaded) => {
        if (!cancelled) setLocalConfig(loaded);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [machine, attempt]);

  // Re-read inherited preferences through the workspace split so leaf-owned
  // settings and repositories remain in the window store.
  const setConfig = useCallback((next: AppConfig) => {
    setLocalConfig(next);
    backend.getConfig().then(useConfigStore.getState().setConfig, (cause: unknown) => {
      console.error("[settings] Failed to reload the workspace config:", cause);
    });
  }, []);

  const value = useMemo(() => (config ? { config, setConfig } : null), [config, setConfig]);

  if (error) {
    return (
      <SettingsPageLayout role="alert" className="space-y-2 text-sm text-red-400">
        <p>This machine's settings could not be read: {error}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null);
            setAttempt((current) => current + 1);
          }}
        >
          Retry
        </Button>
      </SettingsPageLayout>
    );
  }
  if (!value) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <MachineConfigContext.Provider value={value}>{children}</MachineConfigContext.Provider>;
}
