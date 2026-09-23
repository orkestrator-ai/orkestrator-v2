import { afterEach, describe, expect, test, type Mock } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  dispatchNativeAgentIntent,
  dispatchNativeAgentPrompt,
  enqueuePromptQueueMessage,
  refreshNativeAgentCommands,
} from "./workflows";

// `@/lib/native/backend` is replaced once for every suite in tests/setup.ts.
const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("native command wrappers", () => {
  test("refreshNativeAgentCommands calls the refresh command and returns its outcome", async () => {
    const result = { outcome: "deferred" as const, message: "Busy", projection: null };
    invokeMock.mockImplementation(async () => result);
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey: "k" };
    await expect(refreshNativeAgentCommands(input)).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenLastCalledWith("refresh_native_agent_commands", input);
  });

  test("dispatch wrappers pass command intent through unchanged", async () => {
    const command = { kind: "selected" as const, commandId: "codex:/review", bindingRevision: "r" };
    const base = {
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "k",
      prompt: "/review a  \n",
      requestId: "req-1",
      command,
    };
    await dispatchNativeAgentIntent(base);
    expect(invokeMock).toHaveBeenLastCalledWith("dispatch_native_agent_intent", base);
    await dispatchNativeAgentPrompt(base);
    expect(invokeMock).toHaveBeenLastCalledWith("dispatch_native_agent_prompt", base);
  });

  test("queued messages keep their command intent", async () => {
    const message = { id: "q-1", text: "/review a", command: { kind: "literal" as const } };
    await enqueuePromptQueueMessage("queue", "env-1", message);
    expect(invokeMock).toHaveBeenLastCalledWith("enqueue_prompt_queue_message", {
      queueKey: "queue",
      environmentId: "env-1",
      message,
    });
  });
});
