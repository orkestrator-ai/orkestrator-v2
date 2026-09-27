import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  webAnnotationRequestMarker,
  type WebAnnotationDestination,
  type WebAnnotationRequest,
} from "@orkestrator/protocol/web-annotations";
import { fixtureRequest } from "@orkestrator/protocol/web-annotations-fixtures";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { StorageService } from "./storage.js";
import {
  WebAnnotationDispatchAdapter,
  webAnnotationQueueKey,
  type WebAnnotationDispatchNativeAgents,
} from "./web-annotation-dispatch.js";

const ENV = "e1";
const STOPPED_ENV = "e2";
const DESTINATION: WebAnnotationDestination = {
  agent: "claude",
  tabId: "tab-1",
  logicalSessionKey: `env-${ENV}:tab-1`,
};
const QUEUE_KEY = webAnnotationQueueKey(DESTINATION);
const SESSION_KEY = nativeAgentSessionStorageKey(ENV, "claude", DESTINATION.logicalSessionKey);
const DRAFT_KEY = `claude:${ENV}:${encodeURIComponent(DESTINATION.logicalSessionKey)}`;

let dataDir: string;
let storage: StorageService;
let activity: AgentActivityState | "unknown";
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let notified: string[];
let projection: { messages: unknown[] } | null;
let cachedProjection: Record<string, unknown> | null;
let turnOutcome: { outcome: "completed" | "failed" | "pending" | "unknown"; error?: string } | null;
let pendingInteractions: unknown[] | null;
let reconciled: string[];
let adapter: WebAnnotationDispatchAdapter;
let toolsAvailable: boolean;

function environment(
  id: string,
  status: "running" | "stopped",
  type: "local" | "docker" = "local",
) {
  return {
    id,
    projectId: "proj-1",
    name: id,
    branch: "main",
    containerId: type === "docker" ? "container-1" : null,
    status,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted" as const,
    order: 0,
    environmentType: type,
    worktreePath: type === "local" ? `/tmp/worktree-${id}` : undefined,
    setupPhase: "ready" as const,
  };
}

const nativeAgents = {
  sessionActivitySnapshot: () => activity,
  sessionTurnActivitySnapshot: () => activity,
  sessionPresentationSnapshot: () => ({ presence: activity, title: "Cached title" }),
  reconcileMailInject: async (input: { requestId: string }) => {
    reconciled.push(input.requestId);
    return "unknown" as const;
  },
  getProjection: async () => projection,
  cachedProjectionSnapshot: () => cachedProjection,
  sessionTurnOutcome: async () => turnOutcome ?? { outcome: "unknown" as const },
  sessionPendingInteractions: async () => pendingInteractions,
  notifyPromptQueueChanged: (key: string) => {
    notified.push(key);
  },
} as unknown as WebAnnotationDispatchNativeAgents;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-wa-dispatch-"));
  storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment(environment(ENV, "running") as never);
  await storage.addEnvironment(environment(STOPPED_ENV, "stopped") as never);
  activity = "unknown";
  calls = [];
  notified = [];
  projection = null;
  cachedProjection = null;
  turnOutcome = null;
  pendingInteractions = null;
  reconciled = [];
  toolsAvailable = false;
  adapter = new WebAnnotationDispatchAdapter({
    storage,
    nativeAgents,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "write_local_file")
        return path.join(String(args.worktreePath), String(args.filePath));
      if (command === "retry_native_agent_dispatch")
        return { outcome: "accepted", requestId: args.requestId };
      if (command === "discard_native_agent_dispatch") {
        return {
          discarded: await storage.clearPendingNativeAgentDispatch(
            SESSION_KEY,
            String(args.requestId),
          ),
        };
      }
      if (command === "stop_native_agent_session" && stopFails) throw new Error("bridge offline");
      return null;
    },
    resultToolsAvailable: () => toolsAvailable,
    now: () => Date.parse("2026-09-24T00:00:00.000Z"),
  });
  stopFails = false;
});

let stopFails = false;

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function request(
  overrides: Partial<WebAnnotationRequest> = {},
  id = "req-1",
): WebAnnotationRequest {
  return fixtureRequest("queued", {
    id,
    environmentId: ENV,
    destination: DESTINATION,
    queueKey: QUEUE_KEY,
    blockedReason: null,
    transcript: {
      requestId: id,
      agent: "claude",
      tabId: "tab-1",
      logicalSessionKey: DESTINATION.logicalSessionKey,
    },
    ...overrides,
  });
}

