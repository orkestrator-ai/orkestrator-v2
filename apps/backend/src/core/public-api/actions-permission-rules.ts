import type { PublicPermissionRuleList } from "@orkestrator/protocol/public-api-resources";
import type { PermissionRuleStore } from "../permission-rules/store.js";
import { PublicActionError } from "./errors.js";
import { onlyActionKeys, optionalString, requiredId } from "./input.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Orkestrator's permission rules (todo 0723) through the public API: list and
 * remove only. Creating a rule needs a person's click on an approval card
 * (`approve_native_agent_interaction_and_remember`), so no public action, CLI
 * command or MCP tool can create one; removing one only makes requests ask
 * again.
 */

function store(context: PublicActionContext): PermissionRuleStore {
  if (typeof context.command.storage.permissionRuleStore !== "function") {
    throw new PublicActionError("capability-unavailable", "Permission rules are unavailable");
  }
  return context.command.storage.permissionRuleStore();
}

const ruleList: ReadActionHandler<{ projectId?: string }> = {
  kind: "read",
  action: "permission.rule.list",
  parse(input) {
    onlyActionKeys(input, "permission.rule.list");
    const projectId = optionalString(input, "projectId");
    return projectId ? { projectId } : {};
  },
  async run(input, context) {
    const rules = input.projectId
      ? store(context).listForProject(input.projectId)
      : store(context).list();
    const result: PublicPermissionRuleList = { rules, total: rules.length };
    return { result };
  },
};

const ruleRemove: MutationActionHandler<{ ruleId: string }> = {
  kind: "mutation",
  action: "permission.rule.remove",
  parse(input) {
    onlyActionKeys(input, "permission.rule.remove");
    const ruleId = requiredId(input, "ruleId");
    return { value: { ruleId }, scope: `permission-rule:${ruleId}`, intent: { ruleId } };
  },
  async prepare(input, context) {
    if (!store(context).get(input.ruleId)) {
      throw new PublicActionError("not-found", "No permission rule has that ID");
    }
    return {
      async execute() {
        return {
          state: "succeeded",
          result: { ruleId: input.ruleId, removed: store(context).delete(input.ruleId) },
        };
      },
    };
  },
};

export const PERMISSION_RULE_HANDLERS: PublicActionHandler[] = [ruleList, ruleRemove];
