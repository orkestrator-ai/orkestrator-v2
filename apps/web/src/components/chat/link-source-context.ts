import { createContext } from "react";

/**
 * The environment and tab whose agent wrote the links below. Present only in
 * an environment's agent tab; a link elsewhere (coordinator, mail) has no
 * environment to resolve a loopback address in, so it offers no preview tab.
 */
export const PreviewLinkSourceContext = createContext<{
  environmentId: string;
  tabId: string;
} | null>(null);
