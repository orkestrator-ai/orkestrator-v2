/**
 * A machine panel is a separate renderer realm bound to one other node's
 * workspace, reached with a short-lived client grant from the command node
 * (directly, or relayed through it). On the desktop it is a child view with
 * its own connection scope; in a browser or the iOS app it is a same-origin
 * frame. The realm renders one workspace and never hosts further panels or
 * a multi-machine sidebar.
 */

import type { WorkspaceConnectionPath } from "@/lib/portal/workspaces";

export type PanelRealmTarget = { projectId?: string; environmentId?: string };

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
  // No project: the machine's own project launcher (e.g. to add a project).
  if (!projectId || projectId.length > 256) return {};
  const environmentId = search.get("environment");
  return {
    projectId,
    ...(environmentId && environmentId.length <= 256 ? { environmentId } : {}),
  };
}

function bounded(value: string | null, max = 64): string | undefined {
  return value && value.length <= max ? value : undefined;
}

/**
 * How this panel realm reaches its node, for the info panel. Non-secret: it
 * travels in the realm's URL.
 */
export function machinePanelConnectionPath(): WorkspaceConnectionPath | null {
  const search = params();
  if (search?.get(PANEL_PARAM) !== PANEL_VALUE) return null;
  const path = search.get("path");
  const nodeName = bounded(search.get("node"));
  if ((path !== "direct" && path !== "relay") || !nodeName) return null;
  const route = search.get("route");
  const via = bounded(search.get("via"));
  return {
    nodeName,
    path,
    ...(route === "https" || route === "ssh" ? { routeKind: route } : {}),
    ...(via ? { via } : {}),
  };
}

/** Same-origin URL of a panel realm for a frame (hosted browser, iOS). */
export function browserPanelUrl(input: {
  workspaceId: string;
  connection: WorkspaceConnectionPath;
  projectId?: string;
  environmentId?: string;
}): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(PANEL_PARAM, PANEL_VALUE);
  url.searchParams.set("workspace", input.workspaceId);
  url.searchParams.set("node", input.connection.nodeName);
  url.searchParams.set("path", input.connection.path);
  if (input.connection.routeKind) url.searchParams.set("route", input.connection.routeKind);
  if (input.connection.via) url.searchParams.set("via", input.connection.via);
  if (input.projectId) url.searchParams.set("project", input.projectId);
  if (input.environmentId) url.searchParams.set("environment", input.environmentId);
  return url.toString();
}

/** The workspace a frame realm belongs to (its grant is in this tab's session storage). */
export function browserPanelWorkspaceId(): string | null {
  const workspace = params()?.get("workspace");
  return workspace && workspace.length <= 128 ? workspace : null;
}
