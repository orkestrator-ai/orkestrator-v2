import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorWorkflowAssociation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { StorageService } from "./storage.js";

/**
 * What closed coordinator conversations leave behind, and how it reaches the
 * main: the work they still owe (delegations not yet woken, workflows not yet
 * reported) and the mail waiting in a closed main's inbox.
 *
 * Two callers. `CoordinatorService` runs one coordinator's repair when a main
 * opens or a conversation closes (`reconcileMainMail`), and the 60 s
 * coordinator-repair sweep runs every coordinator's at once
 * (`reconcileClosedConversations`). A read never runs either.
 */

const log = createLogger("coordinator");

type Storage = Pick<
  StorageService,
  "coordinators" | "synchronizeAgentMailboxes" | "moveClosedCoordinatorMail"
>;

/**
 * Work the main coordinator should own but a different conversation still
 * holds: delegations not yet woken, and workflows not yet reported. Finished
 * history is left where it is, because adopting re-arms its notification.
 */
function liveWork(association: CoordinatorWorkflowAssociation): boolean {
  if (association.pending) return false;
  if (association.kind === "environment") {
    return Boolean(
      association.delegation &&
      (association.delegation.state === "running" || !association.delegation.wokenAt),
    );
  }
  return !association.terminalNotifiedAt;
}

/**
 * One coordinator's half of the sweep's repair, for a write that needs it
 * now. `closedOnly` false also takes over open side conversations' work, as
 * opening or using a main does (`ensureMainConversation`).
 */
export async function reconcileMainMail(
  storage: Storage,
  workspace: CoordinatorWorkspace,
  main: CoordinatorConversation,
  closedOnly = true,
): Promise<void> {
  await adoptLiveWork(storage, workspace, main, closedOnly);
  await storage.synchronizeAgentMailboxes();
  await moveClosedMainMail(
    storage,
    workspace,
    main,
    await storage.coordinators.listOwedCoordinatorDelegationIds(),
  );
}

/**
 * The sweep's repair of what closed conversations left behind, for every
 * coordinator. The mailbox sync and the owed delegations are global, so each
 * is read once rather than once per coordinator. The per-coordinator steps
 * keep their order (adoption, then the sync, then the mail move) and share
 * that one owed set: adoption only changes which conversation a record
 * belongs to, not whether a wake is owed, and each mail move reads the mail
 * store afresh under its lock, so it sees what an earlier coordinator's move
 * left there. A sync that fails skips the moves, as it did per coordinator,
 * but not the rest of the sweep.
 */
export async function reconcileClosedConversations(storage: Storage): Promise<void> {
  const { workspaces, workflows } = await storage.coordinators.getCoordinatorReconciliationState();
  const byProject = new Map<string, CoordinatorWorkflowAssociation[]>();
  for (const association of workflows) {
    const records = byProject.get(association.projectId);
    if (records) records.push(association);
    else byProject.set(association.projectId, [association]);
  }
  const mains: Array<[CoordinatorWorkspace, CoordinatorConversation]> = [];
  for (const workspace of workspaces) {
    const main = coordinatorMainConversation(workspace);
    if (!main) continue;
    mains.push([workspace, main]);
    await adoptLiveWork(storage, workspace, main, true, byProject.get(workspace.projectId) ?? []);
  }
  if (mains.length === 0) return;
  const synced = await storage.synchronizeAgentMailboxes().then(
    () => {
      log.recovered("mail.reconcile-failed");
      return true;
    },
    (error: unknown) => {
      log.throttled("warn", "mail.reconcile-failed", {
        error,
        fields: () => ({ error: formatLogError(error) }),
      });
      return false;
    },
  );
  if (!synced) return;
  const owed = await storage.coordinators.listOwedCoordinatorDelegationIds();
  for (const [workspace, main] of mains) await moveClosedMainMail(storage, workspace, main, owed);
}

/**
 * What was waiting in a closed main's inbox — a held report above all —
 * belongs to the open one. `owed` keeps a report held for a delegation that
 * still owes its wake.
 */
async function moveClosedMainMail(
  storage: Storage,
  workspace: CoordinatorWorkspace,
  main: CoordinatorConversation,
  owed: ReadonlySet<string>,
): Promise<void> {
  await storage
    .moveClosedCoordinatorMail(
      workspace.id,
      { environmentId: coordinatorRuntimeId(workspace.id, main.id), tabId: main.tabId },
      owed,
    )
    .catch((error) => {
      log.warn("mail.move-failed", { error: formatLogError(error) });
    });
}

/**
 * Move delegations and workflows other conversations still owe onto the
 * main. `associations` is the project's records when the caller already read
 * them.
 */
async function adoptLiveWork(
  storage: Storage,
  workspace: CoordinatorWorkspace,
  main: CoordinatorConversation,
  closedOnly: boolean,
  associations?: readonly CoordinatorWorkflowAssociation[],
): Promise<void> {
  for (const association of associations ??
    (await storage.coordinators.listCoordinatorWorkflowAssociations(workspace.projectId))) {
    if (
      association.coordinatorId !== workspace.id ||
      association.conversationId === main.id ||
      !liveWork(association) ||
      (closedOnly &&
        workspace.conversations.some(
          (item) => item.id === association.conversationId && !item.closedAt,
        ))
    ) {
      continue;
    }
    await storage.coordinators
      .adoptCoordinatorWorkflowAssociation(
        workspace.projectId,
        workspace.id,
        association.id,
        main.id,
        { force: true },
      )
      .catch((error) => {
        log.warn("work.move-failed", { error: formatLogError(error) });
      });
  }
}
