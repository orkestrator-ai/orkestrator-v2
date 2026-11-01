/**
 * A workspace realm is the central workspace of one other node, embedded in
 * a window that stays on its command node.
 *
 * The window (title bar, toolbar, sidebar, settings, the portal) never leaves
 * the command node. Opening an environment of another node shows that node's
 * workspace in the window's central region instead: on the desktop a child
 * view with its own connection scope, in a browser or the iOS app a
 * same-origin frame. Either way the realm runs this client's own code against
 * the node's workspace grant, so its stores, events and credentials reach only
 * that node, and the window never reloads.
 *
 * The realm and its window talk only through the small messages below.
 */

import { isAppShortcutId, type AppShortcutId } from "@orkestrator/protocol/keyboard-shortcuts";

const REALM_PARAM = "realm";
const REALM_VALUE = "workspace";
const MAX_ID_LENGTH = 256;
const MAX_PANEL_INSET = 4096;

/**
 * The title-bar popovers of a realm's node. The window's title bar shows
 * their triggers, as it does for its own node; the realm draws the popovers,
 * whose content comes from its node, under that title bar.
 */
export type RealmPanel = "usage" | "agent";

/** The realm's node's host meters, for the window's title bar. */
export interface RealmUsageReading {
  cpuPercent: number;
  ramPercent: number;
  gpuPercent: number | null;
  diskPercent: number | null;
  sampledAt: string;
}

/** The window's title bar asking a realm to open or close one of its popovers. */
export interface RealmPanelRequest {
  /** Increases with every request, so the same request twice is applied twice. */
  seq: number;
  open: boolean;
  /** Distance from the realm's right edge to the trigger's, so the popover lines up with it. */
  inset: number;
}

/** A realm title-bar popover driven by the window's title bar, which owns its trigger. */
export interface RealmPanelControl {
  request: RealmPanelRequest | null;
  onOpenChange: (open: boolean) => void;
  /** User dismissal, rather than a replacement or shell-driven close. */
  onDismiss?: () => void;
}

/** Explicit board navigation overrides a node's default project landing tab. */
export type RealmBoardTab = "home" | "coordinator" | "kanban" | "github" | "linear" | "features";

function boardTab(value: unknown): RealmBoardTab | undefined {
  return value === "home" ||
    value === "coordinator" ||
    value === "kanban" ||
    value === "github" ||
    value === "linear" ||
    value === "features"
    ? value
    : undefined;
}

/** How the window's sidebar groups machines' projects. */
export type RealmGrouping = "machine" | "project" | "repository" | "activity";

function isRealmGrouping(value: unknown): value is RealmGrouping {
  return (
    value === "machine" || value === "project" || value === "repository" || value === "activity"
  );
}

/**
 * Whether a realm's coordinator defers to the command node's. Grouped by
 * repository, the window links each repository's projects across machines,
 * so coordination for it runs on the command node where it can. Grouped by
 * machine, project or activity the machines are not linked, and a node's own
 * coordinator opens directly.
 */
export function realmCoordinatorDefers(grouping: RealmGrouping | null): boolean {
  return grouping === null || grouping === "repository";
}

/**
 * The tab a project opens on from its entry in the window's sidebar. The
 * command node's projects open on their coordinator. Another node's open on
 * its own coordinator too, except where that coordinator defers to the
 * command node's (grouped by repository): there they open on their home.
 */
export function projectLandingTab(
  grouping: RealmGrouping | null,
  onCommandNode: boolean,
): "home" | "coordinator" {
  return !onCommandNode && realmCoordinatorDefers(grouping) ? "home" : "coordinator";
}

/**
 * What a sidebar project entry asks the node to show, as board navigation:
 * the coordinator where it lands there, nothing where it lands on the home,
 * which is where another node's realm opens a project by default.
 */
export function projectLandingBoardTab(
  grouping: RealmGrouping | null,
  onCommandNode: boolean,
): RealmBoardTab | undefined {
  return projectLandingTab(grouping, onCommandNode) === "coordinator" ? "coordinator" : undefined;
}

