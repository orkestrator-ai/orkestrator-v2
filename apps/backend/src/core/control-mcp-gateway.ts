import type { McpServer } from "@modelcontextprotocol/server";
import { controlMcpConfirmationRule } from "@orkestrator/protocol/control-mcp";
import {
  isPublicActionName,
  isPublicAggregateAction,
  PUBLIC_ACTION_NAMES,
  PUBLIC_LOCAL_ONLY_ACTIONS,
  PUBLIC_ACTIONS,
  publicSuccessEnvelope,
  type PublicActionName,
} from "@orkestrator/protocol/public-api";
import { PUBLIC_ACTION_CLI_COMMANDS } from "@orkestrator/protocol/public-api-cli";
import { PUBLIC_ACTION_INPUTS } from "@orkestrator/protocol/public-api-inputs";
import {
  allowed,
  onNode,
  runPublicAction,
  runStatus,
  type ControlMcpCaller,
} from "./control-mcp-caller.js";
import { integer, leanSchema, text } from "./control-mcp-lean-schema.js";
import {
  adapterError,
  envelopeToolResult,
  type ControlMcpEnvelope,
  type SpokenParts,
} from "./control-mcp-results.js";

/**
 * Tier 1: the gateway. Four meta-tools reveal and run every public action on
 * demand, so a client that loads only the voice core can still do anything
 * the CLI can. `run_action` accepts only `PUBLIC_ACTIONS` names and enters
 * through `runPublicAction`; it is never a wrapper around raw registry
 * dispatch.
 */

export const GATEWAY_TOOL_NAMES = [
  "find_actions",
  "describe_action",
  "run_action",
  "run_status",
] as const;

const MAX_FOUND = 15;

/** Actions a Control MCP credential could ever be granted. */
const GATEWAY_ACTIONS = PUBLIC_ACTION_NAMES.filter(
  (action) => PUBLIC_ACTION_INPUTS[action].capability !== "host",
);

// Only the hints that differ from MCP's defaults, to keep the voice tool list small.
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

function actionRow(caller: ControlMcpCaller, action: PublicActionName) {
  const descriptor = PUBLIC_ACTIONS[action];
  return {
    action,
    summary: descriptor.summary,
    mutation: descriptor.mutation,
    effects: [...descriptor.effects],
    confirmation: controlMcpConfirmationRule(action, caller.profile),
    allowed: allowed(caller, action),
  };
}

/** Every allowed action whose name or summary contains the query's words, best first. */
export function findActions(
  caller: ControlMcpCaller,
  query: string | undefined,
  group: string | undefined,
) {
  const wanted = words(query ?? "");
  const normalizedGroup = group?.trim().toLowerCase();
  const scored = GATEWAY_ACTIONS.flatMap((action, order) => {
    if (normalizedGroup) {
      const capability = PUBLIC_ACTION_INPUTS[action].capability;
      if (capability !== normalizedGroup && !action.startsWith(`${normalizedGroup}.`)) return [];
    }
    // A word in the action's name counts twice a word in its summary.
    const name = words(action);
    const summary = words(PUBLIC_ACTIONS[action].summary);
    const score = wanted.reduce(
      (total, word) =>
        total +
        (name.some((candidate) => candidate.startsWith(word))
          ? 2
          : summary.some((candidate) => candidate.startsWith(word))
            ? 1
            : 0),
      0,
    );
    if (wanted.length > 0 && score === 0) return [];
    return [{ action, score, order }];
  }).sort(
    (a, b) =>
      b.score - a.score ||
      Number(allowed(caller, b.action)) - Number(allowed(caller, a.action)) ||
      a.order - b.order,
  );
  return {
    items: scored.slice(0, MAX_FOUND).map(({ action }) => actionRow(caller, action)),
    total: scored.length,
    more: Math.max(0, scored.length - MAX_FOUND),
  };
}

export function describeAction(caller: ControlMcpCaller, action: PublicActionName) {
  const descriptor = PUBLIC_ACTIONS[action];
  const contract = PUBLIC_ACTION_INPUTS[action];
  const waitConditions =
    "waitConditions" in descriptor && Array.isArray(descriptor.waitConditions)
      ? [...descriptor.waitConditions]
      : [];
  return {
    ...actionRow(caller, action),
    version: descriptor.version,
    observation: descriptor.observation,
    capability: contract.capability,
    ...(contract.confirmWhen ? { confirmWhen: contract.confirmWhen } : {}),
    requestId: descriptor.mutation ? "required" : "refused",
    // run_action's nodeId: one node, or `all` for an aggregate read.
    nodeId: PUBLIC_LOCAL_ONLY_ACTIONS.includes(action)
      ? "refused"
      : isPublicAggregateAction(action)
        ? "optional; all aggregates every node"
        : "optional",
    input: contract.input,
    examples: contract.examples.slice(0, 2),
    waitConditions,
    cli: PUBLIC_ACTION_CLI_COMMANDS[action],
  };
}

/** A speakable sentence for any public envelope. */
export function sayForEnvelope(envelope: ControlMcpEnvelope): SpokenParts {
  if (!envelope.ok) {
    const details = envelope.error.details;
    return {
      say: envelope.error.message,
      ...(typeof details?.confirmToken === "string"
        ? { ids: { confirmToken: details.confirmToken } }
        : {}),
    };
  }
  const receipt = envelope.receipt;
  if (receipt && PUBLIC_ACTIONS[receipt.action]?.mutation) {
    const state =
      receipt.state === "succeeded"
        ? "done"
        : receipt.state === "running" || receipt.state === "admitted"
          ? "started; check back with run_status"
          : receipt.state;
    return {
      say: `${receipt.action} ${state}.`,
      ids: {
        sessionId: receipt.resources.sessionId,
        environmentId: receipt.resources.environmentId,
      },
    };
  }
  const result = envelope.result as Record<string, unknown> | null;
  if (result && Array.isArray(result.items)) {
    const total = typeof result.total === "number" ? result.total : result.items.length;
    return { say: `${total} found.` };
  }
  return { say: "Done." };
}

