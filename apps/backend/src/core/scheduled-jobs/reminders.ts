import { COORDINATOR_MAIL_ADDRESS, coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { ScheduleAction, ScheduleOwner } from "@orkestrator/protocol/scheduled-jobs";

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** True when a mail action targets the owner's own mailbox. */
export function isReminderToSelf(owner: ScheduleOwner, action: ScheduleAction): boolean {
  if (
    action.kind !== "action" ||
    !(action.action === "mail.send" || action.action === "send_message")
  )
    return false;
  const to = stringField(action.input.toEnvironmentId);
  const toTab = stringField(action.input.toTabId);
  if (owner.kind === "agent") {
    return to === owner.environmentId && (toTab === undefined || toTab === owner.tabId);
  }
  if (owner.kind === "coordinator") {
    if (owner.role === "main" && to === COORDINATOR_MAIL_ADDRESS) return true;
    return to === coordinatorRuntimeId(owner.coordinatorId, owner.conversationId);
  }
  return false;
}
