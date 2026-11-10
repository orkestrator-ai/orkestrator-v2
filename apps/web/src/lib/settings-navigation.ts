/** Cross-tree navigation into the global settings surface. */
export const GLOBAL_SETTINGS_REQUEST_EVENT = "orkestrator:open-global-settings";

export const GLOBAL_SETTINGS_SECTIONS = [
  "general",
  "version-control",
  "machines",
  "disk-usage",
  "usage",
  "defaults",
  "platforms",
  "coordinator",
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
  "schedules",
  "self-improvement",
  "permissions",
  "sounds",
  "docker",
  "container",
  "experimental",
  "debug",
] as const;

export type GlobalSettingsSection = (typeof GLOBAL_SETTINGS_SECTIONS)[number];

export function isGlobalSettingsSection(value: unknown): value is GlobalSettingsSection {
  return GLOBAL_SETTINGS_SECTIONS.includes(value as GlobalSettingsSection);
}

/**
 * Opens the window's Settings on `section`. Settings belong to the command
 * node, so this is always the window's own surface (`GlobalSettingsHost`).
 * Another node shown in the window's own tree runs in this document and
 * calls it directly (plan item 5003).
 */
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

const GLOBAL_SETTINGS_CLOSE_EVENT = "orkestrator:close-global-settings";

/** Close the global settings surface, for an action inside it that moves the user elsewhere. */
export function requestCloseGlobalSettings(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(GLOBAL_SETTINGS_CLOSE_EVENT));
}

export function onGlobalSettingsCloseRequest(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(GLOBAL_SETTINGS_CLOSE_EVENT, listener);
  return () => window.removeEventListener(GLOBAL_SETTINGS_CLOSE_EVENT, listener);
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

const MACHINE_UPDATE_REQUEST_EVENT = "orkestrator:update-machine";
let machineUpdatePending: string | null = null;

/**
 * Opens Settings → Machines with "Update to the latest Orkestrator" for one
 * machine (its node identity; the command node's own for itself): the
 * action a version-skewed machine header and a typed incompatibility error
 * lead to (plan item 5006). A machine Settings cannot update from here opens
 * its updates instead, which say why.
 */
export function requestMachineUpdate(nodeId: string): void {
  if (typeof window === "undefined" || !nodeId) return;
  machineUpdatePending = nodeId;
  window.dispatchEvent(new Event(MACHINE_UPDATE_REQUEST_EVENT));
  requestGlobalSettings("machines");
}

/** The machine a request is waiting for; reading it clears it. */
export function takeMachineUpdateRequest(): string | null {
  const pending = machineUpdatePending;
  machineUpdatePending = null;
  return pending;
}

export function onMachineUpdateRequest(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(MACHINE_UPDATE_REQUEST_EVENT, listener);
  return () => window.removeEventListener(MACHINE_UPDATE_REQUEST_EVENT, listener);
}
