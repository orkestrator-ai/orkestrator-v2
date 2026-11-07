/**
 * The model behind agent voice chat replies: one quick, tool-free CLI run per
 * reply, on the same isolated one-shot path as session titles
 * (`session-title-runners.ts`), with a voice prompt and a longer output cap.
 *
 * A reply is a single spoken sentence or two, so it does not need an agent
 * turn, tools or a provider session: the prompt already carries the project's
 * state, gathered by the Control MCP tool under the caller's own authority.
 * Keeping it to a one-shot run is what makes the reply fast enough to speak.
 *
 * Strategy choice, the failure cooldown and the concurrency bound are the
 * title service's (`SessionTitleService`), constructed with these generators.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  AGENT_VOICE_CHAT_LIMITS,
  AGENT_VOICE_CHAT_SYSTEM_PROMPT,
  sanitizeAgentVoiceChatReply,
} from "@orkestrator/protocol/agent-voice-chat";
import type { CommandContext } from "./commands-context.js";
import {
  buildClaudeOneShotCommandArgs,
  buildCodexOneShotCommandArgs,
  buildCodexOneShotModelCatalog,
  type SessionTitleRunInput,
} from "./session-title-runners.js";
import { oneShotAgentRunDependencies, SessionTitleService } from "./session-title-service.js";

/** Largest reply file `codex exec` may write before it is ignored. */
const MAX_REPLY_FILE_BYTES = 64 * 1024;
/** A prompt is a bounded digest plus bounded turns; anything larger is refused. */
const MAX_PROMPT_BYTES = 64 * 1024;

export async function generateClaudeAgentVoiceChatReply(
  input: SessionTitleRunInput,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    path.join(input.temporaryRoot ?? tmpdir(), "orkestrator-voice-chat-"),
  );
  try {
    const { stdout } = await input.run(
      input.executable,
      buildClaudeOneShotCommandArgs(AGENT_VOICE_CHAT_SYSTEM_PROMPT),
      {
        // An empty directory, so even a project-scoped lookup finds nothing.
        cwd: temporaryDirectory,
        env: input.env,
        stdin: input.source,
        timeoutMs: input.timeoutMs ?? AGENT_VOICE_CHAT_LIMITS.replyTimeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const reply = sanitizeAgentVoiceChatReply(stdout);
    if (!reply) throw new Error("Claude returned an empty voice chat reply");
    return reply;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function generateCodexAgentVoiceChatReply(
  input: SessionTitleRunInput,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    path.join(input.temporaryRoot ?? tmpdir(), "orkestrator-voice-chat-"),
  );
  const outputPath = path.join(temporaryDirectory, "reply.txt");
  const modelCatalogPath = path.join(temporaryDirectory, "model-catalog.json");
  try {
    await writeFile(
      modelCatalogPath,
      JSON.stringify(
        buildCodexOneShotModelCatalog({
          displayName: "Agent voice chat",
          description: "Tool-free model profile for short spoken replies.",
          baseInstructions: AGENT_VOICE_CHAT_SYSTEM_PROMPT,
        }),
      ),
      "utf8",
    );
    const { stdout } = await input.run(
      input.executable,
      buildCodexOneShotCommandArgs(temporaryDirectory, outputPath, modelCatalogPath),
      {
        cwd: temporaryDirectory,
        env: input.env,
        stdin: input.source,
        timeoutMs: input.timeoutMs ?? AGENT_VOICE_CHAT_LIMITS.replyTimeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const written = await readFile(outputPath).catch(() => undefined);
    if (written && written.length > MAX_REPLY_FILE_BYTES) {
      throw new Error("Codex voice chat output exceeded the limit");
    }
    const reply = sanitizeAgentVoiceChatReply(written ? written.toString("utf8") : stdout);
    if (!reply) throw new Error("Codex returned an empty voice chat reply");
    return reply;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The production composition must never spend a login under the test runner. */
export function agentVoiceChatRepliesEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== "test" && env.ORKESTRATOR_AGENT_VOICE_CHAT_REPLIES !== "0";
}

export function createAgentVoiceChatReplyService(context: CommandContext): SessionTitleService {
  return new SessionTitleService({
    ...oneShotAgentRunDependencies(context),
    generators: {
      claude: generateClaudeAgentVoiceChatReply,
      codex: generateCodexAgentVoiceChatReply,
    },
    timeoutMs: AGENT_VOICE_CHAT_LIMITS.replyTimeoutMs,
    // Short: a voice conversation should not lose a login for ten minutes over one timeout.
    failureCooldownMs: 60_000,
    maxConcurrent: 4,
    maxQueued: 16,
  });
}

export class AgentVoiceChatReplyUnavailableError extends Error {
  constructor() {
    super("No signed-in Claude or Codex login could answer the voice chat");
    this.name = "AgentVoiceChatReplyUnavailableError";
  }
}

export interface AgentVoiceChatReplier {
  /** One spoken reply to a prompt built by `buildAgentVoiceChatPrompt`. */
  reply(input: { prompt: string; agent?: string }): Promise<string>;
  /** Stops every run in flight and refuses new ones. */
  shutdown(): Promise<void>;
}

/**
 * The backend's replier, handed straight to the Control MCP listener. It is
 * deliberately not a registry command: every command-bridge client can call
 * any registered command, and a model run on the user's login over an
 * arbitrary prompt is not something those clients need.
 */
export function createAgentVoiceChatReplier(
  context: CommandContext,
  env: NodeJS.ProcessEnv = process.env,
): AgentVoiceChatReplier {
  const service = agentVoiceChatRepliesEnabled(env)
    ? createAgentVoiceChatReplyService(context)
    : null;
  return {
    async reply({ prompt, agent }) {
      if (!prompt.trim()) throw new Error("prompt is required");
      if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES)
        throw new Error("prompt is too long");
      if (!service) throw new AgentVoiceChatReplyUnavailableError();
      const preferred: AgentPlatform = isAgentPlatform(agent) ? agent : "claude";
      const generated = await service.generate({ agent: preferred, source: prompt });
      if (!generated) throw new AgentVoiceChatReplyUnavailableError();
      return generated.title;
    },
    async shutdown() {
      await service?.shutdown();
    },
  };
}