function text(id = "req-1", body = "brief body", operation: "discuss" | "implement" = "implement") {
  return `${webAnnotationRequestMarker(id, operation, 1)}\n\n${body}`;
}

async function createSession(controls?: { mode?: "plan" | "build"; modelId?: string }) {
  return storage.getOrCreateNativeAgentSession(
    {
      key: SESSION_KEY,
      environmentId: ENV,
      agent: "claude",
      logicalSessionKey: DESTINATION.logicalSessionKey,
      ...(controls ? { controls } : {}),
    },
    async () => "provider-1",
  );
}

async function dispatchThroughQueue(id: string) {
  await storage.reservePromptQueueHeadForDispatch(QUEUE_KEY);
  await storage.dispatchNativeAgentPromptOnce(SESSION_KEY, id, async () => undefined);
  await storage.acknowledgePromptQueueDispatch(QUEUE_KEY, id);
}

async function saveLayout(tabs: Array<Record<string, unknown>>) {
  await storage.savePaneLayout(
    ENV,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane-1",
      root: { kind: "leaf", id: "pane-1", tabs, activeTabId: tabs[0]?.id ?? null },
    },
    0,
  );
}

describe("WebAnnotationDispatchAdapter.publish", () => {
  test("publishes once through the native queue and is idempotent for the same id", async () => {
    const discuss = request({ operation: "discuss", readOnly: "plan-mode" });
    expect(
      await adapter.publish({ request: discuss, text: text("req-1", "body", "discuss") }),
    ).toEqual({
      status: "queued",
      dispatchMode: "plan",
    });
    expect(
      await adapter.publish({ request: discuss, text: text("req-1", "body", "discuss") }),
    ).toEqual({
      status: "queued",
      dispatchMode: "plan",
    });
    const queue = await storage.getPromptQueue(QUEUE_KEY);
    expect(queue?.messages).toEqual([
      {
        id: "req-1",
        requestId: "req-1",
        text: text("req-1", "body", "discuss"),
        attachments: [],
        mode: "plan",
        planModeEnabled: true,
        command: { kind: "literal" },
        origin: { kind: "web-annotation", requestId: "req-1", bodyHash: discuss.bodyHash },
      },
    ]);
    expect(notified).toEqual([QUEUE_KEY, QUEUE_KEY]);
  });

  test("a changed body for a used id is rejected without a second message", async () => {
    await adapter.publish({ request: request(), text: text() });
    const receipt = await adapter.publish({ request: request(), text: text("req-1", "changed") });
    expect(receipt.status).toBe("rejected");
    expect((await storage.getPromptQueue(QUEUE_KEY))?.messages).toHaveLength(1);
  });

  test("an id already consumed by native dispatch is never republished", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await dispatchThroughQueue("req-1");
    expect(await adapter.publish({ request: request(), text: text() })).toEqual({
      status: "consumed",
    });
    expect((await storage.getPromptQueue(QUEUE_KEY))?.messages).toEqual([]);
  });

  test("rejects text without this request's marker and unmaterialized attachments", async () => {
    expect((await adapter.publish({ request: request(), text: "/compact" })).status).toBe(
      "rejected",
    );
    const withImage = request({
      attachments: [
        {
          assetId: "a1",
          digest: "sha256:ab",
          bytes: 3,
          relativePath: ".orkestrator/annotations/ab.png",
        },
      ],
    });
    expect((await adapter.publish({ request: withImage, text: text() })).status).toBe("rejected");
    expect(await storage.getPromptQueue(QUEUE_KEY)).toBeNull();
  });

  test("materialized images become native prompt attachments", async () => {
    const withImage = request({
      attachments: [
        {
          assetId: "a1",
          digest: "sha256:ab",
          bytes: 3,
          relativePath: ".orkestrator/annotations/req-1-ab.png",
          materializedPath: "/tmp/worktree-e1/.orkestrator/annotations/req-1-ab.png",
        },
      ],
    });
    await adapter.publish({ request: withImage, text: text() });
    const [queued] = (await storage.getPromptQueue(QUEUE_KEY))!.messages as Array<
      Record<string, unknown>
    >;
    expect(queued?.attachments).toEqual([
      {
        type: "image",
        path: "/tmp/worktree-e1/.orkestrator/annotations/req-1-ab.png",
        filename: "req-1-ab.png",
      },
    ]);
    expect(queued?.mode).toBeUndefined();
    // No known session mode: the drain must leave the session's own mode alone.
    expect(queued?.preserveSessionMode).toBe(true);
  });

  test("implement requests use the session's current mode and never switch it", async () => {
    await createSession({ mode: "plan" });
    expect(await adapter.publish({ request: request(), text: text() })).toEqual({
      status: "queued",
      dispatchMode: "plan",
    });
    const [queued] = (await storage.getPromptQueue(QUEUE_KEY))!.messages as Array<
      Record<string, unknown>
    >;
    expect(queued).toMatchObject({ mode: "plan", planModeEnabled: true });
    expect(queued?.preserveSessionMode).toBeUndefined();
  });

  test("a session-scoped mode provider never gets per-turn plan mode for discussion", () => {
    expect(adapter.capabilitiesFor("claude").planMode).toBe(true);
    // Codex, Cursor and Grok persist a prompt's mode on the session.
    expect(adapter.capabilitiesFor("codex").planMode).toBe(false);
    expect(adapter.capabilitiesFor("cursor").planMode).toBe(false);
    expect(adapter.capabilitiesFor("opencode").planMode).toBe(false);
  });

  test("an id removed from the chat queue is consumed and never republished", async () => {
    await adapter.publish({ request: request(), text: text() });
    await storage.removePromptQueueMessage(QUEUE_KEY, ENV, "req-1");
    expect(await adapter.publish({ request: request(), text: text() })).toEqual({
      status: "consumed",
    });
    expect((await storage.getPromptQueue(QUEUE_KEY))?.messages).toEqual([]);
  });
});

