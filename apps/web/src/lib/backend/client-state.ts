import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import { config as configDomain } from "@/lib/node-scope/domains/config";
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
import { commandBackendClient, type BackendClient } from "./client";

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
  // The `config` domain (plan item 7005). Its answers are still read with the
  // protocol's parsers: an older node's are as it sent them (version 0).
  const state = configDomain(client);

  /**
   * Folded into `config` version 1, which answers without asking; an older
   * node is asked (an unreadable answer is every capability off).
   */
  const getClientStateCapabilities = async (): Promise<ClientStateCapabilities> =>
    state().clientStateCapabilities();

  const getCoordinatorPaneLayout = async (
    projectId: string,
  ): Promise<CoordinatorPaneLayoutRecord | null> =>
    parseCoordinatorPaneLayoutRecord(await state().get_coordinator_pane_layout({ projectId }));

  const saveCoordinatorPaneLayout = async (
    projectId: string,
    layout: CoordinatorPaneLayout,
    expectedRevision: number,
  ): Promise<CoordinatorPaneLayoutSaveResult | null> =>
    parseCoordinatorPaneLayoutSaveResult(
      await state().save_coordinator_pane_layout({ projectId, layout, expectedRevision }),
    );

  const checkCoordinatorUpstreamMerge = async (
    projectId: string,
  ): Promise<CoordinatorUpstreamMergeCheck | null> =>
    parseCoordinatorUpstreamMergeCheck(
      await state().check_coordinator_upstream_merge({ projectId }),
    );

  const listNoticeDismissals = async (): Promise<NoticeDismissalSnapshot | null> =>
    parseNoticeDismissalSnapshot(await state().list_notice_dismissals({}));

  const dismissNotices = async (
    sessions: readonly NoticeDismissalSession[],
  ): Promise<NoticeDismissalSnapshot | null> =>
    parseNoticeDismissalSnapshot(await state().dismiss_notices({ sessions }));

  const reconcileNoticeDismissals = async (
    sessionIdentity: string,
    activeOccurrenceIds: readonly string[],
  ): Promise<NoticeDismissalSnapshot | null> =>
    parseNoticeDismissalSnapshot(
      await state().reconcile_notice_dismissals({ sessionIdentity, activeOccurrenceIds }),
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
