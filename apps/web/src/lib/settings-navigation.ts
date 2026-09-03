/** Cross-tree navigation into the global settings surface. */
export const GLOBAL_SETTINGS_REQUEST_EVENT = "orkestrator:open-global-settings";

export const GLOBAL_SETTINGS_SECTIONS = [
  "general",
  "defaults",
  "platforms",
  "review",
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "skills",
  "terminal",
  "network",
  "web-client",
  "mcp",
  "messaging",
  "container",
  "experimental",
  "debug",
] as const;

export type GlobalSettingsSection = (typeof GLOBAL_SETTINGS_SECTIONS)[number];

export function isGlobalSettingsSection(value: unknown): value is GlobalSettingsSection {
  return GLOBAL_SETTINGS_SECTIONS.includes(value as GlobalSettingsSection);
}

export function requestGlobalSettings(section: GlobalSettingsSection): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<GlobalSettingsSection>(GLOBAL_SETTINGS_REQUEST_EVENT, { detail: section }),
  );
}

export function onGlobalSettingsRequest(
  listener: (section: GlobalSettingsSection) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const section = (event as CustomEvent<unknown>).detail;
    if (isGlobalSettingsSection(section)) listener(section);
  };
  window.addEventListener(GLOBAL_SETTINGS_REQUEST_EVENT, handle);
  return () => window.removeEventListener(GLOBAL_SETTINGS_REQUEST_EVENT, handle);
}