describe("WebAnnotationDispatchAdapter capabilities", () => {
  test("result tools follow the advertised agent-tools capability, not a name list", () => {
    expect(adapter.capabilitiesFor("claude").resultTools).toBe(false);
    toolsAvailable = true;
    expect(adapter.capabilitiesFor("claude").resultTools).toBe(true);
    expect(adapter.capabilitiesFor("codex").resultTools).toBe(true);
    expect(adapter.capabilitiesFor("opencode").resultTools).toBe(false);
  });

  test("a model that rejects images blocks images even when the agent accepts them", async () => {
    await createSession({ modelId: "text-only-model" });
    cachedProjection = {
      messages: [],
      composer: {
        models: [
          { platform: "claude", id: "text-only-model", label: "T", supportsImageInput: false },
        ],
        selectedModelId: "text-only-model",
        fastModeEnabled: null,
        fastModeAvailable: false,
        modes: [],
      },
    };
    const validation = await adapter.validateDestination(ENV, DESTINATION);
    expect(validation).toMatchObject({
      ok: true,
      capabilities: { images: false, imageSupport: "model" },
    });
    cachedProjection = null;
    expect(await adapter.validateDestination(ENV, DESTINATION)).toMatchObject({
      ok: true,
      capabilities: { images: true, imageSupport: "agent" },
    });
  });
});

