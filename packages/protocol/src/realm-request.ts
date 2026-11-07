/**
 * What a window asks one of its workspace realms to show (see
 * `apps/web/src/lib/federation/workspace-realm.ts`), and how that request
 * travels in a realm's URL.
 *
 * The request is written in two places: the web side for browser and iOS
 * frames, and the desktop main process (`apps/desktop/electron/federation-ipc.ts`)
 * for a desktop realm's first URL, which it builds from the request the window
 * sends over IPC. The realm reads it back from its URL and from the window's
 * `select` messages. All of them use this one definition, so a field one side
 * writes cannot be dropped by another. Browser-safe: no Node APIs.
 */

/** Explicit board navigation overrides a node's default project landing tab. */
export const REALM_BOARD_TABS = [
  "home",
  "coordinator",
  "kanban",
  "github",
  "linear",
  "features",
] as const;

export type RealmBoardTab = (typeof REALM_BOARD_TABS)[number];

/**
 * A dialog of the realm's node, opened over what the request selects: the
 * project's for the project dialogs, the environment's for its settings.
 * `environment-rebuild` is the environment's settings on its Container
 * section, where Rebuild (keep work) is; a node that predates it drops the
 * dialog and only selects the environment.
 */
export const REALM_DIALOGS = [
  "repository-settings",
  "delete-project",
  "environment-settings",
  "environment-rebuild",
] as const;

export type RealmDialog = (typeof REALM_DIALOGS)[number];

/** The kinds of work on the realm's own node that a request can open. */
export const REALM_WORK_TYPES = ["worker-tab", "build", "review", "graph-run"] as const;

export type RealmWorkType = (typeof REALM_WORK_TYPES)[number];

/** Work on one node, opened where it runs. */
export type RealmWorkTarget =
  /** A worker environment, at the delegated tab when known. */
  | { type: "worker-tab"; projectId: string; environmentId: string; tabId?: string }
  /** A build pipeline's tab; the environment may not exist yet. */
  | { type: "build"; projectId: string; pipelineId: string; environmentId?: string }
  | { type: "review"; projectId: string; environmentId: string; workflowId: string }
  | { type: "graph-run"; projectId: string; environmentId: string; runId: string; title?: string };

/** What the window asks its realm to show. */
export interface RealmOpenRequest {
  projectId?: string;
  environmentId?: string;
  boardTab?: RealmBoardTab;
  /** Work in the selected environment; only accepted on the request's own project and environment. */
  workTarget?: RealmWorkTarget;
  /** Open the node's Add Project dialog. */
  addProject?: true;
  /** Open the node's New Environment dialog for this project. */
  createEnvironmentProjectId?: string;
  /** Open one of the node's dialogs for the selected project or environment. */
  dialog?: RealmDialog;
  /** Open the node's Report a bug sheet, which runs its agent on that node. */
  bugReport?: true;
}

export const REALM_ID_MAX_LENGTH = 256;

/** A non-empty ID of bounded length, or undefined. */
export function realmId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= REALM_ID_MAX_LENGTH
    ? value
    : undefined;
}

export function isRealmBoardTab(value: unknown): value is RealmBoardTab {
  return (REALM_BOARD_TABS as readonly unknown[]).includes(value);
}

export function isRealmDialog(value: unknown): value is RealmDialog {
  return (REALM_DIALOGS as readonly unknown[]).includes(value);
}

export function isRealmWorkType(value: unknown): value is RealmWorkType {
  return (REALM_WORK_TYPES as readonly unknown[]).includes(value);
}

/** Whether the dialog is one of an environment's rather than a project's. */
export function isEnvironmentDialog(dialog: RealmDialog): boolean {
  return dialog === "environment-settings" || dialog === "environment-rebuild";
}

/**
 * A work target of a known type with its own ID, on exactly the given project
 * and environment; anything else is refused.
 */
