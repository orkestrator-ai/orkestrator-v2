import type {
  NativeAgentPermissionRule,
  PermissionRuleApplication,
} from "@orkestrator/protocol/permission-rules";

import type { NativeMessage } from "./native-message-types";

const PERMISSION_RULE_ROW_PREFIX = "permission-rule:";

function permissionRuleRow(
  application: PermissionRuleApplication,
  ruleIds: ReadonlySet<string>,
): NativeMessage {
  return {
    id: `${PERMISSION_RULE_ROW_PREFIX}${application.interactionId}`,
    role: "system",
    content: "",
    createdAt: new Date(application.appliedAt).toISOString(),
    parts: [
      {
        type: "permission-rule",
        content: application.pattern,
        application,
        ruleExists: ruleIds.has(application.ruleId),
      },
    ],
  };
}

/**
 * The transcript with an "Approved by rule" note for each request an
 * Orkestrator permission rule answered (todo 0723), each placed after the last
 * row that started before it, like the user's `!` command cards.
 */
export function withPermissionRuleRows(
  messages: readonly NativeMessage[],
  applications: readonly PermissionRuleApplication[],
  rules: readonly NativeAgentPermissionRule[],
): NativeMessage[] {
  if (applications.length === 0) return [...messages];
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const sorted = [...applications].sort((a, b) => a.appliedAt - b.appliedAt);
  const result: NativeMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const at = Date.parse(message.createdAt);
    while (next < sorted.length && Number.isFinite(at) && sorted[next]!.appliedAt < at) {
      result.push(permissionRuleRow(sorted[next]!, ruleIds));
      next += 1;
    }
    result.push(message);
  }
  for (; next < sorted.length; next += 1) result.push(permissionRuleRow(sorted[next]!, ruleIds));
  return result;
}