describe("WebAnnotationDispatchAdapter.observe", () => {
  test("queued behind an unsent compose draft reports the draft hold", async () => {
    await adapter.publish({ request: request(), text: text() });
    await storage.saveComposeDraft(DRAFT_KEY, "environment", ENV, {
      text: "unsent",
      mentions: [],
      attachments: [],
    });
    expect(await adapter.observe(request())).toMatchObject({
      state: "queued",
      blockedReason: "compose-draft",
    });
  });

  test("queued behind the user's own prompt or a busy agent reports agent-busy", async () => {
    await storage.enqueuePromptQueueMessage(QUEUE_KEY, ENV, { id: "user-1", text: "mine" });
    await adapter.publish({ request: request(), text: text() });
    expect(await adapter.observe(request())).toMatchObject({
      state: "queued",
      blockedReason: "agent-busy",
    });
  });

  test("a stopped environment is a typed hold, not a failure", async () => {
    const stopped: WebAnnotationDestination = {
      ...DESTINATION,
      logicalSessionKey: `env-${STOPPED_ENV}:tab-1`,
    };
    const stoppedRequest = request({
      environmentId: STOPPED_ENV,
      destination: stopped,
      queueKey: webAnnotationQueueKey(stopped),
    });
    await adapter.publish({ request: stoppedRequest, text: text() });
    expect(await adapter.observe(stoppedRequest)).toMatchObject({
      state: "queued",
      blockedReason: "environment-stopped",
    });
  });

  test("a queue parked by another prompt reports queue-parked", async () => {
    await storage.enqueuePromptQueueMessage(QUEUE_KEY, ENV, { id: "user-1", text: "mine" });
    await storage.reservePromptQueueHeadForDispatch(QUEUE_KEY);
    await storage.failPromptQueueDispatch(QUEUE_KEY, "user-1", "rejected");
    await adapter.publish({ request: request(), text: text() });
    expect(await adapter.observe(request())).toMatchObject({
      state: "queued",
      blockedReason: "queue-parked",
    });
  });

  test("an in-flight reservation is dispatching", async () => {
    await adapter.publish({ request: request(), text: text() });
    await storage.reservePromptQueueHeadForDispatch(QUEUE_KEY);
    expect(await adapter.observe(request())).toMatchObject({
      state: "dispatching",
      dispatchConfirmed: false,
    });
  });

  test("our own dispatch rejection holds the request and leaves the queue parked", async () => {
    await adapter.publish({ request: request(), text: text() });
    await storage.enqueuePromptQueueMessage(QUEUE_KEY, ENV, { id: "user-2", text: "after" });
    await storage.reservePromptQueueHeadForDispatch(QUEUE_KEY);
    await storage.failPromptQueueDispatch(QUEUE_KEY, "req-1", "Model rejected the prompt");
    notified = [];
    const observation = await adapter.observe(request({ state: "dispatching" }));
    expect(observation).toMatchObject({
      state: "queued",
      blockedReason: "dispatch-rejected",
      reason: "Model rejected the prompt",
    });
    // Observation never un-parks the user's queue or removes their item.
    let queue = await storage.getPromptQueue(QUEUE_KEY);
    expect(queue?.dispatchError?.messageId).toBe("req-1");
    expect(queue?.messages.map((message) => (message as { id: string }).id)).toEqual([
      "req-1",
      "user-2",
    ]);
    expect(notified).toEqual([]);

    // Retry is an explicit, same-id user action that clears only our latch.
    const retried = await adapter.recover(request(), "retry");
    queue = await storage.getPromptQueue(QUEUE_KEY);
    expect(queue?.dispatchError).toBeUndefined();
    expect(retried.state).toBe("queued");
    expect(notified).toEqual([QUEUE_KEY]);
  });

  test("an ambiguous native dispatch is unconfirmed", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await storage.reservePromptQueueHeadForDispatch(QUEUE_KEY);
    await expect(
      storage.dispatchNativeAgentPromptOnce(
        SESSION_KEY,
        "req-1",
        async () => {
          throw new Error("lost");
        },
        { requestId: "req-1", prompt: text(), createdAt: new Date(0).toISOString() },
      ),
    ).rejects.toThrow("lost");
    expect(await adapter.observe(request())).toMatchObject({
      state: "unconfirmed",
      dispatchConfirmed: false,
    });
  });

  test("dispatched turns settle only on idle or a later turn with no live observation", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await dispatchThroughQueue("req-1");
    activity = "working";
    expect(await adapter.observe(request({ state: "dispatching" }))).toMatchObject({
      state: "running",
      dispatchConfirmed: true,
    });
    activity = "waiting";
    expect((await adapter.observe(request({ state: "running" }))).state).toBe("needs-input");
    activity = "idle";
    expect((await adapter.observe(request({ state: "running" }))).state).toBe("awaiting-review");
    expect((await adapter.observe(request({ state: "running", operation: "discuss" }))).state).toBe(
      "completed",
    );
    // A stop was sent (cancelling): the turn ended because of it.
    expect(
      (
        await adapter.observe(
          request({ state: "cancelling", cancelRequestedAt: new Date(0).toISOString() }),
        )
      ).state,
    ).toBe("cancelled");
    // A cancel that arrived after dispatch (no stop sent): the turn finished.
    expect(
      await adapter.observe(
        request({ state: "running", cancelRequestedAt: new Date(0).toISOString() }),
      ),
    ).toMatchObject({ state: "awaiting-review", cancelArrivedLate: true });

    await storage.enqueuePromptQueueMessage(QUEUE_KEY, ENV, { id: "user-3", text: "next" });
    await dispatchThroughQueue("user-3");
    activity = "working";
    // Busy with a later id: possibly a steer into our turn, so not settled.
    expect((await adapter.observe(request({ state: "running" }))).state).toBe("running");
    activity = "unknown";
    expect((await adapter.observe(request({ state: "running" }))).state).toBe("awaiting-review");
  });

  test("absence is not proof: dispatched but unobserved keeps the current state", async () => {
    // The item left the queue (acknowledged) but the session read missed the
    // receipt: no tombstone, so nothing settles.
    await createSession();
    const receipted = request({ state: "queued", queueReceiptAt: new Date(0).toISOString() });
    expect(await adapter.observe(receipted)).toMatchObject({
      state: "queued",
      destinationMissing: false,
    });
  });

  test("removal from the chat queue before dispatch settles as cancelled", async () => {
    await adapter.publish({ request: request(), text: text() });
    await storage.removePromptQueueMessage(QUEUE_KEY, ENV, "req-1");
    const receipted = request({ state: "queued", queueReceiptAt: new Date(0).toISOString() });
    expect(await adapter.observe(receipted)).toMatchObject({
      state: "cancelled",
      cancelSource: "chat-queue",
      reason: expect.stringContaining("Removed from the chat queue"),
    });
    // A claimed item leaves `messages` for the claim, not as a removal.
    await adapter.publish({ request: request({}, "req-2"), text: text("req-2") });
    await storage.claimPromptQueueHead(QUEUE_KEY, ENV, "req-2");
    expect((await adapter.observe(request({ state: "queued" }, "req-2"))).state).toBe(
      "dispatching",
    );
  });

  test("a deleted destination is surfaced as a typed hold and is cancellable", async () => {
    const receipted = request({ state: "queued", queueReceiptAt: new Date(0).toISOString() });
    await saveLayout([
      { id: "other-tab", type: "agent-native", nativeAgentData: { platform: "codex" } },
    ]);
    expect(await adapter.observe(receipted)).toMatchObject({
      state: "queued",
      blockedReason: "destination-unavailable",
      destinationMissing: true,
    });
    expect(
      await adapter.cancel({ ...receipted, destinationMissingAt: new Date(0).toISOString() }),
    ).toMatchObject({ outcome: "cancelled", reason: expect.stringContaining("deleted") });
  });

  test("a rolled-over dispatch receipt still settles from the persisted confirmation", async () => {
    await createSession();
    await storage.enqueuePromptQueueMessage(QUEUE_KEY, ENV, { id: "later", text: "later" });
    await dispatchThroughQueue("later");
    activity = "unknown";
    const observation = await adapter.observe(
      request({ state: "running", dispatchConfirmedAt: new Date(0).toISOString() }),
    );
    expect(observation).toMatchObject({ state: "awaiting-review", turnOutcome: "unknown" });
  });

  test("a provider-error turn settles as failed with the recorded error", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await dispatchThroughQueue("req-1");
    activity = "idle";
    turnOutcome = { outcome: "pending" };
    expect((await adapter.observe(request({ state: "running" }))).state).toBe("running");
    turnOutcome = { outcome: "failed", error: "model overloaded" };
    expect(await adapter.observe(request({ state: "running" }))).toMatchObject({
      state: "failed",
      turnOutcome: "failed",
      turnError: "model overloaded",
      reason: "The agent turn failed: model overloaded",
    });
    // A durable record written by the drain wins without asking again.
    turnOutcome = null;
    await storage.recordNativeAgentTurnOutcome(SESSION_KEY, "provider-1", {
      requestId: "req-1",
      outcome: "completed",
      observedAt: new Date(0).toISOString(),
    });
    expect(await adapter.observe(request({ state: "running" }))).toMatchObject({
      state: "awaiting-review",
      turnOutcome: "completed",
    });
  });

  test("a waiting turn links its pending interactions to the request", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await dispatchThroughQueue("req-1");
    activity = "waiting";
    pendingInteractions = [
      { id: "question:1", kind: "question", state: "pending", blocking: true, expiresAt: 5 },
      { id: "approval:2", kind: "command-approval", state: "pending" },
    ];
    expect(await adapter.observe(request({ state: "running" }))).toMatchObject({
      state: "needs-input",
      interactionIds: ["question:1", "approval:2"],
      interactions: [
        { id: "question:1", kind: "question", state: "pending", blocking: true, expiresAt: 5 },
        { id: "approval:2", kind: "command-approval", state: "pending", blocking: true },
      ],
    });
    activity = "working";
    expect(await adapter.observe(request({ state: "needs-input" }))).toMatchObject({
      state: "running",
      interactions: [],
    });
  });

  test("the prompt's transcript message and turn are linked from the cached projection", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await dispatchThroughQueue("req-1");
    activity = "working";
    cachedProjection = {
      messages: [{ id: "user-msg-7", role: "user", content: text("req-1"), parts: [] }],
      turnBoundaries: [
        { turnId: "turn-7", messageId: "user-msg-7", resumable: true, forkable: true },
      ],
    };
    expect(await adapter.observe(request({ state: "dispatching" }))).toMatchObject({
      state: "running",
      transcript: { messageId: "user-msg-7", turnId: "turn-7" },
    });
  });
});

