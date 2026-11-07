import type { EnvironmentAttentionReason } from "@orkestrator/protocol/environment-attention";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { appCommandScope } from "@/lib/node-scope-slots";
import { portalStore } from "@/lib/portal/portal-store";

/** What this client may do with desktop notifications. */
export type DesktopNotificationPermission = NotificationPermission | "unsupported";

/** Notifications kept reachable until closed, so their click handler survives. */
const MAX_OPEN_NOTIFICATIONS = 32;
const open = new Set<Notification>();

function notificationApi(): typeof Notification | null {
  if (typeof window === "undefined") return null;
  return typeof window.Notification === "function" ? window.Notification : null;
}

/**
 * The desktop app grants its own renderer the permission outright; a browser
 * client starts at "default" until the user allows it from Settings.
 */
export function desktopNotificationPermission(): DesktopNotificationPermission {
  return notificationApi()?.permission ?? "unsupported";
}

/** Ask the browser for permission. Call only from a user gesture. */
export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  const api = notificationApi();
  if (!api) return "unsupported";
  if (api.permission !== "default") return api.permission;
  try {
    return await api.requestPermission();
  } catch {
    return api.permission;
  }
}

const COPY: Partial<Record<EnvironmentAttentionReason, string>> = {
  agent_question: "Agent asked a question",
  agent_waiting: "Agent needs your input",
};

/** A local notification is this window's own node's: its environments and projects. */
function environmentLabel(environmentId: string, projectId: string): string | null {
  const scope = appCommandScope();
  const environment = scope
    .store(environmentStore)
    .getState()
    .environments.find((candidate) => candidate.id === environmentId);
  const project = scope
    .store(projectStore)
    .getState()
    .projects.find((candidate) => candidate.id === projectId);
  const name =
    environment?.projectHome && environment.name === "project-home"
      ? "Project home"
      : environment?.name;
  return [project?.name, name].filter(Boolean).join(" · ") || null;
}

/**
 * Opens one of this renderer's own node's environments the way every entry
 * point opens a node (`openMachineWorkspace`, plan item 5001): an ordinary
 * selection of the window's own node.
 */
function openEnvironment(projectId: string, environmentId: string, label: string | null): void {
  // A local notification is this renderer's own node's.
  const scope = appCommandScope();
  const ui = scope.store(uiStore).getState();
  ui.setProjectCollapsed(projectId, false);
  const projectHome = scope
    .store(environmentStore)
    .getState()
    .environments.some((env) => env.id === environmentId && env.projectHome);
  openMachineWorkspace({
    connectionId: portalStore.getState().selfId ?? scope.nodeId,
    projectId,
    environmentId,
    ...(projectHome ? { boardTab: "home" as const } : {}),
    title: label ?? "Environment",
  });
}

/**
 * Shows a desktop notification that an agent is blocked on the user. Names the
 * project and environment only: attention events are content-free and the
 * notification is too. Clicking it brings the window forward and opens the
 * environment. One notification per environment: a newer one (or the same one
 * from another window) replaces it rather than stacking.
 *
 * Another node's environment is not in this window's stores, so `remote` names
 * it and opens it instead. Either way the click goes through
 * `openMachineWorkspace` with the node, project and environment.
 */
export function showQuestionDesktopNotification(input: {
  environmentId: string;
  projectId: string;
  reason: EnvironmentAttentionReason;
  /** True when the app plays its own cue, so the OS need not add one. */
  silent: boolean;
  remote?: { nodeId: string; label: string | null; open: () => void };
}): boolean {
  const api = notificationApi();
  if (!api || api.permission !== "granted") return false;
  const title = COPY[input.reason] ?? "Agent needs your input";
  const remote = input.remote;
  const label = remote ? remote.label : environmentLabel(input.environmentId, input.projectId);
  try {
    const notification = new api(title, {
      body: label ? `${label}: waiting for your answer.` : "An agent is waiting for your answer.",
      tag: remote
        ? `orkestrator-question:${remote.nodeId}:${input.environmentId}`
        : `orkestrator-question:${input.environmentId}`,
      silent: input.silent,
    });
    if (open.size >= MAX_OPEN_NOTIFICATIONS) {
      const oldest = open.values().next().value;
      if (oldest) {
        oldest.close();
        open.delete(oldest);
      }
    }
    open.add(notification);
    const release = () => open.delete(notification);
    notification.addEventListener("close", release);
    notification.addEventListener("error", release);
    notification.addEventListener("click", () => {
      release();
      window.focus();
      if (remote) remote.open();
      else openEnvironment(input.projectId, input.environmentId, label);
      notification.close();
    });
    return true;
  } catch {
    // Some browsers only allow notifications from a service worker.
    return false;
  }
}

export const __testing = {
  openNotifications(): number {
    return open.size;
  },
  reset(): void {
    open.clear();
  },
};