/**
 * A dialog of the realm's node, opened over what the request selects: the
 * project's for the project dialogs, the environment's for its settings.
 * `environment-rebuild` is the environment's settings on its Container
 * section, where Rebuild (keep work) is; a node that predates it drops the
 * dialog and only selects the environment.
 */
export type RealmDialog =
  "repository-settings" | "delete-project" | "environment-settings" | "environment-rebuild";

function realmDialog(value: unknown): RealmDialog | undefined {
  return value === "repository-settings" ||
    value === "delete-project" ||
    value === "environment-settings" ||
    value === "environment-rebuild"
    ? value
    : undefined;
}

/** Whether the dialog is one of an environment's rather than a project's. */
export function isEnvironmentDialog(dialog: RealmDialog): boolean {
  return dialog === "environment-settings" || dialog === "environment-rebuild";
}

/** What the window asks its realm to show. */
export interface RealmSelectRequest {
  type: "select";
  projectId?: string;
  environmentId?: string;
  boardTab?: RealmBoardTab;
  /** Open the node's Add Project dialog. */
  addProject?: true;
  /** Open the node's New Environment dialog for this project. */
  createEnvironmentProjectId?: string;
  /** Open one of the node's dialogs for the selected project or environment. */
  dialog?: RealmDialog;
  /** Open the node's Report a bug sheet, which runs its agent on that node. */
  bugReport?: true;
}

export type ShellToRealmMessage =
  | RealmSelectRequest
  /** The window's sidebar was shown or hidden (the realm's toolbar toggles it). */
  | { type: "sidebar"; open: boolean }
  /** How the window's sidebar groups machines' projects; see `realmCoordinatorDefers`. */
  | { type: "grouping"; grouping: RealmGrouping }
  /** The window's title bar opened or closed one of the realm's popovers. */
  | {
      type: "panel";
      panel: RealmPanel;
      open: boolean;
      inset: number;
      /** Window-assigned sequence, echoed by the realm after application. */
      seq?: number;
      /** Return native keyboard focus to the shell after user dismissal. */
      restoreFocus?: boolean;
    };

/** What a realm tells its window. */
export type RealmToShellMessage =
  /** The realm listens for requests now; anything asked while it loaded is sent again. */
  | { type: "ready" }
  /** The realm's own selection changed (a new environment, a deleted one, a shortcut). */
  | { type: "selection"; projectId: string | null; environmentId: string | null }
  /** Open a project or environment of any node, as the window's sidebar would. */
  | {
      type: "open";
      nodeId: string;
      projectId: string;
      environmentId?: string;
      boardTab?: RealmBoardTab;
      title: string;
    }
  /** Show or hide the window's sidebar. */
  | { type: "sidebar"; open: boolean }
  /** Open the window's settings: they belong to the command node. */
  | { type: "settings"; section: string }
  /**
   * Open a Report a bug sheet on another machine: the command node's own
   * (`nodeId` null) or another node's, in that node's realm.
   */
  | { type: "bugReport"; nodeId: string | null }
  /** A user dismissed the popover opened by this request. */
  | { type: "panelDismissed"; panel: RealmPanel; seq: number }
  /** A window-owned app shortcut (⌘K search) was typed in the realm; see `APP_SHORTCUTS`. */
  | { type: "shortcut"; shortcut: AppShortcutId }
  /** What the window's title bar shows for this node: its host meters and open popover. */
  | {
      type: "titleBar";
      usage: RealmUsageReading | null;
      usageStale: boolean;
      panel: RealmPanel | null;
      /** Last applied window panel request; absent in older realms. */
      requestSeq?: number;
    };

function params(): URLSearchParams | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
}

function isRealmPanel(value: unknown): value is RealmPanel {
  return value === "usage" || value === "agent";
}

function sequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUsageReading(value: unknown): RealmUsageReading | null {
  if (!value || typeof value !== "object") return null;
  const reading = value as Record<string, unknown>;
  const cpuPercent = finiteNumber(reading.cpuPercent);
  const ramPercent = finiteNumber(reading.ramPercent);
  const sampledAt = reading.sampledAt;
  if (cpuPercent === null || ramPercent === null) return null;
  if (typeof sampledAt !== "string" || sampledAt.length > 64) return null;
  return {
    cpuPercent,
    ramPercent,
    gpuPercent: finiteNumber(reading.gpuPercent),
    diskPercent: finiteNumber(reading.diskPercent),
    sampledAt,
  };
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : undefined;
}

