import {
  CLIENT_STATE_CAPABILITIES_COMMAND,
  type ClientStateCapabilities,
} from "@orkestrator/protocol/client-state";
import {
  decideUpstreamMergeOffer,
  type CoordinatorUpstreamAutoMerge,
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
 * - `check_coordinator_upstream_merge {projectId}` → whether to fast-forward
 *   the checkout before a message to the main coordinator. Refreshes the
 *   checkout status (subject to the fetch cooldown) unless a turn is running,
 *   and answers every mergeable checkout `automatic`: it is always merged.
 * - `decline_coordinator_upstream_merge {projectId, upstream, upstreamCommit,
 *   onlyIfAbsent?}`, `get_coordinator_upstream_auto_merge {projectId}` and
 *   `set_coordinator_upstream_auto_merge {projectId, enabled}`: retired, kept
 *   for clients that still ask. Neither a decline nor the setting changes the
 *   check any more, and the capability is no longer advertised, so a client
 *   that knows it hides its "always merge" toggle.
 * - `list_notice_dismissals`, `dismiss_notices {sessions}`,
 *   `reconcile_notice_dismissals {sessionIdentity, activeOccurrenceIds}` →
 *   the dismissal snapshot.
 */

const CAPABILITIES: ClientStateCapabilities = {
  coordinatorPaneLayouts: true,
  coordinatorUpstreamMerge: true,
  // Retired: every mergeable checkout is merged, so there is no setting to show.
  coordinatorUpstreamAutoMerge: false,
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
      return decideUpstreamMergeOffer(await projectGit.fetch(id).catch(() => null));
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

  register(
    "get_coordinator_upstream_auto_merge",
    async ({ projectId }, context): Promise<CoordinatorUpstreamAutoMerge> => ({
      enabled: context.storage.clientState.getCoordinatorUpstreamAutoMerge(
        await existingProjectId(projectId, context),
      ),
    }),
  );
  register(
    "set_coordinator_upstream_auto_merge",
    async ({ projectId, enabled }, context): Promise<CoordinatorUpstreamAutoMerge> => {
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      return {
        enabled: context.storage.clientState.setCoordinatorUpstreamAutoMerge(
          await existingProjectId(projectId, context),
          enabled,
        ),
      };
    },
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
