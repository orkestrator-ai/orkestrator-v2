import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  nativeAgentSuborkTranscriptCommand,
  stopNativeAgentSuborksCommand,
} from "@orkestrator/protocol/contract/domains/native-sessions";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { asNonBlankString } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { withAsyncArgumentFailures } from "./commands-registry-async-args.js";
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
 *
 * Both are defined commands (`native-sessions`, plan item 7001): unknown keys
 * are dropped rather than refused, and `batchId` is critical on the stop.
 */
export function registerSuborkCommands(registerCommand: CommandRegistrar): void {
  // `async` handlers keep rejecting on bad arguments (`commands-registry-async-args.ts`).
  const register = withAsyncArgumentFailures(registerCommand);
  register(stopNativeAgentSuborksCommand, async (args, context) => {
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

  register(nativeAgentSuborkTranscriptCommand, async (args, context) => {
    if (!context.suborks) throw new Error("Suborks are unavailable on this backend");
    if (
      args.fromIndex !== undefined &&
      (!Number.isSafeInteger(args.fromIndex) || (args.fromIndex as number) < 0)
    ) {
      throw new Error("fromIndex must be a non-negative safe integer");
    }
    return context.suborks.readTranscript({
      ...(args.fromIndex !== undefined ? { fromIndex: args.fromIndex as number } : {}),
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      batchId: asNonBlankString(args.batchId, "batchId"),
      suborkId: asNonBlankString(args.suborkId, "suborkId"),
      maxBytes: TRANSCRIPT_READ_MAX_BYTES,
    });
  });
}