describe("WebAnnotationDispatchAdapter.cancel", () => {
  test("removal succeeds only while the item is still queued", async () => {
    await adapter.publish({ request: request(), text: text() });
    expect(await adapter.cancel(request())).toEqual({ outcome: "cancelled" });
    expect((await storage.getPromptQueue(QUEUE_KEY))?.messages).toEqual([]);
  });

  test("a claimed in-flight item is not cancellable", async () => {
    await adapter.publish({ request: request(), text: text() });
    await storage.reservePromptQueueHeadForDispatch(QUEUE_KEY);
    expect((await adapter.cancel(request())).outcome).toBe("not-cancellable");
    expect(calls.some((call) => call.command === "stop_native_agent_session")).toBe(false);
  });

  test("a running current turn is stopped; a stale card cannot stop a newer turn", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await dispatchThroughQueue("req-1");
    activity = "working";
    expect(await adapter.cancel(request({ state: "running" }))).toEqual({ outcome: "cancelling" });
    expect(calls).toEqual([
      {
        command: "stop_native_agent_session",
        args: {
          environmentId: ENV,
          agent: "claude",
          logicalSessionKey: DESTINATION.logicalSessionKey,
        },
      },
    ]);

    calls = [];
    await storage.enqueuePromptQueueMessage(QUEUE_KEY, ENV, { id: "user-9", text: "newer" });
    await dispatchThroughQueue("user-9");
    expect((await adapter.cancel(request({ state: "running" }))).outcome).toBe("not-cancellable");
    expect(calls).toEqual([]);
  });

  test("a finished turn is not cancellable", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await dispatchThroughQueue("req-1");
    activity = "idle";
    expect(await adapter.cancel(request({ state: "running" }))).toMatchObject({
      outcome: "not-cancellable",
      code: "already-finished",
    });
    expect(calls).toEqual([]);
  });

  test("a failed stop is a typed refusal, not only a message", async () => {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await dispatchThroughQueue("req-1");
    activity = "working";
    stopFails = true;
    expect(await adapter.cancel(request({ state: "running" }))).toMatchObject({
      outcome: "not-cancellable",
      code: "stop-failed",
      reason: expect.stringContaining("bridge offline"),
    });
  });
});

