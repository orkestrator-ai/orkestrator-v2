import { lazy, useState, type ComponentProps } from "react";
import type { AgentNativeTab } from "@/components/native-agent";

type AgentNativeTabComponent = typeof AgentNativeTab;

let loadedAgentNativeTab: AgentNativeTabComponent | undefined;
let loadingAgentNativeTab: Promise<AgentNativeTabComponent> | undefined;

/**
 * Fetch the native agent tab's code without rendering it. Safe to call often:
 * every caller shares one request, and a failed one can be tried again.
 */
export function loadAgentNativeTab(): Promise<AgentNativeTabComponent> {
  loadingAgentNativeTab ??= import("@/components/native-agent").then(
    (module) => (loadedAgentNativeTab = module.AgentNativeTab),
    (error: unknown) => {
      loadingAgentNativeTab = undefined;
      throw error;
    },
  );
  return loadingAgentNativeTab;
}

const SuspendingAgentNativeTab = lazy(async () => ({ default: await loadAgentNativeTab() }));

/**
 * The native agent tab, loaded the first time one is shown. It carries the chat
 * transcript, markdown and find code, so a surface that is mounted at startup
 * must use this rather than a static import: one static importer anywhere in the
 * startup graph pulls all of it back into the startup bundle.
 *
 * Once the code is in hand (a preload, or an earlier tab) the tab renders
 * directly. A `lazy` component that has never rendered suspends on its first
 * render even when its module is already loaded, and React then holds the
 * loading skeleton for its minimum reveal time: a new environment's agent tab
 * blinked to a skeleton and back between two views of the same prompt. The
 * choice is made once per mount, so a mounted tab never changes component type
 * (which would remount it and lose its state).
 */
export function LazyAgentNativeTab(props: ComponentProps<AgentNativeTabComponent>) {
  const [Loaded] = useState(() => loadedAgentNativeTab);
  return Loaded ? <Loaded {...props} /> : <SuspendingAgentNativeTab {...props} />;
}
