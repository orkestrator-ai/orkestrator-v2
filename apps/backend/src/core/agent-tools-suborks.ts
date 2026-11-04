/**
 * `ask_agents`: the one Orkestrator tool behind suborks, the same name, shape and
 * behaviour on every provider, offered from the general agent tools server. It
 * returns a handle at once; see `docs/architecture/suborks.md` for why.
 */
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import { SUBORK_LIMITS, SUBORK_TOOL_NAME } from "@orkestrator/protocol/suborks";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
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

/**
 * Deliberately says when to use the tool and when not, because the plain-text
 * form ("ask opus 5.5 and grok 4.7 to rate this") relies on it: the backend does
 * not parse natural language.
 */
export const SUBORK_TOOL_DESCRIPTION = `Ask one or more other agents and get their answers back. Use this whenever the person asks you to ask, consult or get a second opinion from other agents or models by name, for example "ask codex to review this index.html" or "ask opus 5.5 and grok 4.7 to rate this code change out of 10". Use it instead of your own sub-agent or task tools for those requests.

Each target runs in parallel as a fresh read-only session in this workspace, in this working directory. It can read files and run commands that change nothing, and it cannot edit. It sees only the prompt you write and nothing of this conversation, so name every file, diff and fact it needs. It answers once.

The call returns immediately with a handle and does not wait. End your turn after calling it. All the answers arrive together, each labelled with its agent and model, in a new message that wakes you, and you continue from there. A target that is unknown, ambiguous or disabled fails on its own with a message listing close options, and the others still run. At most ${SUBORK_LIMITS.targetsPerCall} targets per call.`;

const REFUSAL =
  "Suborks can't start suborks. Answer from what you can do yourself and say what you could not check.";

const inputSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            agent: z
              .string()
              .trim()
              .min(1)
              .max(SUBORK_LIMITS.targetTextMaxChars)
              .optional()
              .describe(
                "An agent name, such as codex. Alone, it means that agent's saved default.",
              ),
            model: z
              .string()
              .trim()
              .min(1)
              .max(SUBORK_LIMITS.targetTextMaxChars)
              .optional()
              .describe("A model as the person said it, such as opus 5.5 or grok 4.7."),
            name: z
              .string()
              .trim()
              .min(1)
              .max(SUBORK_LIMITS.nameMaxChars)
              .optional()
              .describe("A short title for the transcript, such as Opus review."),
            prompt: z
              .string()
              .min(1)
              .optional()
              .describe("A prompt for this target only, instead of the shared one."),
          })
          .strict(),
      )
      .min(1)
      // Bounded for the request, not the limit: targets past the limit fail on their own.
      .max(32),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe("The self-contained prompt every target receives, unless it has its own."),
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe("Repeat this to retry the same call without starting it twice."),
    tabId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe("Your own tab, when this environment has several and your credential is shared."),
  })
  .strict();

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

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
      inputSchema,
      annotations: ANNOTATIONS,
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
          `${SUBORK_TOOL_NAME} works in native agent tabs only: a ${descriptor.kind} tab cannot be woken with the answers.`,
        );
      }
      // Every native tab but OpenCode's has its own credential. One arriving on
      // the shared connection is not that tab's own turn: it may be a subork.
      if (!scope.tabId && descriptor.agent !== "opencode") throw new Error(REFUSAL);
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
      inputSchema: z.object({}).passthrough(),
      annotations: { ...ANNOTATIONS, readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      throw new Error(REFUSAL);
    },
  );
}