describe("WebAnnotationDispatchAdapter.recover", () => {
  async function park() {
    await createSession();
    await adapter.publish({ request: request(), text: text() });
    await storage.reservePromptQueueHeadForDispatch(QUEUE_KEY);
    await storage
      .dispatchNativeAgentPromptOnce(
        SESSION_KEY,
        "req-1",
        async () => {
          throw new Error("lost");
        },
        { requestId: "req-1", prompt: text(), createdAt: new Date(0).toISOString() },
      )
      .catch(() => undefined);
  }

  test("reconcile settles against the provider journal for the same id", async () => {
    await park();
    expect((await adapter.recover(request({ state: "unconfirmed" }), "reconcile")).state).toBe(
      "unconfirmed",
    );
    expect(reconciled).toEqual(["req-1"]);
  });

  test("retry reuses the same request id", async () => {
    await park();
    await adapter.recover(request({ state: "unconfirmed" }), "retry");
    expect(calls).toEqual([
      {
        command: "retry_native_agent_dispatch",
        args: {
          environmentId: ENV,
          agent: "claude",
          logicalSessionKey: DESTINATION.logicalSessionKey,
          requestId: "req-1",
        },
      },
    ]);
  });

  test("discard records abandoned uncertainty rather than cancellation", async () => {
    await park();
    const observation = await adapter.recover(request({ state: "unconfirmed" }), "discard");
    expect(observation).toMatchObject({ state: "abandoned-unconfirmed" });
    expect(observation.reason).toContain("may still have run");
    expect(calls.map((call) => call.command)).toEqual(["discard_native_agent_dispatch"]);
  });

  test("recovery without a parked delivery does nothing to the provider", async () => {
    expect((await adapter.recover(request(), "retry")).reason).toContain("no parked delivery");
    expect((await adapter.recover(request(), "discard")).reason).toContain("no parked delivery");
    expect(calls).toEqual([]);
  });
});

