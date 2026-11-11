/**
 * Orkestrator's shared system instructions on an OpenCode session
 * (`agentSystemInstructions`; docs/architecture/agent-engines.md, "System
 * instructions").
 *
 * OpenCode 2's prompt and session routes take no `system` field. The channel
 * is a durable, API-managed instruction entry on the session
 * (`PUT /api/experimental/session/:id/instructions/entries/:key`), which the
 * model sees from its next step and which survives the server: verified on
 * 2.2.6. It is written when a session is created or resumed, under one key,
 * so a write is idempotent. A read-only coordinator gets none, as on every
 * other provider: the rules ask the agent to write files.
 *
 * Best-effort: a server that refuses the experimental route still runs the
 * session, without the instructions, and nothing is retried.
 */
import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { OpenCode2Client } from "./client.js";

const log = createLogger("native-agent.opencode2");

export const OPENCODE2_INSTRUCTIONS_KEY = "orkestrator";

/** Attach the shared instructions to `sessionId`, unless its policy is a read-only coordinator's. */
export async function attachOpenCode2Instructions(
  client: Pick<OpenCode2Client, "api">,
  sessionId: string,
  policy?: Pick<NativeAgentExecutionPolicy, "id">,
): Promise<void> {
  if (policy?.id === "coordinator-read-only") return;
  const value = agentSystemInstructions();
  if (!value) return;
  await client
    .api(
      "PUT",
      `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${OPENCODE2_INSTRUCTIONS_KEY}`,
      "OpenCode session instructions",
      { body: { value }, signal: AbortSignal.timeout(10_000) },
    )
    .catch((error: unknown) => {
      log.debug("instructions.unavailable", { error: formatLogError(error, { message: false }) });
    });
}