export function parseRealmWorkTarget(
  value: unknown,
  projectId?: string,
  environmentId?: string,
): RealmWorkTarget | undefined {
  if (!value || typeof value !== "object" || !projectId || !environmentId) return undefined;
  const v = value as Record<string, unknown>;
  if (v.projectId !== projectId || v.environmentId !== environmentId) return undefined;
  const base = { projectId, environmentId };
  if (v.type === "worker-tab") {
    const tabId = realmId(v.tabId);
    return { ...base, type: v.type, ...(tabId ? { tabId } : {}) };
  }
  if (v.type === "build") {
    const pipelineId = realmId(v.pipelineId);
    return pipelineId ? { ...base, type: v.type, pipelineId } : undefined;
  }
  if (v.type === "review") {
    const workflowId = realmId(v.workflowId);
    return workflowId ? { ...base, type: v.type, workflowId } : undefined;
  }
  if (v.type === "graph-run") {
    const runId = realmId(v.runId);
    return runId ? { ...base, type: v.type, runId } : undefined;
  }
  return undefined;
}

/**
 * The request's known fields, each only with what it needs: an environment
 * with its project, a board tab with a project, a work target on the
 * request's own environment, a dialog with what it opens over. Unknown fields
 * and values are dropped.
 */
export function parseRealmRequest(value: unknown): RealmOpenRequest {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const projectId = realmId(input.projectId);
  const environmentId = projectId ? realmId(input.environmentId) : undefined;
  const boardTab = isRealmBoardTab(input.boardTab) ? input.boardTab : undefined;
  const workTarget = parseRealmWorkTarget(input.workTarget, projectId, environmentId);
  const createEnvironmentProjectId = realmId(input.createEnvironmentProjectId);
  const dialog = isRealmDialog(input.dialog) ? input.dialog : undefined;
  // A dialog needs what it is for: a project, or an environment for its settings.
  const dialogTarget =
    dialog && isEnvironmentDialog(dialog) ? Boolean(environmentId) : Boolean(projectId);
  return {
    ...(projectId ? { projectId } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(projectId && boardTab ? { boardTab } : {}),
    ...(workTarget ? { workTarget } : {}),
    ...(input.addProject === true ? { addProject: true as const } : {}),
    ...(createEnvironmentProjectId ? { createEnvironmentProjectId } : {}),
    ...(dialog && dialogTarget ? { dialog } : {}),
    ...(input.bugReport === true ? { bugReport: true as const } : {}),
  };
}

function workTargetId(target: RealmWorkTarget): string | undefined {
  switch (target.type) {
    case "worker-tab":
      return target.tabId;
    case "build":
      return target.pipelineId;
    case "review":
      return target.workflowId;
    case "graph-run":
      return target.runId;
  }
}

/**
 * The query parameters that carry `request` in a realm's URL. Only what
 * {@link parseRealmRequest} accepts is written; the realm marker and any
 * workspace grant are the caller's.
 */
export function realmRequestToSearch(request: RealmOpenRequest): URLSearchParams {
  const accepted = parseRealmRequest(request);
  const search = new URLSearchParams();
  if (accepted.projectId) search.set("project", accepted.projectId);
  if (accepted.environmentId) search.set("environment", accepted.environmentId);
  if (accepted.boardTab) search.set("boardTab", accepted.boardTab);
  if (accepted.workTarget) {
    search.set("workType", accepted.workTarget.type);
    const id = workTargetId(accepted.workTarget);
    if (id) search.set("workId", id);
  }
  if (accepted.addProject) search.set("addProject", "1");
  if (accepted.createEnvironmentProjectId)
    search.set("createEnvironment", accepted.createEnvironmentProjectId);
  if (accepted.dialog) search.set("dialog", accepted.dialog);
  if (accepted.bugReport) search.set("bugReport", "1");
  return search;
}

/** The request a realm's URL carries, as {@link realmRequestToSearch} wrote it. */
export function parseRealmRequestSearch(search: URLSearchParams): RealmOpenRequest {
  const workType = search.get("workType");
  const workId = search.get("workId") ?? undefined;
  return parseRealmRequest({
    projectId: search.get("project") ?? undefined,
    environmentId: search.get("environment") ?? undefined,
    boardTab: search.get("boardTab") ?? undefined,
    workTarget: isRealmWorkType(workType)
      ? {
          type: workType,
          projectId: search.get("project"),
          environmentId: search.get("environment"),
          tabId: workId,
          pipelineId: workId,
          workflowId: workId,
          runId: workId,
        }
      : undefined,
    addProject: search.get("addProject") === "1" ? true : undefined,
    createEnvironmentProjectId: search.get("createEnvironment") ?? undefined,
    dialog: search.get("dialog") ?? undefined,
    bugReport: search.get("bugReport") === "1" ? true : undefined,
  });
}
