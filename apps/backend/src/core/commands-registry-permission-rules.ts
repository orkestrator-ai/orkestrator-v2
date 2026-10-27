import {
  isPermissionRuleScope,
  type PermissionRulesSnapshot,
} from "@orkestrator/protocol/permission-rules";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  asNonBlankString,
  asOptionalString,
  asRequiredBoolean,
  asString,
  assertOnlyKeys,
} from "./commands-validation.js";
import { listExternalPermissionRules } from "./permission-rules/external-rules.js";
import type { PermissionRuleStore } from "./permission-rules/store.js";

/**
 * Orkestrator's own permission rules (todo 0723): list and remove them, and
 * the card's "Approve and remember".
 *
 * Rule creation is deliberately only `approve_native_agent_interaction_and_remember`,
 * which needs a request that is pending right now and a pattern the backend
 * itself offered for it. No public action, MCP tool or coordinator tool maps
 * onto it, so an agent can never create a rule.
 */

function store(context: CommandContext): PermissionRuleStore {
  if (typeof context.storage.permissionRuleStore !== "function") {
    throw new Error("Permission rules are unavailable");
  }
  return context.storage.permissionRuleStore();
}

export function registerPermissionRuleCommands(register: CommandRegistrar): void {
  register("list_permission_rules", async (args, context): Promise<PermissionRulesSnapshot> => {
    assertOnlyKeys(args, ["projectId", "environmentId", "agent", "logicalSessionKey"], "arguments");
    const projectId = asOptionalString(args.projectId);
    const environmentId = asOptionalString(args.environmentId);
    const agent = asOptionalString(args.agent);
    const logicalSessionKey = asOptionalString(args.logicalSessionKey);
    const rules = store(context);
    return {
      rules: projectId ? rules.listForProject(projectId) : rules.list(),
      applications: rules
        .listApplications({
          ...(environmentId ? { environmentId } : {}),
          ...(agent ? { agent } : {}),
          ...(logicalSessionKey ? { logicalSessionKey } : {}),
        })
        .slice(-200),
    };
  });

  register("delete_permission_rule", async (args, context) => {
    assertOnlyKeys(args, ["id"], "arguments");
    return { deleted: store(context).delete(asNonBlankString(args.id, "id")) };
  });

  register("delete_project_permission_rules", async (args, context) => {
    assertOnlyKeys(args, ["projectId"], "arguments");
    const ids = store(context).deleteForProject(asNonBlankString(args.projectId, "projectId"));
    return { deleted: ids.length };
  });

  register("approve_native_agent_interaction_and_remember", async (args, context) => {
    assertOnlyKeys(
      args,
      [
        "environmentId",
        "agent",
        "logicalSessionKey",
        "interactionId",
        "pattern",
        "scope",
        "anyProvider",
        "expiresInMs",
      ],
      "arguments",
    );
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    const scope = asString(args.scope, "scope");
    if (!isPermissionRuleScope(scope)) throw new Error("scope must be project or environment");
    const expiresInMs = args.expiresInMs;
    if (expiresInMs !== undefined && expiresInMs !== null && !Number.isSafeInteger(expiresInMs)) {
      throw new Error("expiresInMs must be an integer");
    }
    return context.nativeAgents.approveProjectionInteractionAndRemember({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      interactionId: asNonBlankString(args.interactionId, "interactionId"),
      choice: {
        pattern: asNonBlankString(args.pattern, "pattern"),
        scope,
        anyProvider: asRequiredBoolean(args.anyProvider, "anyProvider"),
        ...(typeof expiresInMs === "number" ? { expiresInMs } : {}),
      },
    });
  });

  register("list_external_permission_rules", async (args, context) => {
    assertOnlyKeys(args, ["projectId"], "arguments");
    const projectId = asOptionalString(args.projectId);
    return listExternalPermissionRules(context, projectId);
  });
}
