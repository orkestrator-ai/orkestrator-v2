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
  type DeclinedUpstreamMerge,
} from "@orkestrator/protocol/coordinator-upstream-merge";
import {
  parseNoticeDismissalSnapshot,
  type NoticeDismissalSession,
  type NoticeDismissalSnapshot,
} from "@orkestrator/protocol/notice-dismissals";
import { invoke } from "@/lib/native/backend";

/**
 * Shared presentation state the backend owns (formerly browser-local). Every
 * answer is validated; a malformed one reads as "unknown" (null) rather than
 * being trusted.
 */

/** Unknown command on an older backend: every capability off. */
export const getClientStateCapabilities = async (): Promise<ClientStateCapabilities> =>
  parseClientStateCapabilities(await invoke(CLIENT_STATE_CAPABILITIES_COMMAND));

export const getCoordinatorPaneLayout = async (
  projectId: string,
): Promise<CoordinatorPaneLayoutRecord | null> =>
  parseCoordinatorPaneLayoutRecord(await invoke("get_coordinator_pane_layout", { projectId }));

export const saveCoordinatorPaneLayout = async (
  projectId: string,
  layout: CoordinatorPaneLayout,
  expectedRevision: number,
): Promise<CoordinatorPaneLayoutSaveResult | null> =>
  parseCoordinatorPaneLayoutSaveResult(
    await invoke("save_coordinator_pane_layout", { projectId, layout, expectedRevision }),
  );

export const checkCoordinatorUpstreamMerge = async (
  projectId: string,
): Promise<CoordinatorUpstreamMergeCheck | null> =>
  parseCoordinatorUpstreamMergeCheck(
    await invoke("check_coordinator_upstream_merge", { projectId }),
  );

export const declineCoordinatorUpstreamMerge = (
  projectId: string,
  decline: DeclinedUpstreamMerge,
  options: { onlyIfAbsent?: boolean } = {},
): Promise<unknown> =>
  invoke("decline_coordinator_upstream_merge", {
    projectId,
    upstream: decline.upstream,
    upstreamCommit: decline.upstreamCommit,
    ...(options.onlyIfAbsent ? { onlyIfAbsent: true } : {}),
  });

export const listNoticeDismissals = async (): Promise<NoticeDismissalSnapshot | null> =>
  parseNoticeDismissalSnapshot(await invoke("list_notice_dismissals"));

export const dismissNotices = async (
  sessions: readonly NoticeDismissalSession[],
): Promise<NoticeDismissalSnapshot | null> =>
  parseNoticeDismissalSnapshot(await invoke("dismiss_notices", { sessions }));

export const reconcileNoticeDismissals = async (
  sessionIdentity: string,
  activeOccurrenceIds: readonly string[],
): Promise<NoticeDismissalSnapshot | null> =>
  parseNoticeDismissalSnapshot(
    await invoke("reconcile_notice_dismissals", { sessionIdentity, activeOccurrenceIds }),
  );
