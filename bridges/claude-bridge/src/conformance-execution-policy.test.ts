/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * over the Claude bridge.
 *
 * A real turn: the session is created through the same call the create route
 * makes, the prompt carries the controls the backend sends, and the options
 * are read from the mocked SDK `query()` call, which is exactly what the CLI
 * is spawned with. The approval axis is observed by handing `canUseTool` a
 * tool no allow list pre-approves and seeing whether it asks, refuses or runs.
 */
import { afterEach } from "bun:test";
import {
  conformancePromptControls,
  runExecutionPolicyConformance,
  type AdapterEffects,
} from "../../../tests/conformance/execution-policy/suite.js";
import { effectiveExecutionPolicy } from "./services/read-only-policy.js";
import {
  createOrRecoverSession,
  getPendingInteractions,
  nextQueryCall,
  respondToInteraction,
  sendPrompt,
  track,
  type QueryCall,
} from "./services/session-manager-test-harness.js";

const settle: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of settle.splice(0)) await run();
});

/** Let the parked-interaction store observe a call it has just been handed. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function observedApprovals(
  sessionId: string,
  options: QueryCall["options"],
): Promise<AdapterEffects["approvals"]> {
  // The CLI never consults the callback in this mode: everything runs.
  if (options.permissionMode === "bypassPermissions") return "auto-approve";
  // `dontAsk` refuses whatever the allow list does not cover, unasked.
  if (options.permissionMode === "dontAsk") return "deny";
  const decision = options.canUseTool!(
    "NotebookEdit",
    { notebook_path: "/workspace/notebook.ipynb", new_source: "" },
    { signal: new AbortController().signal, toolUseID: "conformance", requestId: "conformance" },
  );
  await flushMicrotasks();
  const parked = getPendingInteractions(sessionId);
  if (parked.length > 0) {
    respondToInteraction(parked[0]!.id, { action: "decline" });
    await decision;
    return "ask";
  }
  return (await decision).behavior === "allow" ? "auto-approve" : "deny";
}

runExecutionPolicyConformance({
  platform: "claude",
  async apply(shape) {
    const policy = effectiveExecutionPolicy(shape.policy);
    const session = await createOrRecoverSession(`conformance ${shape.id}`, undefined, policy);
    track(session.id);
    const prompt = sendPrompt(
      session.id,
      "Check the policy",
      conformancePromptControls("claude", shape.policy) as Parameters<typeof sendPrompt>[2],
    );
    const call = await nextQueryCall();
    settle.push(async () => {
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
    });
    const options = call.options as QueryCall["options"] & {
      permissionMode?: string;
      settingSources?: string[];
      sandbox?: {
        enabled?: boolean;
        allowUnsandboxedCommands?: boolean;
        network?: { strictAllowlist?: boolean };
      };
    };
    const approvals = await observedApprovals(session.id, options);
    // The SDK lets the model leave its sandbox unless told otherwise; that
    // request is a permission like any other, so it holds only when someone
    // other than an auto-approver decides it.
    const providerSandbox =
      options.sandbox?.enabled === true &&
      (options.sandbox.allowUnsandboxedCommands === false || approvals !== "auto-approve");
    return {
      // What `GET /session/:id` reports, and so what Agent Info renders.
      reported: session.executionPolicy!,
      observed: {
        providerSandbox,
        approvals,
        projectResources: options.settingSources?.includes("project") === true,
        // Off the allowlist (empty here), a strict sandbox refuses outright;
        // otherwise the domain becomes a permission request.
        restrictsNetwork: providerSandbox && options.sandbox?.network?.strictAllowlist === true,
      },
    };
  },
});
