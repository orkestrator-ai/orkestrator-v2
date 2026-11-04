import { lazy } from "react";

/**
 * The native agent tab, loaded the first time one is shown. It carries the chat
 * transcript, markdown and find code, so a surface that is mounted at startup
 * must use this rather than a static import: one static importer anywhere in the
 * startup graph pulls all of it back into the startup bundle.
 */
export const LazyAgentNativeTab = lazy(async () => ({
  default: (await import("@/components/native-agent")).AgentNativeTab,
}));
