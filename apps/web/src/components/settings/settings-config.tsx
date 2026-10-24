/**
 * The config the Settings form edits.
 *
 * For the command node it is the app's own config store, as everywhere else
 * in the window. Another machine's config never enters that store, which the
 * rest of the window keeps reading: Settings holds a copy of it here, read
 * and saved through the command node.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import * as backend from "@/lib/backend";
import { useConfigStore } from "@/stores";
import type { AppConfig } from "@/types";
import { errorText } from "./machines/machine-ui";

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

/** Load `machine`'s config for the sections inside; `null` keeps the app's own. */
export function MachineConfigProvider({
  machine,
  children,
}: {
  machine: string | null;
  children: ReactNode;
}) {
  if (machine === null) return <>{children}</>;
  return <RemoteMachineConfig machine={machine}>{children}</RemoteMachineConfig>;
}

function RemoteMachineConfig({ machine, children }: { machine: string; children: ReactNode }) {
  const [config, setLocalConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, [machine]);

  // A save may have changed preferences the command node owns and hands down;
  // its own config, which the window uses, is read again to pick them up.
  const setConfig = useCallback((next: AppConfig) => {
    setLocalConfig(next);
    backend.getConfig(null).then(useConfigStore.getState().setConfig, (cause: unknown) => {
      console.error("[settings] Failed to reload the command node's config:", cause);
    });
  }, []);

  const value = useMemo(() => (config ? { config, setConfig } : null), [config, setConfig]);

  if (error) {
    return (
      <p role="alert" className="max-w-2xl text-sm text-red-400">
        This machine's settings could not be read: {error}
      </p>
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
