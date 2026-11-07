/**
 * `ask_agents`: the one Orkestrator tool behind suborks, the same name, shape and
 * behaviour on every provider, offered from the general agent tools server. It
 * returns a handle at once; see `docs/architecture/suborks.md` for why.
 */
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import { SUBORK_TOOL_NAME } from "@orkestrator/protocol/suborks";
import { McpServer } from "@modelcontextprotocol/server";
import { looseObject, toolInput } from "./tool-schema.js";
import {
  SUBORK_TOOL_ANNOTATIONS,
  SUBORK_TOOL_DESCRIPTION,
  SUBORK_TOOL_INPUT_SCHEMA,
} from "./agent-tools-subork-schema.js";
import {
  assertCallerMailbox,
  type AgentMessagingRateLimitKind,
  type AgentMessagingToolScope,
} from "./agent-tools-messaging.js";
import type { SuborkAskInput, SuborkAskResult, SuborkCaller } from "./native-agent-suborks.js";
import type { StorageService } from "./storage.js";

/** What the tool needs from the subork service. */
export interface SuborkToolHost {
  ask(caller: SuborkCaller, input: SuborkAskInput): Promise<SuborkAskResult>;
}

const REFUSAL =
  "Suborks can't start suborks. Answer from what you can do yourself and say what you could not check.";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export { SUBORK_TOOL_DESCRIPTION };

/** Listed for every native tab, because a provider may cache a session's tool list. */
export function registerSuborkTools(
  server: McpServer,
  storage: StorageService,
  scope: AgentMessagingToolScope,
  host: SuborkToolHost,
  consumeRateLimit: (kind: AgentMessagingRateLimitKind) => void,
): void {
  server.registerTool(
    SUBORK_TOOL_NAME,
    {
      title: "Ask other agents",
      description: SUBORK_TOOL_DESCRIPTION,
      inputSchema: toolInput(SUBORK_TOOL_INPUT_SCHEMA),
      annotations: SUBORK_TOOL_ANNOTATIONS,
    },
    async ({ targets, prompt, requestId, tabId }) => {
      consumeRateLimit("send");
      let resolved: Awaited<ReturnType<typeof assertCallerMailbox>>;
      try {
        resolved = await assertCallerMailbox(storage, scope, tabId);
      } catch (error) {
        if (error instanceof AgentMailError) throw new Error(error.message);
        throw error;
      }
      const { descriptor } = resolved.mailbox;
      if (descriptor.kind !== "native" || !descriptor.agent) {
        throw new Error(
          `${SUBORK_TOOL_NAME} works in agent tabs and coordinator conversations: a ${descriptor.kind} tab cannot be woken with the answers.`,
        );
      }
      if (descriptor.mutedInbound) {
        throw new Error(
          "This tab's inbound mail is muted, and suborks answer by mail. Unmute it first.",
        );
      }
      const caller: SuborkCaller = {
        environmentId: scope.environmentId,
        projectId: scope.projectId,
        tabId: resolved.identity.tabId,
        agent: descriptor.agent,
        ...(descriptor.injectOverride === "off" ? { inboxOnly: true } : {}),
      };
      return toolResult(
        await host.ask(caller, {
          targets,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
        }),
      );
    },
  );
}

/**
 * What a subork finds if it reaches for the tool: its turn runs on a result-only
 * credential, so the attempt gets a clear refusal rather than a missing tool.
 */
export function registerSuborkRefusalTool(server: McpServer): void {
  server.registerTool(
    SUBORK_TOOL_NAME,
    {
      title: "Ask other agents",
      description: `Not available to you: you are a subork. ${REFUSAL}`,
      inputSchema: toolInput(looseObject({})),
      annotations: { ...SUBORK_TOOL_ANNOTATIONS, readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      throw new Error(REFUSAL);
    },
  );
}
