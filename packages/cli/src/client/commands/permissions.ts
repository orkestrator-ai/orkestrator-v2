import type { PublicPermissionRuleList } from "@orkestrator/protocol/public-api-resources";
import { keyValues, table } from "../format.js";
import type { CommandSpec } from "../spec.js";
import { REQUEST_ID_OPTION, submit } from "./common.js";

/**
 * `orkestrator permissions rules …`: the connected node's Orkestrator
 * permission rules (todo 0723). List and remove only; a rule is created only
 * from a person's click on an approval card in the app.
 */

function when(epochMs: number | undefined): string {
  return epochMs === undefined ? "-" : new Date(epochMs).toISOString();
}

export const permissionCommands: CommandSpec[] = [
  {
    path: ["permissions", "rules", "list"],
    action: "permission.rule.list",
    summary: "List this node's Orkestrator permission rules, their scope, last use and use count.",
    positionals: [],
    options: [
      {
        name: "project",
        kind: "string",
        valueName: "PROJECT_ID",
        description: "Only rules of this project.",
      },
    ],
    idOutput: "rule IDs",
    async run(context, parsed) {
      const session = await context.session();
      const project = parsed.options.project;
      const list = await session.read<PublicPermissionRuleList>(
        "permission.rule.list",
        project !== undefined ? { projectId: project } : {},
      );
      return {
        action: "permission.rule.list",
        result: list,
        connection: session.identity,
        ids: list.rules.map((rule) => rule.id),
        human: table(
          ["ID", "KIND", "PATTERN", "AGENT", "SCOPE", "USES", "LAST USED", "EXPIRES"],
          list.rules.map((rule) => [
            rule.id,
            rule.kind,
            rule.pattern,
            rule.provider,
            rule.scope === "environment" ? `environment ${rule.environmentId}` : "project",
            String(rule.useCount),
            when(rule.lastUsedAt),
            when(rule.expiresAt),
          ]),
        ),
      };
    },
  },
  {
    path: ["permissions", "rules", "remove"],
    action: "permission.rule.remove",
    summary: "Remove a permission rule; matching requests ask again from the next one.",
    positionals: [
      { name: "rule", required: true, description: "Rule ID, from `permissions rules list`." },
    ],
    options: [REQUEST_ID_OPTION],
    inputFields: { rule: "ruleId" },
    idOutput: "rule ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit<Record<string, unknown>>(
        context,
        "permission.rule.remove",
        { ruleId: parsed.positionals.rule },
        parsed.options,
      );
      return {
        action: "permission.rule.remove",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [String(parsed.positionals.rule)],
        human: keyValues(Object.entries(result)),
      };
    },
  },
];
