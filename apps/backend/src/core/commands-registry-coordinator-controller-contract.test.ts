/**
 * The controller part of the `coordinator` domain is registered with its
 * definitions (plan item 7009): each name once, with access matching the
 * workspace exclusion, every key a handler reads surviving the tolerant
 * decode, and a coordinator's in-process delegation presentation (a symbol
 * key, which decoding drops) still reaching the job launch.
 */
import { describe, expect, it } from "bun:test";
import {
  COORDINATOR_CONTROLLER_COMMANDS,
  launchControlJobCommand,
  launchNativeAgentJobCommand,
  sendCoordinatorNodeMailCommand,
} from "@orkestrator/protocol/contract/domains/coordinator";
import { decodeCommandArgs } from "@orkestrator/protocol/contract/command";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registrarFrom } from "./commands-registry-contracts.js";
import { registerControlCommands } from "./commands-registry-control.js";
import { registerControllerWorkflowCommands } from "./commands-registry-controller-workflows.js";
import { registerCoordinatorNodeCommands } from "./commands-registry-coordinator-nodes.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { withCoordinatorDelegationPresentation } from "./coordinator-delegation-authority.js";
import { registerCoordinatorForkWorker } from "./coordinator-fork-worker.js";
import { registerCoordinatorWorkerChanges } from "./coordinator-worker-changes.js";
import { grantAdmits } from "./nodes/workspace-grant-test-support.js";

function registered() {
  const commands = new Map<string, CommandHandler>();
  const names: string[] = [];
  const register = registrarFrom((name, handler) => {
    names.push(name);
    commands.set(name, handler);
  });
  const dependencies = { commands } as unknown as RegistryDependencies;
  registerControlCommands(register, dependencies);
  registerControllerWorkflowCommands(register, dependencies);
  registerCoordinatorNodeCommands(register);
  registerCoordinatorForkWorker(register, dependencies);
  registerCoordinatorWorkerChanges(register, dependencies);
  return { commands, names };
}

/** Keys the launch handler reads (`launchNativeAgentJobInternal`). */
const JOB_KEYS = [
  "environmentId",
  "requestId",
  "prompt",
  "title",
  "agent",
  "agentDefaulted",
  "conversationMode",
  "literal",
  "reviewTab",
  "attachments",
  "modelId",
  "reasoningId",
  "fastMode",
  "activateTab",
  "autoMergeEnabledAt",
];

describe("coordinator controller commands", () => {
  it("registers every controller definition, and nothing else, by its definition", () => {
    const { names } = registered();
    const defined = COORDINATOR_CONTROLLER_COMMANDS.map((def) => def.name);
    expect([...names].sort()).toEqual([...defined].sort());
  });

  it("a workspace grant runs exactly the controller commands defined as workspace", () => {
    for (const def of COORDINATOR_CONTROLLER_COMMANDS) {
      expect({ name: def.name, workspace: def.access === "workspace" }).toEqual({
        name: def.name,
        workspace: grantAdmits(def.name),
      });
    }
  });

  it("keeps every key the handlers read", () => {
    const value = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, key]));
    const job = value(JOB_KEYS);
    const decodedJob = decodeCommandArgs(launchControlJobCommand, job);
    expect(decodedJob._tag === "Success" && decodedJob.success).toEqual(job);
    const native = value([...JOB_KEYS, "autoMergePrUrl", "completionAction", "tabReuse", "tabId"]);
    const decodedNative = decodeCommandArgs(launchNativeAgentJobCommand, native);
    expect(decodedNative._tag === "Success" && decodedNative.success).toEqual(native);
    const mail = value([
      "scope",
      "nodeId",
      "toEnvironmentId",
      "toTabId",
      "requestId",
      "subject",
      "body",
      "attachments",
      "replyToMessageId",
      "deliverNow",
    ]);
    const decodedMail = decodeCommandArgs(sendCoordinatorNodeMailCommand, mail);
    expect(decodedMail._tag === "Success" && decodedMail.success).toEqual(mail);
  });

  it("carries a coordinator's delegation presentation past argument decoding", async () => {
    const { commands } = registered();
    const context = { nativeAgents: {}, storage: {} } as unknown as CommandContext;
    // A presentation that does not match the prompt is refused before anything
    // else runs: the refusal proves the handler saw it.
    const args = withCoordinatorDelegationPresentation(
      { environmentId: "env-1", requestId: "r1", prompt: "plain prompt" },
      { kind: "coordinator-delegation", frame: "not-this-prompt" } as never,
    );
    for (const name of ["launch_control_job", "launch_native_agent_job"]) {
      await expect(Promise.resolve(commands.get(name)!(args, context))).rejects.toThrow(
        "initialPromptPresentation does not match the prompt",
      );
    }
  });
});