describe("WebAnnotationDispatchAdapter.materialize", () => {
  const attachment = {
    assetId: "a1",
    digest: "sha256:abc",
    bytes: 3,
    relativePath: ".orkestrator/annotations/abc0123456789def.png",
  };

  test("writes exact bytes under the evidence directory for local environments", async () => {
    const [result] = await adapter.materialize({
      environment: { id: ENV, environmentType: "local", worktreePath: "/tmp/worktree-e1" },
      requestId: "req:1",
      attachments: [attachment],
      readAsset: async () => Buffer.from([1, 2, 3]),
    });
    expect(calls).toEqual([
      {
        command: "write_local_file",
        args: {
          worktreePath: "/tmp/worktree-e1",
          filePath: ".orkestrator/annotations/req_1-abc0123456789def.png",
          base64Data: Buffer.from([1, 2, 3]).toString("base64"),
        },
      },
    ]);
    expect(result).toEqual({
      ...attachment,
      relativePath: ".orkestrator/annotations/req_1-abc0123456789def.png",
      materializedPath: "/tmp/worktree-e1/.orkestrator/annotations/req_1-abc0123456789def.png",
    });
  });

  test("uses the container workspace path for docker environments", async () => {
    const [result] = await adapter.materialize({
      environment: { id: ENV, environmentType: "docker", containerId: "container-1" },
      requestId: "req-1",
      attachments: [attachment],
      readAsset: async () => Buffer.from([1, 2, 3]),
    });
    expect(calls[0]?.command).toBe("write_container_file");
    expect(result?.materializedPath).toBe(
      "/workspace/.orkestrator/annotations/req-1-abc0123456789def.png",
    );
  });

  test("rejects traversal, foreign names, and bytes that differ from the frozen request", async () => {
    const environmentInput = {
      id: ENV,
      environmentType: "local",
      worktreePath: "/tmp/worktree-e1",
    };
    await expect(
      adapter.materialize({
        environment: environmentInput,
        requestId: "req-1",
        attachments: [{ ...attachment, relativePath: "../../etc/passwd" }],
        readAsset: async () => Buffer.from([1, 2, 3]),
      }),
    ).rejects.toThrow("app-generated");
    await expect(
      adapter.materialize({
        environment: environmentInput,
        requestId: "..",
        attachments: [attachment],
        readAsset: async () => Buffer.from([1, 2, 3]),
      }),
    ).rejects.toThrow();
    await expect(
      adapter.materialize({
        environment: environmentInput,
        requestId: "req-1",
        attachments: [attachment],
        readAsset: async () => Buffer.from([1, 2]),
      }),
    ).rejects.toThrow("does not match");
    expect(calls).toEqual([]);
  });
});

