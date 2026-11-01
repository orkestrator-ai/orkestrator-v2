import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { readRepositoryInstructions } from "@orkestrator/protocol/node/repository-instructions";

/**
 * The system-level instructions a new session carries
 * (`sessionInstructionsMeta`): the instructions every Orkestrator provider
 * receives, which a read-only coordinator does not get, then the
 * repository's AGENTS.md unless the session trusts the checkout, in which
 * case the agent loads it itself (`PROJECT_TRUST`). Read-only sessions exclude
 * branch-controlled instructions.
 */
export async function sessionInstructions(
  policy: NativeAgentExecutionPolicy | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (policy?.id === "coordinator-read-only") return undefined;
  const parts = [
    agentSystemInstructions(),
    policy?.projectResources === true ? undefined : await readRepositoryInstructions(cwd),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
