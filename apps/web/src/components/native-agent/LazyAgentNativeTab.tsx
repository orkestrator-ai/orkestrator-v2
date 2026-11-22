import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import type { AgentNativeTab } from "@/components/native-agent";
import { importNativeAgentTab } from "./launch-view-imports";

type AgentNativeTabComponent = typeof AgentNativeTab;

let loadedAgentNativeTab: AgentNativeTabComponent | undefined;
let loadingAgentNativeTab: Promise<AgentNativeTabComponent> | undefined;

/**
 * Fetch the native agent tab's code without rendering it. Safe to call often:
 * every caller shares one request, and a failed one can be tried again.
 */
export function loadAgentNativeTab(): Promise<AgentNativeTabComponent> {
  loadingAgentNativeTab ??= importNativeAgentTab()
    .then((view) => (loadedAgentNativeTab = view))
    .catch((error: unknown) => {
      loadingAgentNativeTab = undefined;
      throw error;
    });
  return loadingAgentNativeTab;
}

/**
 * The native agent tab, loaded the first time one is shown. It carries the chat
 * transcript, markdown and find code, so a surface that is mounted at startup
 * must use this rather than a static import: one static importer anywhere in the
 * startup graph pulls all of it back into the startup bundle.
 *
 * A preload lets the tab render on the first pass, without a flash of the
 * loading skeleton between two views of the same prompt. A cold mount
 * adopts the loaded component once and keeps its identity through updates.
 * A rejected import reaches the caller's error boundary and a later mount
 * can try again.
 */
export function LazyAgentNativeTab({
  loadingFallback,
  ...props
}: ComponentProps<AgentNativeTabComponent> & { loadingFallback: ReactNode }) {
  const [Loaded, setLoaded] = useState(() => loadedAgentNativeTab);
  const [failure, setFailure] = useState<{ error: unknown }>();
  useEffect(() => {
    if (Loaded) return;
    let mounted = true;
    void loadAgentNativeTab().then(
      (view) => {
        if (mounted) setLoaded(() => view);
      },
      (error: unknown) => {
        if (mounted) setFailure({ error });
      },
    );
    return () => {
      mounted = false;
    };
  }, [Loaded]);
  if (failure) throw failure.error;
  return Loaded ? <Loaded {...props} /> : loadingFallback;
}