describe("WebAnnotationDispatchAdapter destinations and responses", () => {
  test("lists layout agent tabs with holds and never offers closed tabs", async () => {
    await createSession();
    await storage.getOrCreateNativeAgentSession(
      {
        key: nativeAgentSessionStorageKey(ENV, "claude", `env-${ENV}:closed-tab`),
        environmentId: ENV,
        agent: "claude",
        logicalSessionKey: `env-${ENV}:closed-tab`,
      },
      async () => "provider-closed",
    );
    await saveLayout([
      {
        id: "tab-1",
        type: "agent-native",
        nativeAgentData: { platform: "claude" },
        displayTitle: "Fix header",
      },
      { id: "tab-2", type: "agent-native", nativeAgentData: { platform: "claude" } },
      {
        id: "tab-review",
        type: "agent-native",
        isReviewTab: true,
        nativeAgentData: { platform: "claude" },
      },
      { id: "term", type: "terminal" },
    ]);
    await storage.saveComposeDraft(DRAFT_KEY, "environment", ENV, {
      text: "unsent",
      mentions: [],
      attachments: [],
    });
    await storage.enqueuePromptQueueMessage(QUEUE_KEY, ENV, { id: "user-1", text: "mine" });
    activity = "working";
    const options = await adapter.listDestinations(ENV, "tab-2");
    expect(options.map((option) => option.destination.tabId)).toEqual(["tab-1", "tab-2"]);
    expect(options[0]).toMatchObject({
      title: "Fix header",
      activity: "working",
      images: true,
      planMode: true,
      resultTools: false,
      holds: ["compose-draft", "queued-prompts"],
      isDefault: false,
    });
    expect(options[1]).toMatchObject({ title: "Cached title", holds: [], isDefault: true });
    expect(options[1]?.destination.logicalSessionKey).toBe(`env-${ENV}:tab-2`);
  });

  test("validation checks readiness and environment ownership", async () => {
    expect(await adapter.validateDestination(ENV, DESTINATION)).toMatchObject({ ok: true });
    expect(
      await adapter.validateDestination(ENV, {
        ...DESTINATION,
        logicalSessionKey: "env-other:tab-1",
      }),
    ).toMatchObject({ ok: false, code: "destination-unavailable" });
    expect(
      await adapter.validateDestination(STOPPED_ENV, {
        ...DESTINATION,
        logicalSessionKey: `env-${STOPPED_ENV}:tab-1`,
      }),
    ).toMatchObject({ ok: false, code: "environment-not-ready" });
    await saveLayout([
      { id: "tab-2", type: "agent-native", nativeAgentData: { platform: "claude" } },
    ]);
    expect(await adapter.validateDestination(ENV, DESTINATION)).toMatchObject({
      ok: false,
      code: "destination-unavailable",
    });
  });

  test("reads only the turn correlated by this request's marker", async () => {
    expect(await adapter.readResponse(request())).toEqual({
      excerpt: null,
      sourceAvailable: false,
    });
    await createSession();
    projection = {
      messages: [
        { id: "u0", role: "user", content: "unrelated", parts: [], createdAt: "t" },
        { id: "a0", role: "assistant", content: "latest is not ours", parts: [], createdAt: "t" },
        { id: "u1", role: "user", content: text("req-1"), parts: [], createdAt: "t" },
        { id: "a1", role: "assistant", content: "Padding fixed.", parts: [], createdAt: "t" },
        { id: "a2", role: "assistant", content: "Tests pass.", parts: [], createdAt: "t" },
        { id: "u2", role: "user", content: "next", parts: [], createdAt: "t" },
        { id: "a3", role: "assistant", content: "Other answer", parts: [], createdAt: "t" },
      ],
    };
    expect(await adapter.readResponse(request())).toEqual({
      excerpt: {
        text: "Padding fixed.\n\nTests pass.",
        capturedAt: "2026-09-24T00:00:00.000Z",
        provenance: "agent-reference",
        messageId: "a1",
        truncated: false,
      },
      sourceAvailable: true,
      transcript: { messageId: "u1" },
    });
    expect(await adapter.readResponse(request({}, "req-other"))).toEqual({
      excerpt: null,
      sourceAvailable: true,
    });

    projection = {
      messages: [
        { id: "u1", role: "user", content: text("req-1"), parts: [], createdAt: "t" },
        { id: "a1", role: "assistant", content: "x".repeat(5_000), parts: [], createdAt: "t" },
      ],
    };
    const long = await adapter.readResponse(request());
    expect(long.excerpt?.truncated).toBe(true);
    expect(long.excerpt?.text).toHaveLength(4_000);
  });
});
