import {
  CLIENT_STATE_CAPABILITIES_COMMAND,
  parseClientStateCapabilities,
  type ClientStateCapabilities,
} from "@orkestrator/protocol/client-state";
import {
  parseCoordinatorPaneLayoutRecord,
  parseCoordinatorPaneLayoutSaveResult,
  type CoordinatorPaneLayout,
  type CoordinatorPaneLayoutRecord,
  type CoordinatorPaneLayoutSaveResult,
} from "@orkestrator/protocol/coordinator-pane-layout";
import {
  parseCoordinatorUpstreamMergeCheck,
  type CoordinatorUpstreamMergeCheck,
} from "@orkestrator/protocol/coordinator-upstream-merge";
import {
  parseNoticeDismissalSnapshot,
  type NoticeDismissalSession,
  type NoticeDismissalSnapshot,
} from "@orkestrator/protocol/notice-dismissals";
import { clientInvoke, commandBackendClient, type BackendClient } from "./client";

/**
 * Shared presentation state the backend owns (formerly browser-local). Every
 * answer is validated; a malformed one reads as "unknown" (null) rather than
 * being trusted.
 */

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createClientStateApi(client: BackendClient) {
  const invoke = clientInvoke(client);

  /** Unknown command on an older backend: every capability off. */
  const getClientStateCapabilities = async (): Promise<ClientStateCapabilities> =>
    parseClientStateCapabilities(await invoke(CLIENT_STATE_CAPABILITIES_COMMAND));

  const getCoordinatorPaneLayout = async (
    projectId: string,
  ): Promise<CoordinatorPaneLayoutRecord | null> =>
    parseCoordinatorPaneLayoutRecord(await invoke("get_coordinator_pane_layout", { projectId }));

  const saveCoordinatorPaneLayout = async (
    projectId: string,
    layout: CoordinatorPaneLayout,
    expectedRevision: number,
  ): Promise<CoordinatorPaneLayoutSaveResult | null> =>
    parseCoordinatorPaneLayoutSaveResult(
      await invoke("save_coordinator_pane_layout", { projectId, layout, expectedRevision }),
    );

  const checkCoordinatorUpstreamMerge = async (
    projectId: string,
  ): Promise<CoordinatorUpstreamMergeCheck | null> =>
    parseCoordinatorUpstreamMergeCheck(
      await invoke("check_coordinator_upstream_merge", { projectId }),
    );

  const listNoticeDismissals = async (): Promise<NoticeDismissalSnapshot | null> =>
    parseNoticeDismissalSnapshot(await invoke("list_notice_dismissals"));

  const dismissNotices = async (
    sessions: readonly NoticeDismissalSession[],
  ): Promise<NoticeDismissalSnapshot | null> =>
    parseNoticeDismissalSnapshot(await invoke("dismiss_notices", { sessions }));

  const reconcileNoticeDismissals = async (
    sessionIdentity: string,
    activeOccurrenceIds: readonly string[],
  ): Promise<NoticeDismissalSnapshot | null> =>
    parseNoticeDismissalSnapshot(
      await invoke("reconcile_notice_dismissals", { sessionIdentity, activeOccurrenceIds }),
    );

  return {
    getClientStateCapabilities,
    getCoordinatorPaneLayout,
    saveCoordinatorPaneLayout,
    checkCoordinatorUpstreamMerge,
    listNoticeDismissals,
    dismissNotices,
    reconcileNoticeDismissals,
  };
}

export type ClientStateApi = ReturnType<typeof createClientStateApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getClientStateCapabilities,
  getCoordinatorPaneLayout,
  saveCoordinatorPaneLayout,
  checkCoordinatorUpstreamMerge,
  listNoticeDismissals,
  dismissNotices,
  reconcileNoticeDismissals,
} = createClientStateApi(commandBackendClient);