/** Whether this renderer is a realm inside a command node's window. */
export function isWorkspaceRealm(): boolean {
  return params()?.get(REALM_PARAM) === REALM_VALUE;
}

/** Browser and iOS frames: the workspace whose grant this realm uses. */
export function realmWorkspaceId(): string | null {
  const search = params();
  if (search?.get(REALM_PARAM) !== REALM_VALUE) return null;
  return boundedId(search.get("workspace")) ?? null;
}

/** Query parameters that open a realm on `request`. */
export function realmSearchParams(request: Omit<RealmSelectRequest, "type">): URLSearchParams {
  const search = new URLSearchParams();
  search.set(REALM_PARAM, REALM_VALUE);
  if (request.projectId) search.set("project", request.projectId);
  if (request.environmentId) search.set("environment", request.environmentId);
  if (request.boardTab) search.set("boardTab", request.boardTab);
  if (request.addProject) search.set("addProject", "1");
  if (request.createEnvironmentProjectId)
    search.set("createEnvironment", request.createEnvironmentProjectId);
  if (request.dialog) search.set("dialog", request.dialog);
  if (request.bugReport) search.set("bugReport", "1");
  return search;
}

/** What the realm was opened on, from its URL. */
export function realmInitialRequest(): RealmSelectRequest | null {
  const search = params();
  if (search?.get(REALM_PARAM) !== REALM_VALUE) return null;
  const request = parseShellMessage({
    type: "select",
    projectId: search.get("project") ?? undefined,
    environmentId: search.get("environment") ?? undefined,
    boardTab: search.get("boardTab") ?? undefined,
    addProject: search.get("addProject") === "1" ? true : undefined,
    createEnvironmentProjectId: search.get("createEnvironment") ?? undefined,
    dialog: search.get("dialog") ?? undefined,
    bugReport: search.get("bugReport") === "1" ? true : undefined,
  });
  return request?.type === "select" ? request : null;
}

export function parseShellMessage(value: unknown): ShellToRealmMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type === "sidebar") {
    return typeof message.open === "boolean" ? { type: "sidebar", open: message.open } : null;
  }
  if (message.type === "grouping") {
    return isRealmGrouping(message.grouping)
      ? { type: "grouping", grouping: message.grouping }
      : null;
  }
  if (message.type === "panel") {
    if (!isRealmPanel(message.panel) || typeof message.open !== "boolean") return null;
    const inset = finiteNumber(message.inset);
    return {
      type: "panel",
      panel: message.panel,
      open: message.open,
      inset: Math.min(Math.max(inset ?? 0, 0), MAX_PANEL_INSET),
      ...(sequence(message.seq) !== undefined ? { seq: sequence(message.seq) } : {}),
      ...(message.restoreFocus === true ? { restoreFocus: true } : {}),
    };
  }
  if (message.type !== "select") return null;
  const projectId = boundedId(message.projectId);
  const environmentId = boundedId(message.environmentId);
  const tab = boardTab(message.boardTab);
  const createEnvironmentProjectId = boundedId(message.createEnvironmentProjectId);
  const dialog = realmDialog(message.dialog);
  // A dialog needs what it is for: a project, or an environment for its settings.
  const dialogTarget =
    dialog && isEnvironmentDialog(dialog)
      ? Boolean(projectId && environmentId)
      : Boolean(projectId);
  return {
    type: "select",
    ...(projectId ? { projectId } : {}),
    ...(projectId && environmentId ? { environmentId } : {}),
    ...(projectId && tab ? { boardTab: tab } : {}),
    ...(message.addProject === true ? { addProject: true as const } : {}),
    ...(createEnvironmentProjectId ? { createEnvironmentProjectId } : {}),
    ...(dialog && dialogTarget ? { dialog } : {}),
    ...(message.bugReport === true ? { bugReport: true as const } : {}),
  };
}