function successEnvelope(tool: string, result: unknown): ControlMcpEnvelope {
  return publicSuccessEnvelope(tool, result) as ControlMcpEnvelope;
}

const FIND_INPUT = leanSchema<{ query?: string; group?: string }>({
  query: text("Words to match, e.g. stop environment."),
  group: text("A capability or name prefix, e.g. sessions.control or session."),
});
const DESCRIBE_INPUT = leanSchema<{ action: string }>({ action: text("e.g. session.prompt") }, [
  "action",
]);
const NODE_ID = text("From node.list; omit for this machine.");
const RUN_INPUT = leanSchema<{
  action: string;
  input?: Record<string, unknown>;
  requestId?: string;
  confirmToken?: string;
  nodeId?: string;
}>(
  {
    action: text(),
    input: { type: "object", description: "The action's input; see describe_action." },
    requestId: text("Mutations only."),
    confirmToken: text(),
    nodeId: text("From node.list; all for every machine's lists."),
  },
  ["action"],
);
const STATUS_INPUT = leanSchema<{
  operationId?: string;
  requestId?: string;
  action?: string;
  waitSeconds?: number;
  nodeId?: string;
}>({
  operationId: text(),
  requestId: text(),
  action: text(),
  waitSeconds: integer(0, 20),
  nodeId: NODE_ID,
});

export function registerGatewayTools(server: McpServer, caller: ControlMcpCaller): void {
  const profile = caller.profile;
  server.registerTool(
    "find_actions",
    {
      description:
        "Search every Orkestrator action this credential can run (up to 15). Then describe_action for its input and run_action to run it.",
      inputSchema: FIND_INPUT,
      annotations: readOnly,
    },
    async ({ query, group }) => {
      const found = findActions(caller, query, group);
      return envelopeToolResult(successEnvelope("find_actions", found), profile, {
        say: found.items.length
          ? `${found.total} actions: ${found.items
              .slice(0, 5)
              .map((row) => row.action)
              .join(", ")}${found.total > 5 ? ", and more" : ""}.`
          : "No matching action.",
      });
    },
  );

  server.registerTool(
    "describe_action",
    {
      description:
        "Input schema, examples, wait conditions, confirmation rule and CLI equivalent of one action.",
      inputSchema: DESCRIBE_INPUT,
      annotations: readOnly,
    },
    async ({ action }) => {
      if (!isPublicActionName(action) || PUBLIC_ACTION_INPUTS[action].capability === "host") {
        return envelopeToolResult(
          adapterError(action, "unsupported", "Not an available action; use find_actions"),
          profile,
        );
      }
      const described = describeAction(caller, action);
      return envelopeToolResult(successEnvelope("describe_action", described), profile, {
        say: `${action}: ${described.summary}${described.allowed ? "" : " This credential may not run it."}`,
      });
    },
  );

  server.registerTool(
    "run_action",
    {
      description:
        "Run one action from find_actions with its input. Mutations need requestId (reuse it only to retry). nodeId runs it on another machine from node.list. If the result is confirmation-required, read its description aloud, get a yes, and repeat the identical call with confirmToken.",
      inputSchema: RUN_INPUT,
      annotations: { idempotentHint: true },
    },
    async ({ action, input, requestId, confirmToken, nodeId }) => {
      const envelope = await runPublicAction(
        onNode(caller, nodeId),
        action,
        input ?? {},
        requestId,
        confirmToken,
      );
      return envelopeToolResult(envelope, profile, sayForEnvelope(envelope));
    },
  );

  server.registerTool(
    "run_status",
    {
      description:
        "Read a run by operationId or requestId (with action), with the nodeId it ran on. waitSeconds (0-20) waits for it to settle; prefer 0 and check back later.",
      inputSchema: STATUS_INPUT,
      annotations: readOnly,
    },
    async ({ operationId, requestId, action, waitSeconds, nodeId }) => {
      if (Boolean(operationId) === Boolean(requestId)) {
        return envelopeToolResult(
          adapterError("run.get", "invalid-input", "Pass operationId or requestId"),
          profile,
        );
      }
      const outcome = await runStatus(
        onNode(caller, nodeId),
        operationId ? { operationId } : { requestId, ...(action ? { action } : {}) },
        waitSeconds ?? 0,
      );
      const receipt = outcome.envelope.receipt;
      const verdict = outcome.verdict;
      const parts: SpokenParts =
        receipt && verdict
          ? {
              say:
                verdict.kind === "terminal"
                  ? `${receipt.action} ${receipt.state}${receipt.error ? `: ${receipt.error.message}` : ""}.`
                  : verdict.kind === "stopped"
                    ? verdict.message
                    : `${receipt.action} is still ${receipt.state}.`,
              ids: { operationId: receipt.operationId, sessionId: receipt.resources.sessionId },
              ...(verdict.kind === "stopped" && verdict.code === "interaction-required"
                ? { next: "Answer it with answer_question." }
                : {}),
            }
          : sayForEnvelope(outcome.envelope);
      return envelopeToolResult(outcome.envelope, profile, parts, {
        ...(outcome.envelope as unknown as Record<string, unknown>),
        ...(verdict ? { wait: { verdict: verdict.kind, waitedMs: outcome.waitedMs } } : {}),
      });
    },
  );
}
