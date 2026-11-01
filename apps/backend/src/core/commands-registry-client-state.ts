import {
  CLIENT_STATE_CAPABILITIES_COMMAND,
  type ClientStateCapabilities,
} from "@orkestrator/protocol/client-state";
import {
  decideUpstreamMergeOffer,
  type CoordinatorUpstreamMergeCheck,
} from "@orkestrator/protocol/coordinator-upstream-merge";
import {
  isNoticeOccurrenceId,
  isNoticeSessionIdentity,
  NOTICE_DISMISSAL_LIMITS,
  normalizeNoticeDismissalSessions,
} from "@orkestrator/protocol/notice-dismissals";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import type { CommandRegistrar } from "./commands-registry-types.js";

/**
 * Presentation state every client shares, which browsers used to keep in
 * their own localStorage (storage-client-state.ts), and the backend-side
 * decisions that went with it.
 *
 * - `get_client_state_capabilities` → which of these this backend owns.
 * - `get_coordinator_pane_layout {projectId}` → the stored record, or null.
 * - `save_coordinator_pane_layout {projectId, layout, expectedRevision}` →
 *   `saved` with the record, or `conflict` with the stored one.
 * - `check_coordinator_upstream_merge {projectId}` → whether to ask "merge
 *   upstream first?" before a message to the main coordinator. Refreshes the
 *   checkout status (subject to the fetch cooldown) unless a turn is running.
 * - `decline_coordinator_upstream_merge {projectId, upstream, upstreamCommit,
 *   onlyIfAbsent?}` → the decline now in force.
 * - `list_notice_dismissals`, `dismiss_notices {sessions}`,
 *   `reconcile_notice_dismissals {sessionIdentity, activeOccurrenceIds}` →
 *   the dismissal snapshot.
 */

const CAPABILITIES: ClientStateCapabilities = {
  coordinatorPaneLayouts: true,
  coordinatorUpstreamMerge: true,
  noticeDismissals: true,
  environmentAttention: true,
};

async function existingProjectId(value: unknown, context: CommandContext): Promise<string> {
  const projectId = asNonBlankString(value, "projectId");
  if (projectId.length > 200) throw new Error("projectId is too long");
  if (!(await context.storage.getProject(projectId))) throw new Error("Project not found");
  return projectId;
}

export function registerClientStateCommands(register: CommandRegistrar): void {
  register(CLIENT_STATE_CAPABILITIES_COMMAND, () => CAPABILITIES);

  register("get_coordinator_pane_layout", async ({ projectId }, context) =>
    context.storage.clientState.getCoordinatorPaneLayout(
      await existingProjectId(projectId, context),
    ),
  );
  register(
    "save_coordinator_pane_layout",
    async ({ projectId, layout, expectedRevision }, context) => {
      if (
        typeof expectedRevision !== "number" ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      ) {
        throw new Error("expectedRevision must be a non-negative integer");
      }
      return context.storage.clientState.saveCoordinatorPaneLayout(
        await existingProjectId(projectId, context),
        layout,
        expectedRevision,
      );
    },
  );

  register(
    "check_coordinator_upstream_merge",
    async ({ projectId }, context): Promise<CoordinatorUpstreamMergeCheck> => {
      const projectGit = context.projectGit;
      if (!projectGit) throw new Error("Project Git service is unavailable");
      const id = await existingProjectId(projectId, context);
      // The backend refuses to change the checkout under a running turn, so
      // there is nothing to offer; and no fetch is started for it either.
      if (await projectGit.isCheckoutBusy(id)) {
        return { offer: false, reason: "turn-running", status: null };
      }
      const status = await projectGit.fetch(id).catch(() => null);
      return decideUpstreamMergeOffer(
        status,
        context.storage.clientState.getCoordinatorUpstreamDecline(id),
      );
    },
  );
  register(
    "decline_coordinator_upstream_merge",
    async ({ projectId, upstream, upstreamCommit, onlyIfAbsent }, context) =>
      context.storage.clientState.recordCoordinatorUpstreamDecline(
        await existingProjectId(projectId, context),
        {
          upstream: asNonBlankString(upstream, "upstream"),
          upstreamCommit: asNonBlankString(upstreamCommit, "upstreamCommit"),
        },
        { onlyIfAbsent: onlyIfAbsent === true },
      ),
  );

  register("list_notice_dismissals", (_args, context) =>
    context.storage.clientState.listNoticeDismissals(),
  );
  register("dismiss_notices", ({ sessions }, context) => {
    if (!Array.isArray(sessions) || sessions.length > NOTICE_DISMISSAL_LIMITS.sessionsPerRequest) {
      throw new Error("sessions must be a bounded array");
    }
    return context.storage.clientState.dismissNotices(normalizeNoticeDismissalSessions(sessions));
  });
  register("reconcile_notice_dismissals", ({ sessionIdentity, activeOccurrenceIds }, context) => {
    if (!isNoticeSessionIdentity(sessionIdentity)) throw new Error("Invalid sessionIdentity");
    if (!Array.isArray(activeOccurrenceIds) || activeOccurrenceIds.length > 256) {
      throw new Error("activeOccurrenceIds must be a bounded array");
    }
    return context.storage.clientState.reconcileNoticeDismissals(
      sessionIdentity,
      activeOccurrenceIds.filter(isNoticeOccurrenceId),
    );
  });
}
