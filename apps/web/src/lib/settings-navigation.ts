/** Cross-tree navigation into the global settings surface. */
export const GLOBAL_SETTINGS_REQUEST_EVENT = "orkestrator:open-global-settings";

export const GLOBAL_SETTINGS_SECTIONS = [
  "general",
  "machines",
  "disk-usage",
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
  "previews",
  "mcp",
  "mcp-servers",
  "messaging",
  "sounds",
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

const MACHINE_UPDATES_REQUEST_EVENT = "orkestrator:open-machine-updates";
let machineUpdatesPending = false;

/** Opens Settings → Machines with the updates of the machine this window works on. */
export function requestCurrentMachineUpdates(): void {
  if (typeof window === "undefined") return;
  machineUpdatesPending = true;
  window.dispatchEvent(new Event(MACHINE_UPDATES_REQUEST_EVENT));
  requestGlobalSettings("machines");
}

/** Whether a request is waiting; reading it clears it. */
export function takeMachineUpdatesRequest(): boolean {
  const pending = machineUpdatesPending;
  machineUpdatesPending = false;
  return pending;
}

export function onMachineUpdatesRequest(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(MACHINE_UPDATES_REQUEST_EVENT, listener);
  return () => window.removeEventListener(MACHINE_UPDATES_REQUEST_EVENT, listener);
}