export function parseRealmMessage(value: unknown): RealmToShellMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type === "open") {
    const nodeId = boundedId(message.nodeId);
    const projectId = boundedId(message.projectId);
    if (!nodeId || !projectId) return null;
    const environmentId = boundedId(message.environmentId);
    const tab = boardTab(message.boardTab);
    const title = typeof message.title === "string" ? message.title.slice(0, 200) : "";
    return {
      type: "open",
      nodeId,
      projectId,
      ...(environmentId ? { environmentId } : {}),
      ...(tab ? { boardTab: tab } : {}),
      title,
    };
  }
  if (message.type === "ready") return { type: "ready" };
  if (message.type === "bugReport") {
    if (message.nodeId === null) return { type: "bugReport", nodeId: null };
    const nodeId = boundedId(message.nodeId);
    return nodeId ? { type: "bugReport", nodeId } : null;
  }
  if (message.type === "sidebar") {
    return typeof message.open === "boolean" ? { type: "sidebar", open: message.open } : null;
  }
  if (message.type === "settings") {
    return typeof message.section === "string" && /^[a-z-]{1,40}$/.test(message.section)
      ? { type: "settings", section: message.section }
      : null;
  }
  if (message.type === "shortcut") {
    return isAppShortcutId(message.shortcut)
      ? { type: "shortcut", shortcut: message.shortcut }
      : null;
  }
  if (message.type === "panelDismissed") {
    const seq = sequence(message.seq);
    return isRealmPanel(message.panel) && seq !== undefined
      ? { type: "panelDismissed", panel: message.panel, seq }
      : null;
  }
  if (message.type === "titleBar") {
    return {
      type: "titleBar",
      usage: parseUsageReading(message.usage),
      usageStale: message.usageStale === true,
      panel: isRealmPanel(message.panel) ? message.panel : null,
      ...(sequence(message.requestSeq) !== undefined
        ? { requestSeq: sequence(message.requestSeq) }
        : {}),
    };
  }
  if (message.type !== "selection") return null;
  const projectId = boundedId(message.projectId) ?? null;
  const environmentId = projectId ? (boundedId(message.environmentId) ?? null) : null;
  return { type: "selection", projectId, environmentId };
}

/** Envelope of frame messages, so a page's other messages are never mistaken for ours. */
const FRAME_ENVELOPE = "orkestrator-workspace-realm";

type FrameEnvelope = { kind: typeof FRAME_ENVELOPE; workspaceId: string; message: unknown };

export function frameEnvelope(workspaceId: string, message: unknown): FrameEnvelope {
  return { kind: FRAME_ENVELOPE, workspaceId, message };
}

export function readFrameEnvelope(
  value: unknown,
): { workspaceId: string; message: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Partial<FrameEnvelope>;
  const workspaceId = boundedId(envelope.workspaceId);
  if (envelope.kind !== FRAME_ENVELOPE || !workspaceId) return null;
  return { workspaceId, message: envelope.message };
}

/** Realm side: tell the window. */
export function postToShell(message: RealmToShellMessage): void {
  const desktop = window.orkestrator?.workspaceRealm;
  if (desktop) {
    desktop.post(message);
    return;
  }
  const workspaceId = realmWorkspaceId();
  if (!workspaceId || window.parent === window) return;
  window.parent.postMessage(frameEnvelope(workspaceId, message), window.location.origin);
}

/** Realm side: requests from the window. */
export function onShellMessage(handler: (message: ShellToRealmMessage) => void): () => void {
  const desktop = window.orkestrator?.workspaceRealm;
  if (desktop) {
    return desktop.onMessage((value) => {
      const message = parseShellMessage(value);
      if (message) handler(message);
    });
  }
  const workspaceId = realmWorkspaceId();
  if (!workspaceId) return () => undefined;
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const envelope = readFrameEnvelope(event.data);
    if (envelope?.workspaceId !== workspaceId) return;
    const message = parseShellMessage(envelope.message);
    if (message) handler(message);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
