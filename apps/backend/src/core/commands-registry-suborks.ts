import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { assertOnlyKeys, asNonBlankString } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";

/** The transcript one read returns, like a graph run's. */
const TRANSCRIPT_READ_MAX_BYTES = 4 * 1024 * 1024;

function agentOf(value: unknown): AgentPlatform {
  if (!isAgentPlatform(value)) throw new Error("agent is not a supported platform");
  return value;
}

/**
 * The transcript's subork group: the person stopping a session's running calls,
 * and reading one subork's stored transcript. Reading never touches the provider,
 * so it neither keeps an idle session alive nor re-attaches one.
 */
export function registerSuborkCommands(register: CommandRegistrar): void {
  register("stop_native_agent_suborks", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "agent", "logicalSessionKey", "batchId"], "arguments");
    const sessionKey = nativeAgentSessionStorageKey(
      asNonBlankString(args.environmentId, "environmentId"),
      agentOf(args.agent),
      asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    );
    await context.suborks?.stopForSession(
      sessionKey,
      args.batchId === undefined ? undefined : asNonBlankString(args.batchId, "batchId"),
    );
    return null;
  });

  register("native_agent_subork_transcript", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "batchId", "suborkId"], "arguments");
    if (!context.suborks) throw new Error("Suborks are unavailable on this backend");
    return context.suborks.readTranscript({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      batchId: asNonBlankString(args.batchId, "batchId"),
      suborkId: asNonBlankString(args.suborkId, "suborkId"),
      maxBytes: TRANSCRIPT_READ_MAX_BYTES,
    });
  });
}
