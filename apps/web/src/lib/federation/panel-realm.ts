/**
 * A machine panel is a separate renderer realm bound to one machine: on the
 * desktop a child view with its own connection scope, in a hosted browser a
 * same-origin frame with its own direct gateway session. The realm renders
 * one workspace and never hosts further panels or a multi-machine sidebar.
 */

export type PanelRealmTarget = { projectId: string; environmentId?: string };

const PANEL_PARAM = "panel";
const PANEL_VALUE = "workspace";

function params(): URLSearchParams | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
}

export function isMachinePanelRealm(): boolean {
  return params()?.get(PANEL_PARAM) === PANEL_VALUE;
}

export function machinePanelTarget(): PanelRealmTarget | null {
  const search = params();
  if (search?.get(PANEL_PARAM) !== PANEL_VALUE) return null;
  const projectId = search.get("project");
  if (!projectId || projectId.length > 256) return null;
  const environmentId = search.get("environment");
  return {
    projectId,
    ...(environmentId && environmentId.length <= 256 ? { environmentId } : {}),
  };
}

/** Same-origin URL of a panel realm for a hosted-browser frame. */
export function browserPanelUrl(input: {
  machineId: string;
  projectId: string;
  environmentId?: string;
}): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(PANEL_PARAM, PANEL_VALUE);
  url.searchParams.set("machine", input.machineId);
  url.searchParams.set("project", input.projectId);
  if (input.environmentId) url.searchParams.set("environment", input.environmentId);
  return url.toString();
}

/** The hosted-browser machine a panel frame belongs to. */
export function browserPanelMachineId(): string | null {
  const machine = params()?.get("machine");
  return machine && machine.length <= 128 ? machine : null;
}
