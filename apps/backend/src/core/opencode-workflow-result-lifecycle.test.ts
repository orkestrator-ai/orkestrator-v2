import { describe, expect, test } from "bun:test";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import {
  readProviderStatus,
  ProviderDispatchPreparationError,
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderUnavailableError,
} from "./agent-provider-contract.js";
import {
  deferred,
  openCodeFake,
  openCodeProvider,
  waitUntil,
} from "./agent-provider-test-support.js";
import {
  openCodeWorkflowResultDenyPermissionRules,
  openCodeWorkflowResultToolId,
} from "./opencode-provider-helpers.js";

const sessionId = "owned-session";
const tool = openCodeWorkflowResultToolId("submit_validation_plan");
const options = {
  requestId: "validation-1",
  workflowResultTool: "submit_validation_plan",
  agentMcp: {
    url: "http://fixture.invalid/mcp",
    token: "fixture-token",
    workflowResultCapability: "fixture-capability",
  },
};

async function action(fake: ReturnType<typeof openCodeFake>, name = tool) {
  const result = await fake.client.session.get({ sessionID: sessionId });
  return result.data?.permission?.findLast((rule) => rule.permission === name)?.action;
}

async function sessionState(fake: ReturnType<typeof openCodeFake>) {
  const result = await fake.client.session.get({ sessionID: sessionId });
  return result.data;
}

function complete(fake: ReturnType<typeof openCodeFake>, index = fake.promptCalls.length - 1) {
  fake.setMessagesResponse({
    data: [
      {
        info: {
          role: "assistant",
          parentID: fake.promptCalls[index]!.messageID,
          finish: "stop",
          time: { completed: 1 },
        },
        parts: [],
      },
    ],
  });
}

