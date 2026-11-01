import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { readRepositoryInstructions } from "@orkestrator/protocol/node/repository-instructions";

/**
 * The system-level instructions a new session carries
 * (`sessionInstructionsMeta`): the instructions every Orkestrator provider
 * receives, which a read-only coordinator does not get, then the
 * repository's AGENTS.md unless the session trusts the checkout, in which
 * case the agent loads it itself (`PROJECT_TRUST`). Read-only sessions and
 * coordinators read AGENTS.md too, without trusting anything else.
 */
export async function sessionInstructions(
  policy: NativeAgentExecutionPolicy | undefined,
  cwd: string,
): Promise<string | undefined> {
  const parts = [
    policy?.id === "coordinator-read-only" ? undefined : agentSystemInstructions(),
    policy?.projectResources === true ? undefined : await readRepositoryInstructions(cwd),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
