/**
 * Discovered extensions stay out of the shared bridge for its entire lifetime.
 * Session disposal cannot revoke an extension's timers or process-wide hooks.
 * Local skills and prompt templates remain available; only bridge-owned inline
 * extension factories may run. Configured packages are excluded before the SDK
 * resolves resources, because installation itself can execute lifecycle scripts.
 */
import type { SettingsManager } from "./pi-sdk.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

export const PROJECT_EXTENSIONS_REFUSED_NOTE =
  "Pi runs extensions inside the bridge process, where they could answer approvals themselves, so discovered extensions and configured packages do not load under any approval policy; local project skills and prompt templates still do.";

/** Whether a policy turns project resources on but keeps extensions out. */
export function projectExtensionsRefusedForApprovals(
  policy: Partial<Pick<NativeAgentExecutionPolicy, "approvals" | "projectResources">> | undefined,
  readOnly = false,
): boolean {
  // A read-only session already loads no project resources at all.
  return policy?.projectResources === true && !readOnly;
}

/** Exclude package resolution before the first reload, without writing settings. */
export function excludeConfiguredPackages(settingsManager: SettingsManager): void {
  // noExtensions filters paths only AFTER package resolution. Both scopes must
  // be filtered, including on later reloads, to avoid lifecycle execution.
  for (const key of ["getGlobalSettings", "getProjectSettings"] as const) {
    const read = settingsManager[key].bind(settingsManager);
    settingsManager[key] = () => ({ ...read(), packages: [] });
  }
}