describe("OpenCode workflow permission lifecycle", () => {
  test("cold preparation and a second provider's idle inspection cannot revoke the dispatch grant", async () => {
    const fake = openCodeFake();
    const coordinator = new OpenCodeMessageIdCoordinator();
    const owner = openCodeProvider(fake, 1, coordinator);
    const observer = openCodeProvider(fake, 1, coordinator);
    const gate = deferred();
    fake.setPromptGate(gate.promise);
    try {
      await owner.prepareDispatch?.(sessionId, options);
      expect(fake.updateCalls).toHaveLength(0);
      const sending = owner.send(sessionId, "Discover validation", options);
      await waitUntil(() => fake.promptCalls.length === 1);
      expect(await action(fake)).toBe("allow");
      const writes = fake.updateCalls.length;
      await expect(readProviderStatus(observer, sessionId)).resolves.toMatchObject({
        status: "idle",
      });
      expect(fake.updateCalls).toHaveLength(writes);
      expect(await action(fake)).toBe("allow");
      gate.resolve();
      await sending;
      // Completion is backend-owned: no observer, renderer or live SSE required.
      complete(fake);
      await readProviderStatus(owner, sessionId, options.requestId);
      expect(await action(fake)).toBe("deny");
    } finally {
      gate.resolve();
      await Promise.all([owner.dispose?.(), observer.dispose?.()]);
    }
  });

  test("idle alone cannot settle an accepted but not yet materialized prompt", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send(sessionId, "Prepare", options);
      expect(await readProviderStatus(provider, sessionId, options.requestId)).toMatchObject({
        status: "idle",
        turnSettled: false,
      });
      expect(await action(fake)).toBe("allow");
      fake.setMessagesResponse({
        data: [
          {
            info: {
              role: "assistant",
              parentID: fake.promptCalls[0]!.messageID,
              finish: "tool-calls",
              time: { completed: 1 },
            },
            parts: [],
          },
        ],
      });
      await provider.settleTurn?.(sessionId, options.requestId);
      expect(await action(fake)).toBe("allow");
      expect(await readProviderStatus(provider, sessionId, options.requestId)).toMatchObject({
        status: "idle",
        turnSettled: false,
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("an old request cannot clean up a newer turn, including across provider recreation", async () => {
    const fake = openCodeFake();
    const coordinator = new OpenCodeMessageIdCoordinator();
    const old = openCodeProvider(fake, 1, coordinator);
    const current = openCodeProvider(fake, 1, coordinator);
    const gate = deferred();
    try {
      await old.send(sessionId, "First", options);
      complete(fake);
      fake.setPromptGate(gate.promise);
      const sending = current.send(sessionId, "Second", { ...options, requestId: "validation-2" });
      await waitUntil(() => fake.promptCalls.length === 2);
      const cleanup = old.settleTurn!(sessionId, options.requestId);
      gate.resolve();
      await Promise.all([sending, cleanup]);
      expect(await action(fake)).toBe("allow");
      // A stale terminal transcript for the previous turn cannot settle this one.
      await current.settleTurn?.(sessionId, "validation-2");
      expect(await action(fake)).toBe("allow");
      await current.dispose?.();
      const recovered = openCodeProvider(fake, 1, coordinator);
      try {
        complete(fake);
        await readProviderStatus(recovered, sessionId, "validation-2");
        expect(await action(fake)).toBe("deny");
      } finally {
        await recovered.dispose?.();
      }
    } finally {
      gate.resolve();
      await Promise.all([old.dispose?.(), current.dispose?.()]);
    }
  });

  test.each(["failed", "disabled", "needs_auth", "needs_client_registration", undefined])(
    "HTTP-success MCP status %s blocks dispatch and remains retryable",
    async (status) => {
      const fake = openCodeFake();
      const provider = openCodeProvider(fake);
      fake.setMcpAddHandler(async () => ({
        data: status ? { orkestrator_workflow_result: { status } } : {},
      }));
      try {
        await expect(provider.send(sessionId, "Prepare", options)).rejects.toBeInstanceOf(
          ProviderDispatchPreparationError,
        );
        expect(fake.promptCalls).toHaveLength(0);
        expect(fake.updateCalls).toHaveLength(0);
        fake.setMcpAddHandler(async () => ({
          data: { orkestrator_workflow_result: { status: "connected" } },
        }));
        await provider.send(sessionId, "Prepare", options);
        expect(fake.mcpAddCalls).toHaveLength(2);
        expect(fake.promptCalls).toHaveLength(1);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("a disconnected cached broker is registered again before dispatch", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.prepareDispatch?.(sessionId, options);
      fake.client.mcp.status = async () =>
        ({ data: { orkestrator_workflow_result: { status: "disabled" } } }) as never;
      await provider.send(sessionId, "Prepare", options);
      expect(fake.mcpAddCalls).toHaveLength(2);
      expect(await action(fake)).toBe("allow");
    } finally {
      await provider.dispose?.();
    }
  });

  test("a successful permission response without persisted rules cannot dispatch", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    fake.client.session.update = async () => ({ data: {} }) as never;
    try {
      await expect(provider.send(sessionId, "Prepare", options)).rejects.toBeInstanceOf(
        ProviderDispatchPreparationError,
      );
      expect(fake.promptCalls).toHaveLength(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("an ambiguous dispatch retains its grant until authoritative completion", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    fake.setPromptError(new Error("response lost"));
    try {
      await expect(provider.send(sessionId, "Prepare", options)).rejects.toBeInstanceOf(
        AmbiguousPromptDispatchError,
      );
      expect(await readProviderStatus(provider, sessionId, options.requestId)).toMatchObject({
        status: "idle",
        turnSettled: false,
      });
      expect(await action(fake)).toBe("allow");
      complete(fake);
      expect(await readProviderStatus(provider, sessionId, options.requestId)).toMatchObject({
        status: "idle",
      });
      expect(await action(fake)).toBe("deny");
      expect(fake.promptCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("a definite prompt rejection retires the owned grant", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    fake.setPromptResponse({ error: { message: "invalid prompt" }, response: { status: 400 } });
    try {
      await expect(provider.send(sessionId, "Prepare", options)).rejects.toBeInstanceOf(
        PromptRejectedError,
      );
      expect(await action(fake)).toBe("deny");
      expect((await sessionState(fake))?.metadata?.["orkestrator.workflowResultTurn"]).toEqual({
        version: 1,
        requestId: options.requestId,
        settled: true,
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("an explicitly retryable prompt response retains the owned grant", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    fake.setPromptResponse({ error: { message: "overloaded" }, response: { status: 503 } });
    try {
      await expect(provider.send(sessionId, "Prepare", options)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      expect(await action(fake)).toBe("allow");
      expect((await sessionState(fake))?.metadata?.["orkestrator.workflowResultTurn"]).toEqual({
        version: 1,
        requestId: options.requestId,
        settled: false,
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([
    ["message-level unknown", { finish: "unknown" }, []],
    ["step-finish only", {}, [{ type: "step-finish", reason: "stop" }]],
  ])("settles a terminal transcript with %s", async (_label, completion, parts) => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send(sessionId, "Prepare", options);
      fake.setMessagesResponse({
        data: [
          {
            info: {
              role: "assistant",
              parentID: fake.promptCalls[0]!.messageID,
              time: { completed: 1 },
              ...completion,
            },
            parts,
          },
        ],
      });
      await expect(
        readProviderStatus(provider, sessionId, options.requestId),
      ).resolves.toMatchObject({ status: "idle", turnSettled: true });
      expect(await action(fake)).toBe("deny");
    } finally {
      await provider.dispose?.();
    }
  });

  test("read-only workflow masks expose only this request's tools and ordinary turns deny all", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send(sessionId, "Prepare", { ...options, readOnly: true });
      expect(await action(fake)).toBe("allow");
      expect(await action(fake, openCodeWorkflowResultToolId("submit_review_report"))).toBe("deny");
      await provider.send(sessionId, "Ordinary", { requestId: "ordinary", readOnly: true });
      expect(await action(fake)).toBe("deny");
      expect(await action(fake, openCodeWorkflowResultToolId("validate_workflow_result"))).toBe(
        "deny",
      );
    } finally {
      await provider.dispose?.();
    }
  });

  test("ordinary turns do not append duplicate workflow deny rules", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      for (let index = 0; index < 12; index += 1) {
        await provider.send(sessionId, `Ordinary ${index}`, {
          requestId: `ordinary-${index}`,
        });
      }
      expect(fake.updateCalls.filter((update) => Array.isArray(update.permission))).toHaveLength(1);
      const permission = (await sessionState(fake))?.permission;
      expect(permission).toBeArray();
      expect(permission).toHaveLength(openCodeWorkflowResultDenyPermissionRules().length);
    } finally {
      await provider.dispose?.();
    }
  });

  test("settlement rejects a successful response whose deny rules were not persisted", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send(sessionId, "Prepare", options);
      complete(fake);
      fake.client.session.update = async () => ({ data: {} }) as never;
      await expect(provider.settleTurn?.(sessionId, options.requestId)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      expect(await action(fake)).toBe("allow");
    } finally {
      await provider.dispose?.();
    }
  });

  test("an explicit abort settles the owned grant", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send(sessionId, "Prepare", options);
      await provider.abort(sessionId);
      expect(await action(fake)).toBe("deny");
    } finally {
      await provider.dispose?.();
    }
  });

  test("abort reaches OpenCode while prompt dispatch still holds the session lock", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    const gate = deferred();
    fake.setPromptGate(gate.promise);
    try {
      const sending = provider.send(sessionId, "Prepare", options);
      await waitUntil(() => fake.promptCalls.length === 1);
      const aborting = provider.abort(sessionId);
      await waitUntil(() => fake.abortCalls.length === 1);
      expect(fake.abortCalls).toHaveLength(1);
      gate.resolve();
      await Promise.all([sending, aborting]);
      expect(await action(fake)).toBe("deny");
    } finally {
      gate.resolve();
      await provider.dispose?.();
    }
  });
});
