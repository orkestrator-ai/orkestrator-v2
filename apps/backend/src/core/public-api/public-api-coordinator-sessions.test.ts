import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  COORDINATOR_EXECUTION_POLICY,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  encodePublicSessionId,
  type PublicSessionSummary,
} from "@orkestrator/protocol/public-api-resources";
import { classifyReceiptForWait } from "@orkestrator/protocol/public-api-wait";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { CoordinatorService } from "../coordinator-service.js";
import { collaborators, projectionInternals } from "../native-agent-service-test-collaborators.js";
import { nativeAgentSessionStorageKey } from "../native-agent-service-shared.js";
import { nativePromptQueueKey } from "./prompt-delivery.js";
import { seedCoordinator } from "./test-coordinator.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";

/**
 * A Coordinator conversation through the public session actions on the real
 * dispatch journal, native-agent service and storage. It has no environment
 * row and no pane layout, and acting on it must never create either.
 */

afterEach(cleanupSessionHarnesses);

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQDa/0kPAAAAAElFTkSuQmCC";

async function coordinatorSetup(options: { adopt?: boolean } = {}) {
  return seedCoordinator(await setup(), options);
}

describe("Coordinator conversations are public sessions", () => {
  test("session.list and session.get read it without an environment or pane layout", async () => {
    const { harness, environmentId, tabId, sessionId } = await coordinatorSetup();
    const listed = await harness.call<{ items: PublicSessionSummary[]; total: number }>(
      "session.list",
      { environmentId },
    );
    expect(listed.ok && listed.result).toMatchObject({
      total: 1,
      items: [{ id: sessionId, environmentId, tabId, agent: "claude", title: "Coordinator" }],
    });
    const got = await harness.call<PublicSessionSummary>("session.get", { sessionId });
    expect(got.ok && got.result.id).toBe(sessionId);
    const transcript = await harness.call("session.transcript", { sessionId });
    expect(transcript.ok).toBe(true);
    expect(await harness.storage.getEnvironment(environmentId)).toBeNull();
    expect(await harness.storage.getPaneLayout(environmentId)).toBeNull();
  });

  test("session.prompt reaches the provider and its run completes, not interrupted", async () => {
    const { harness, service, stub, tabId, environmentId, sessionId, providerSessionId } =
      await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const sent = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "What is the state of the release?" },
      { requestId: "coordinator-prompt" },
    );
    if (!sent.ok) throw new Error(`${sent.error.code}: ${sent.error.message}`);
    expect(stub.sends.at(-1)?.prompt).toContain("What is the state of the release?");

    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    const running = await harness.call("run.get", { operationId: sent.result.runId });
    expect(running.receipt?.state).toBe("running");

    stub.setStatus(async () => "idle");
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const settled = await harness.call("run.get", { operationId: sent.result.runId });
    expect(settled.receipt?.state).toBe("succeeded");
    expect(settled.receipt?.execution?.state).toBe("completed");

    expect(await harness.storage.getEnvironment(environmentId)).toBeNull();
    expect(await harness.storage.getPaneLayout(environmentId)).toBeNull();
  });

  test("a run settles as interrupted once its conversation is closed", async () => {
    const {
      harness,
      service,
      stub,
      tabId,
      environmentId,
      sessionId,
      projectId,
      providerSessionId,
    } = await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const sent = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "Go" },
      { requestId: "closing-prompt" },
    );
    if (!sent.ok) throw new Error(`${sent.error.code}: ${sent.error.message}`);
    expect(stub.sends).toHaveLength(1);
    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    await harness.storage.coordinators.mutateCoordinatorWorkspace(projectId, (current) => ({
      ...current!,
      conversations: current!.conversations.map((item) => ({
        ...item,
        closedAt: new Date(0).toISOString(),
      })),
    }));
    const settled = await harness.call("run.get", { operationId: sent.result.runId });
    expect(settled.receipt?.state).toBe("interrupted");
    expect(settled.receipt?.execution?.reason).toBe("The Coordinator conversation was closed");
  });

  test("a busy Coordinator refuses a prompt, as any session does", async () => {
    const { harness, service, stub, tabId, environmentId, sessionId, providerSessionId } =
      await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    const busy = await harness.call(
      "session.prompt",
      { sessionId, prompt: "Hello" },
      { requestId: "busy" },
    );
    expect(!busy.ok && busy.error.code).toBe("busy");
    expect(stub.sends).toHaveLength(0);
  });

  for (const source of ["memory", "persisted", "projection"]) {
    test(`a paused Coordinator reads saved messages without provider access (source=${source})`, async () => {
      const {
        harness,
        service,
        stub,
        sessionId,
        environmentId,
        tabId,
        projectId,
        providerSessionId,
      } = await coordinatorSetup();
      setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
      const sent = await harness.call(
        "session.prompt",
        { sessionId, prompt: "Earlier question" },
        { requestId: "before-pause" },
      );
      expect(sent.ok).toBe(true);
      stub.messages.push({
        id: "earlier",
        role: "assistant",
        content: "Earlier answer",
        parts: [],
        createdAt: new Date(0).toISOString(),
      });
      expect((await harness.call("session.transcript", { sessionId })).ok).toBe(true);
      await service.getProjection({
        environmentId,
        agent: "claude",
        logicalSessionKey: `env-${environmentId}:${tabId}`,
      });
      if (source === "projection") projectionInternals(service).progressiveTranscriptCache.clear();
      if (source === "persisted") {
        await collaborators(service).projections.flushDisplayTailPersist(
          nativeAgentSessionStorageKey(environmentId, "claude", `env-${environmentId}:${tabId}`),
        );
        projectionInternals(service).progressiveTranscriptCache.clear();
        projectionInternals(service).projectionCache.clear();
      }
      await harness.storage.coordinators.mutateCoordinatorWorkspace(projectId, (current) => ({
        ...current!,
        lifecycleState: "paused",
      }));
      const providerRead = mock(async () => {
        throw new Error("Paused reads must not touch the provider");
      });
      Object.assign(stub.provider, {
        messages: providerRead,
        status: providerRead,
        createSession: providerRead,
      });
      expect((await harness.call("session.list", { environmentId })).ok).toBe(true);
      expect((await harness.call("session.get", { sessionId })).ok).toBe(true);
      const transcript = await harness.call("session.transcript", { sessionId });
      expect(transcript.ok && transcript.result).toMatchObject({
        messages: [{ id: "earlier", text: "Earlier answer" }],
        freshness: "cached",
      });
      const projection = await service.getProjection({
        environmentId,
        agent: "claude",
        logicalSessionKey: `env-${environmentId}:${tabId}`,
      });
      expect(projection).toMatchObject({
        messages: [{ id: "earlier", content: "Earlier answer" }],
      });
      expect(providerRead).not.toHaveBeenCalled();
      const refused = await harness.call(
        "session.prompt",
        { sessionId, prompt: "Hello" },
        { requestId: "paused" },
      );
      expect(!refused.ok && refused.error.code).toBe("not-ready");
      expect(
        (await harness.storage.coordinators.getCoordinatorWorkspace(projectId))?.lifecycleState,
      ).toBe("paused");
    });
  }

  test("small paused transcript windows preserve wider cached and persisted history", async () => {
    const { harness, service, stub, environmentId, tabId, projectId } = await coordinatorSetup();
    const identity = {
      environmentId,
      agent: "claude" as const,
      logicalSessionKey: `env-${environmentId}:${tabId}`,
      viewVersion: 1 as const,
    };
    stub.messages.push(
      ...["first", "second"].map((id) => ({
        id,
        role: "assistant",
        content: id,
        parts: [],
        createdAt: new Date(0).toISOString(),
      })),
    );
    await service.getTranscriptUpdate({
      ...identity,
      liveWindow: { messages: 100, targetBytes: 512 * 1024 },
      forceSnapshot: true,
    });
    await service.getProjection({ ...identity, messageLimit: 100 });
    const key = nativeAgentSessionStorageKey(environmentId, "claude", identity.logicalSessionKey);
    await collaborators(service).projections.flushDisplayTailPersist(key);
    const tail = await harness.storage.getNativeAgentDisplayTail(key);
    await harness.storage.coordinators.mutateCoordinatorWorkspace(projectId, (current) => ({
      ...current!,
      lifecycleState: "paused",
    }));
    const narrow = await service.getTranscriptUpdate({
      ...identity,
      liveWindow: { messages: 1, targetBytes: 512 * 1024 },
      forceSnapshot: true,
    });
    expect(narrow.status === "snapshot" && narrow.value).toMatchObject({
      messages: [{ id: "second" }],
      historyComplete: false,
      messageWindow: { truncated: true },
    });
    const wide = await service.getTranscriptUpdate({
      ...identity,
      liveWindow: { messages: 100, targetBytes: 512 * 1024 },
      forceSnapshot: true,
    });
    expect(wide.status === "snapshot" && wide.value.messages).toHaveLength(2);
    projectionInternals(service).progressiveTranscriptCache.clear();
    const smallProjection = await service.getProjection({ ...identity, messageLimit: 1 });
    expect(smallProjection?.messages).toHaveLength(1);
    const wideProjection = await service.getProjection({ ...identity, messageLimit: 100 });
    expect(wideProjection?.messages).toHaveLength(2);
    await collaborators(service).projections.flushDisplayTailPersist(key);
    expect(await harness.storage.getNativeAgentDisplayTail(key)).toEqual(tail);
  });

  test("a queued run is interrupted and retired by the real close path", async () => {
    const {
      harness,
      service,
      stub,
      sessionId,
      environmentId,
      tabId,
      projectId,
      providerSessionId,
    } = await coordinatorSetup();
    const repository = await harness.createRepository("coordinator-close");
    await harness.storage.updateProject(projectId, { localPath: repository.projectPath });
    harness.context.coordinators = new CoordinatorService(harness.storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    const queued = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "Never send this", enqueue: true },
      { requestId: "close-queued" },
    );
    if (!queued.ok) throw new Error(queued.error.message);
    const queueKey = nativePromptQueueKey("claude", `env-${environmentId}:${tabId}`);
    expect((await harness.storage.getPromptQueue(queueKey))?.messages).toHaveLength(1);
    await harness.commands.get("close_coordinator_conversation")!(
      { projectId, conversationId: "main" },
      harness.context,
    );
    // The CLI's run wait polls run.get for this same terminal receipt.
    for (let read = 0; read < 2; read++) {
      const settled = await harness.call("run.get", { operationId: queued.result.runId });
      expect(settled.receipt).toMatchObject({
        state: "interrupted",
        dispatch: { state: "not-sent" },
        execution: { state: "interrupted" },
      });
      expect(classifyReceiptForWait(settled.receipt!)).toEqual({
        kind: "terminal",
        succeeded: false,
      });
    }
    expect(await harness.storage.getPromptQueue(queueKey)).toBeNull();
    await service.drainPromptQueueForSession({
      agent: "claude",
      logicalSessionKey: `env-${environmentId}:${tabId}`,
    });
    expect(stub.sends).toHaveLength(0);
  });

  test("observation retires a queued prompt left by an older close path", async () => {
    const { harness, service, sessionId, environmentId, tabId, projectId, providerSessionId } =
      await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    const queued = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "Do not retry", enqueue: true },
      { requestId: "orphaned-queue" },
    );
    if (!queued.ok) throw new Error(queued.error.message);
    const key = nativePromptQueueKey("claude", `env-${environmentId}:${tabId}`);
    await harness.storage.coordinators.mutateCoordinatorWorkspace(projectId, (current) => ({
      ...current!,
      conversations: current!.conversations.map((item) =>
        item.id === "main" ? { ...item, closedAt: new Date().toISOString() } : item,
      ),
    }));
    expect((await harness.storage.getPromptQueue(key))?.messages).toHaveLength(1);
    const settled = await harness.call("run.get", { operationId: queued.result.runId });
    expect(settled.receipt).toMatchObject({
      state: "interrupted",
      dispatch: { state: "not-sent" },
    });
    expect(await harness.storage.getPromptQueue(key)).toBeNull();
  });

  test("a busy Coordinator queues and drains a prompt with the fixed execution policy", async () => {
    const { harness, service, stub, sessionId, environmentId, tabId, providerSessionId } =
      await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    const queued = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: "Follow up", enqueue: true },
      { requestId: "queued" },
    );
    if (!queued.ok) throw new Error(queued.error.message);
    expect(queued.receipt?.dispatch?.state).toBe("pending");
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    await service.drainPromptQueueForSession({
      agent: "claude",
      logicalSessionKey: `env-${environmentId}:${tabId}`,
    });
    expect(stub.sends).toEqual([
      expect.objectContaining({
        prompt: expect.stringContaining("Follow up"),
        requestId: queued.result.runId,
      }),
    ]);
    expect(
      (await harness.call("run.get", { operationId: queued.result.runId })).receipt?.dispatch
        ?.state,
    ).toBe("accepted");
    const record = await harness.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(environmentId, "claude", `env-${environmentId}:${tabId}`),
    );
    expect(record?.executionPolicy).toBe(COORDINATOR_EXECUTION_POLICY);
    expect(record?.controls?.mode).toBeUndefined();
  });

  test("commands, model controls, steering, interaction answers and stop preserve Coordinator policy", async () => {
    const { harness, service, stub, sessionId, environmentId, tabId, providerSessionId } =
      await coordinatorSetup();
    const update = mock(async () => undefined);
    const action = mock(async () => ({ outcome: "applied" }));
    const composer = {
      models: [{ platform: "claude", id: "sonnet", label: "Sonnet" }],
      selectedModelId: "sonnet",
      modes: [],
    };
    Object.assign(stub.provider, {
      interactiveSnapshot: async () => ({ status: "idle", messages: stub.messages, composer }),
      updateInteractiveControls: update,
      activeSteerRun: async () => ({ state: "running", runId: "provider-turn" }),
      steerSupported: async () => true,
      steerStatus: async () => "dispatched",
      performSessionAction: action,
      commandCatalogue: async () => ({
        enhanced: true,
        status: "ready",
        commands: [
          {
            name: "/review",
            id: "claude:/review",
            source: "project",
            executionKind: "provider-prompt",
            bindingRevision: "review-v1",
          },
        ],
      }),
    });
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const configured = await harness.call(
      "session.config.set",
      { sessionId, model: "sonnet" },
      { requestId: "model" },
    );
    expect(configured.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      providerSessionId,
      expect.objectContaining({ modelId: "sonnet" }),
    );
    const sent = await harness.call<{ runId: string }>(
      "session.command",
      { sessionId, command: "review", arguments: "release" },
      { requestId: "command" },
    );
    if (!sent.ok) throw new Error(sent.error.message);
    expect(stub.sends.at(-1)?.prompt).toContain("/review release");
    setActivity(service, "claude", tabId, providerSessionId, "working", environmentId);
    const steered = await harness.call(
      "session.steer",
      { sessionId, text: "Focus on tests", expectedOperationId: sent.result.runId },
      { requestId: "steer" },
    );
    expect(steered.ok).toBe(true);
    expect(action).toHaveBeenCalled();
    stub.pending.push({
      version: 1,
      id: "question",
      provider: "claude",
      kind: "question",
      origin: "interactive-native",
      sessionId: providerSessionId,
      state: "pending",
      revision: 1,
      presentation: {
        title: "Which target?",
        questions: [
          {
            id: "target",
            prompt: "Choose",
            required: true,
            multiple: false,
            secret: false,
            allowFreeText: true,
            options: [],
          },
        ],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as AgentInteractionRequest);
    const answered = await harness.call(
      "session.interaction.resolve",
      {
        sessionId,
        interactionId: "question",
        expectedRevision: 1,
        action: "answer",
        answers: [{ questionId: "target", freeText: "release" }],
      },
      { requestId: "answer" },
    );
    expect(answered.ok).toBe(true);
    expect(stub.resolutions).toHaveLength(1);
    const stopped = await harness.call(
      "session.stop",
      { sessionId, expectedOperationId: sent.result.runId },
      { requestId: "stop" },
    );
    expect(stopped.ok).toBe(true);
    expect(stub.provider.abort).toHaveBeenCalled();
    const record = await harness.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(environmentId, "claude", `env-${environmentId}:${tabId}`),
    );
    expect(record?.executionPolicy).toBe(COORDINATOR_EXECUTION_POLICY);
    expect(record?.controls?.mode).toBeUndefined();
    expect(await harness.storage.getPaneLayout(environmentId)).toBeNull();
  });

  test("a conversation that never started is not-ready, not missing", async () => {
    const { harness, sessionId } = await coordinatorSetup({ adopt: false });
    const refused = await harness.call(
      "session.prompt",
      { sessionId, prompt: "Hello" },
      { requestId: "cold" },
    );
    expect(!refused.ok && refused.error.code).toBe("not-ready");
  });

  test("an unassigned, closed or unknown conversation names its reason", async () => {
    const { harness, coordinatorId } = await coordinatorSetup();
    const unassigned = coordinatorRuntimeId(coordinatorId, "unassigned");
    const listed = await harness.call("session.list", { environmentId: unassigned });
    expect(!listed.ok && listed.error.code).toBe("not-ready");
    expect(!listed.ok && listed.error.message).toContain("no agent yet");

    for (const environmentId of [
      coordinatorRuntimeId(coordinatorId, "closed"),
      coordinatorRuntimeId(coordinatorId, "missing"),
      coordinatorRuntimeId("no-such-coordinator", "main"),
      coordinatorRuntimeId(coordinatorId),
    ]) {
      const gone = await harness.call("session.list", { environmentId });
      expect(!gone.ok && gone.error.code).toBe("not-found");
      expect(!gone.ok && gone.error.message).toBe("The Coordinator conversation no longer exists");
    }
    const wrongTab = await harness.call("session.get", {
      sessionId: encodePublicSessionId(coordinatorRuntimeId(coordinatorId, "main"), "other-tab"),
    });
    expect(!wrongTab.ok && wrongTab.error.code).toBe("not-found");
  });

  test("fork, resume and a mode change are refused; the checkout stays a Coordinator's", async () => {
    const { harness, stub, sessionId, environmentId } = await coordinatorSetup();
    const attempts = [
      ["session.fork", { sessionId }],
      ["session.resume", { sessionId, historyId: "history-1" }],
      ["session.prompt", { sessionId, prompt: "Hello", mode: "build" }],
      ["session.config.set", { sessionId, mode: "build" }],
    ] as const;
    for (const [index, [action, input]] of attempts.entries()) {
      const refused = await harness.call(action, input, { requestId: `refused-${index}` });
      expect(!refused.ok && refused.error.code).toBe("unsupported");
    }
    expect(stub.sends).toHaveLength(0);
    expect(await harness.storage.getPaneLayout(environmentId)).toBeNull();
  });

  test("session.start and environment actions say a Coordinator is not an environment", async () => {
    const { harness, environmentId, stub } = await coordinatorSetup();
    const started = await harness.call(
      "session.start",
      { environmentId, agent: "claude", prompt: "Hello" },
      { requestId: "start-on-coordinator" },
    );
    expect(!started.ok && started.error.code).toBe("not-found");
    expect(!started.ok && started.error.message).toContain("project Coordinator");
    const environment = await harness.call("environment.get", { environmentId });
    expect(!environment.ok && environment.error.message).toContain("project Coordinator");
    expect(stub.sends).toHaveLength(0);
  });

  test("images go to application data and other files are refused, never the checkout", async () => {
    const { harness, service, stub, tabId, environmentId, sessionId, providerSessionId } =
      await coordinatorSetup();
    setActivity(service, "claude", tabId, providerSessionId, "idle", environmentId);
    const send = stub.provider.send as unknown as { mock: { calls: unknown[][] } };
    const before = await fs.readdir(harness.root);
    const file = await harness.call(
      "session.prompt",
      {
        sessionId,
        prompt: "Read this",
        attachments: [
          { name: "notes.txt", type: "file", dataBase64: Buffer.from("notes").toString("base64") },
        ],
      },
      { requestId: "file-attachment" },
    );
    expect(!file.ok && file.error.code).toBe("capability-unavailable");

    const image = await harness.call(
      "session.prompt",
      {
        sessionId,
        prompt: "Look at this",
        attachments: [{ name: "pixel.png", type: "image", dataBase64: PIXEL_PNG }],
      },
      { requestId: "image-attachment" },
    );
    if (!image.ok) throw new Error(`${image.error.code}: ${image.error.message}`);
    const options = send.mock.calls.at(-1)?.[2] as { attachments?: Array<{ path: string }> };
    const stored = options.attachments?.[0]?.path ?? "";
    expect(stored).toStartWith(path.join(harness.dataDir, "coordinator-attachments"));
    expect((await fs.stat(stored)).isFile()).toBe(true);
    expect(await fs.readdir(harness.root)).toEqual(before);
  });
});
