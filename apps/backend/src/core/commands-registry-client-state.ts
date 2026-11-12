import {
  checkCoordinatorUpstreamMergeCommand,
  CONFIG_CLIENT_STATE_CAPABILITIES,
  declineCoordinatorUpstreamMergeCommand,
  dismissNoticesCommand,
  getClientStateCapabilitiesCommand,
  getCoordinatorPaneLayoutCommand,
  getCoordinatorUpstreamAutoMergeCommand,
  listNoticeDismissalsCommand,
  reconcileNoticeDismissalsCommand,
  saveCoordinatorPaneLayoutCommand,
  setCoordinatorUpstreamAutoMergeCommand,
} from "@orkestrator/protocol/contract/domains/config";
import {
  getCoordinatorActionMarksCommand,
  setCoordinatorActionMarkCommand,
} from "@orkestrator/protocol/contract/domains/coordinator";
import { COORDINATOR_ACTION_MARK_LIMITS } from "@orkestrator/protocol/coordinator-action-marks";
import type {
  CoordinatorUpstreamAutoMerge,
  CoordinatorUpstreamMergeCheck,
} from "@orkestrator/protocol/coordinator-upstream-merge";
import {
  isNoticeOccurrenceId,
  isNoticeSessionIdentity,
  NOTICE_DISMISSAL_LIMITS,
  normalizeNoticeDismissalSessions,
} from "@orkestrator/protocol/notice-dismissals";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { checkUpstreamBeforeMessage } from "./coordinator-message-upstream.js";
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
 *   A slow or failed fetch is answered by fast-forwarding to the upstream
 *   commit already fetched (`coordinator-message-upstream.ts`).
 * - `decline_coordinator_upstream_merge {projectId, upstream, upstreamCommit,
 *   onlyIfAbsent?}`, `get_coordinator_upstream_auto_merge {projectId}` and
 *   `set_coordinator_upstream_auto_merge {projectId, enabled}`: retired, kept
 *   for clients that still ask. Neither a decline nor the setting changes the
 *   check any more, and the capability is no longer advertised, so a client
 *   that knows it hides its "always merge" toggle.
 * - `list_notice_dismissals`, `dismiss_notices {sessions}`,
 *   `reconcile_notice_dismissals {sessionIdentity, activeOccurrenceIds}` →
 *   the dismissal snapshot.
 * - `get_coordinator_action_marks {projectId, conversationId}` and
 *   `set_coordinator_action_mark {projectId, conversationId, cardId, done}`
 *   (`coordinator` domain) → the conversation's manual action marks. The
 *   conversation must belong to the project's coordinator, open or closed.
 */

/**
 * What `get_client_state_capabilities` answers: the set `config` version 1
 * includes, so the domain client answers it without asking. The "always
 * merge" setting is retired: every mergeable checkout is merged.
 */
const CAPABILITIES = CONFIG_CLIENT_STATE_CAPABILITIES;

async function existingProjectId(value: unknown, context: CommandContext): Promise<string> {
  const projectId = asNonBlankString(value, "projectId");
  if (projectId.length > 200) throw new Error("projectId is too long");
  if (!(await context.storage.getProject(projectId))) throw new Error("Project not found");
  return projectId;
}

/** A conversation of the project's coordinator (closed ones included: their transcripts stay readable). */
async function existingConversationId(
  projectId: string,
  value: unknown,
  context: CommandContext,
): Promise<string> {
  const conversationId = asNonBlankString(value, "conversationId");
  if (conversationId.length > COORDINATOR_ACTION_MARK_LIMITS.idChars) {
    throw new Error("conversationId is too long");
  }
  const workspace = await context.storage.coordinators.getCoordinatorWorkspace(projectId);
  if (!workspace?.conversations.some((conversation) => conversation.id === conversationId)) {
    throw new Error("Coordinator conversation not found");
  }
  return conversationId;
}

export function registerClientStateCommands(register: CommandRegistrar): void {
  register(getClientStateCapabilitiesCommand, () => ({ ...CAPABILITIES }));

  register(getCoordinatorPaneLayoutCommand, async ({ projectId }, context) =>
    context.storage.clientState.getCoordinatorPaneLayout(
      await existingProjectId(projectId, context),
    ),
  );
  register(
    saveCoordinatorPaneLayoutCommand,
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
        layout as never,
        expectedRevision,
      );
    },
  );

  register(
    checkCoordinatorUpstreamMergeCommand,
    async ({ projectId }, context): Promise<CoordinatorUpstreamMergeCheck> => {
      const projectGit = context.projectGit;
      if (!projectGit) throw new Error("Project Git service is unavailable");
      return checkUpstreamBeforeMessage(projectGit, await existingProjectId(projectId, context));
    },
  );
  register(
    declineCoordinatorUpstreamMergeCommand,
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
    getCoordinatorUpstreamAutoMergeCommand,
    async ({ projectId }, context): Promise<CoordinatorUpstreamAutoMerge> => {
      compatibilityPathUsage.record("retired-command.coordinator-upstream-auto-merge");
      return {
        enabled: context.storage.clientState.getCoordinatorUpstreamAutoMerge(
          await existingProjectId(projectId, context),
        ),
      };
    },
  );
  register(
    setCoordinatorUpstreamAutoMergeCommand,
    async ({ projectId, enabled }, context): Promise<CoordinatorUpstreamAutoMerge> => {
      compatibilityPathUsage.record("retired-command.coordinator-upstream-auto-merge");
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      return {
        enabled: context.storage.clientState.setCoordinatorUpstreamAutoMerge(
          await existingProjectId(projectId, context),
          enabled,
        ),
      };
    },
  );

  register(getCoordinatorActionMarksCommand, async ({ projectId, conversationId }, context) => {
    const project = await existingProjectId(projectId, context);
    return context.storage.clientState.getCoordinatorActionMarks(
      project,
      await existingConversationId(project, conversationId, context),
    );
  });
  register(
    setCoordinatorActionMarkCommand,
    async ({ projectId, conversationId, cardId, done }, context) => {
      if (typeof done !== "boolean") throw new Error("done must be a boolean");
      const project = await existingProjectId(projectId, context);
      return context.storage.clientState.setCoordinatorActionMark(
        project,
        await existingConversationId(project, conversationId, context),
        asNonBlankString(cardId, "cardId"),
        done,
      );
    },
  );

  register(listNoticeDismissalsCommand, (_args, context) =>
    context.storage.clientState.listNoticeDismissals(),
  );
  register(dismissNoticesCommand, ({ sessions }, context) => {
    if (!Array.isArray(sessions) || sessions.length > NOTICE_DISMISSAL_LIMITS.sessionsPerRequest) {
      throw new Error("sessions must be a bounded array");
    }
    return context.storage.clientState.dismissNotices(normalizeNoticeDismissalSessions(sessions));
  });
  register(
    reconcileNoticeDismissalsCommand,
    ({ sessionIdentity, activeOccurrenceIds }, context) => {
      if (!isNoticeSessionIdentity(sessionIdentity)) throw new Error("Invalid sessionIdentity");
      if (!Array.isArray(activeOccurrenceIds) || activeOccurrenceIds.length > 256) {
        throw new Error("activeOccurrenceIds must be a bounded array");
      }
      return context.storage.clientState.reconcileNoticeDismissals(
        sessionIdentity,
        activeOccurrenceIds.filter(isNoticeOccurrenceId),
      );
    },
  );
}
