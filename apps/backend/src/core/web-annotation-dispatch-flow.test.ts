/**
 * Request flow across the real native queue storage, the real dispatch
 * adapter and the real brief compiler, with the native agent service replaced
 * by in-memory activity. Crash points are simulated by driving the storage
 * the drain would use and replacing the annotation service instance.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import {
  WEB_ANNOTATION_QUEUE_ITEM_FROZEN,
  webAnnotationRequestMarker,
  type WebAnnotationDestination,
} from "@orkestrator/protocol/web-annotations";
import { fixtureCaptureInput } from "@orkestrator/protocol/web-annotations-fixtures";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerPromptCommands } from "./commands-registry-prompts.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { StorageService } from "./storage.js";
import {
  compileWebAnnotationBrief,
  composeWebAnnotationDispatchText,
} from "./web-annotation-brief.js";
import {
  WebAnnotationDispatchAdapter,
  webAnnotationQueueKey,
  type WebAnnotationDispatchNativeAgents,
} from "./web-annotation-dispatch.js";
import { WebAnnotationService } from "./web-annotation-service.js";
import { makePng } from "./web-annotation-test-support.js";

const ENV_A = "flow-a";
const ENV_B = "flow-b";

function destination(environmentId: string, tabId = "tab-1"): WebAnnotationDestination {
  return { agent: "claude", tabId, logicalSessionKey: `env-${environmentId}:${tabId}` };
}

function sessionKey(environmentId: string, tabId = "tab-1") {
  return nativeAgentSessionStorageKey(environmentId, "claude", `env-${environmentId}:${tabId}`);
}

function draftKey(environmentId: string, tabId = "tab-1") {
  return `claude:${environmentId}:${encodeURIComponent(`env-${environmentId}:${tabId}`)}`;
}

let dataDir: string;
let storage: StorageService;
let activity: Map<string, AgentActivityState | "unknown">;
let projections: Map<string, { messages: unknown[] }>;
let invoked: Array<{ command: string; args: Record<string, unknown> }>;
let services: WebAnnotationService[];
let service: WebAnnotationService;
let now: number;

function environment(id: string) {
  return {
    id,
    projectId: "proj-1",
    name: id,
    branch: "main",
    containerId: null,
    status: "running" as const,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted" as const,
    order: 0,
    environmentType: "local" as const,
    worktreePath: path.join(dataDir, `worktree-${id}`),
    setupPhase: "ready" as const,
  };
}

const nativeAgents = {
  sessionActivitySnapshot: (environmentId: string) => activity.get(environmentId) ?? "unknown",
  sessionTurnActivitySnapshot: (environmentId: string) => activity.get(environmentId) ?? "unknown",
  sessionPresentationSnapshot: (environmentId: string) => ({
    presence: activity.get(environmentId) ?? "unknown",
  }),
  reconcileMailInject: async () => "unknown" as const,
  getProjection: async (input: { environmentId: string }) =>
    projections.get(input.environmentId) ?? null,
  sessionTurnOutcome: async () => ({ outcome: "completed" as const }),
  notifyPromptQueueChanged: () => undefined,
} as unknown as WebAnnotationDispatchNativeAgents;

function makeService(): WebAnnotationService {
  const adapter = new WebAnnotationDispatchAdapter({
    storage,
    nativeAgents,
    invoke: async (command, args) => {
      invoked.push({ command, args });
      if (command === "write_local_file") {
        return path.join(String(args.worktreePath), String(args.filePath));
      }
      return null;
    },
    now: () => now,
  });
  const created = new WebAnnotationService({
    dataDir: path.join(dataDir, "annotations"),
    storage: storage as never,
    dispatch: adapter,
    compileBrief: compileWebAnnotationBrief,
    composeText: composeWebAnnotationDispatchText,
    syncDirectories: false,
    clock: () => now,
  });
  services.push(created);
  return created;
}

async function restart(): Promise<WebAnnotationService> {
  await service.close();
  service = makeService();
  await service.initialize();
  return service;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-wa-flow-"));
  storage = new StorageService(path.join(dataDir, "storage"));
  await storage.init();
  await storage.addEnvironment(environment(ENV_A) as never);
  await storage.addEnvironment(environment(ENV_B) as never);
  activity = new Map();
  projections = new Map();
  invoked = [];
  services = [];
  now = Date.parse("2026-09-24T10:00:00.000Z");
  service = makeService();
  await service.initialize();
});

afterEach(async () => {
  for (const created of services) await created.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function note(environmentId: string, body: string, assetIds: string[] = []) {
  return service.create({
    environmentId,
    operationId: `op-${Math.random().toString(36).slice(2)}`,
    capture: { ...fixtureCaptureInput("element"), assetIds },
    body,
  });
}

async function stage(environmentId: string, seed: number) {
  return (
    await service.stageAsset({
      environmentId,
      operationId: `asset-${seed}-${Math.random().toString(36).slice(2)}`,
      mediaType: "image/png",
      data: makePng(4, 3, seed).toString("base64"),
    })
  ).asset;
}

async function sendRequest(
  environmentId: string,
  annotationIds: string[],
  requestId: string,
  target = destination(environmentId),
) {
  const annotations = [];
  for (const annotationId of annotationIds) {
    const { annotation } = await service.get(environmentId, annotationId);
    annotations.push({
      annotationId,
      expectedContentRevision: annotation.contentRevision,
      expectedCaptureId: annotation.currentCaptureId,
    });
  }
  const preparation = await service.prepare({
    environmentId,
    operation: "implement",
    destination: target,
    annotations,
    instruction: "",
  });
  expect(preparation.sendable).toBe(true);
  const sent = await service.send({
    environmentId,
    preparationId: preparation.preparationId,
    requestId,
    bodyHash: preparation.bodyHash,
  });
  return { preparation, request: sent.request };
}

async function createSession(environmentId: string) {
  return storage.getOrCreateNativeAgentSession(
    {
      key: sessionKey(environmentId),
      environmentId,
      agent: "claude",
      logicalSessionKey: destination(environmentId).logicalSessionKey,
    },
    async () => `provider-${environmentId}`,
  );
}

/** What the native drain does: reserve the head, send it once, acknowledge. */
async function drainAccept(environmentId: string, requestId: string, acknowledge = true) {
  const queueKey = webAnnotationQueueKey(destination(environmentId));
  const reserved = await storage.reservePromptQueueHeadForDispatch(queueKey);
  expect(reserved?.requestId).toBe(requestId);
  await storage.dispatchNativeAgentPromptOnce(sessionKey(environmentId), requestId, async () => {
    activity.set(environmentId, "working");
  });
  if (acknowledge) await storage.acknowledgePromptQueueDispatch(queueKey, requestId);
}

async function requestOf(environmentId: string, requestId: string) {
  return (await service.getRequest(environmentId, requestId)).request;
}

describe("web annotation request flow (real queue and adapter)", () => {
  test("SSE loss and a restart after provider acceptance recover one execution", async () => {
    await createSession(ENV_A);
    const x = await note(ENV_A, "Make the header sticky");
    const { request } = await sendRequest(ENV_A, [x.annotationId], "req-flow-1");
    expect(request.state).toBe("queued");
    const queueKey = webAnnotationQueueKey(destination(ENV_A));
    expect((await storage.getPromptQueue(queueKey))?.messages).toHaveLength(1);
    const generation = (await service.changes(ENV_A, undefined, 0)).generation;

    // Provider accepted, then the backend died before the queue acknowledgement
    // and before any annotation update. Every live event is lost with it.
    await drainAccept(ENV_A, "req-flow-1", false);
    const restarted = await restart();
    expect((await restarted.changes(ENV_A, generation, 0)).resetRequired).toBe(true);
    await restarted.reconcileOnce();
    expect(await requestOf(ENV_A, "req-flow-1")).toMatchObject({
      state: "running",
      reservation: true,
    });
    expect((await requestOf(ENV_A, "req-flow-1")).dispatchConfirmedAt).not.toBeNull();

    // Recovery can re-publish nothing: the id is held in flight and consumed.
    await restarted.recoverRequest(ENV_A, "req-flow-1", "reconcile");
    await storage.acknowledgePromptQueueDispatch(queueKey, "req-flow-1");
    activity.set(ENV_A, "idle");
    await restarted.reconcileOnce();
    const settled = await requestOf(ENV_A, "req-flow-1");
    expect(settled).toMatchObject({
      state: "awaiting-review",
      reservation: false,
      turnOutcome: "completed",
    });
    const session = await storage.getNativeAgentSession(sessionKey(ENV_A));
    expect(session?.dispatchedRequestIds?.filter((id) => id === "req-flow-1")).toHaveLength(1);
    expect((await storage.getPromptQueue(queueKey))?.messages).toEqual([]);
  });

  test("a crash after commit but before the queue write re-publishes the same id once", async () => {
    const x = await note(ENV_A, "Fix the typo");
    const original = storage.enqueuePromptQueueMessageIfAbsent.bind(storage);
    let failures = 1;
    storage.enqueuePromptQueueMessageIfAbsent = (async (...args: Parameters<typeof original>) => {
      if (failures-- > 0) throw new Error("backend stopped before the queue write");
      return original(...args);
    }) as typeof original;
    const { request } = await sendRequest(ENV_A, [x.annotationId], "req-flow-2");
    expect(request.state).toBe("prepared");
    const restarted = await restart();
    await restarted.reconcileOnce();
    await restarted.reconcileOnce();
    expect((await requestOf(ENV_A, "req-flow-2")).state).toBe("queued");
    const queue = await storage.getPromptQueue(webAnnotationQueueKey(destination(ENV_A)));
    expect(queue?.messages.map((message) => (message as { id: string }).id)).toEqual([
      "req-flow-2",
    ]);
  });

  test("a claim racing cancellation and an unrelated next turn never mis-settles", async () => {
    await createSession(ENV_A);
    const x = await note(ENV_A, "Tighten the spacing");
    const { request } = await sendRequest(ENV_A, [x.annotationId], "req-flow-3");
    const queueKey = webAnnotationQueueKey(destination(ENV_A));
    // The drain reserves the item; the user presses Cancel at the same time.
    await storage.reservePromptQueueHeadForDispatch(queueKey);
    const cancel = await service.cancelRequest(ENV_A, "req-flow-3", request.revision);
    expect(cancel).toMatchObject({ outcome: "not-cancellable", refusal: "claimed" });
    expect(cancel.request).toMatchObject({ reservation: true });
    expect(cancel.request.cancelRefusal?.code).toBe("claimed");

    // The claimed turn runs; then the user's own unrelated prompt follows.
    await storage.dispatchNativeAgentPromptOnce(sessionKey(ENV_A), "req-flow-3", async () => {
      activity.set(ENV_A, "working");
    });
    await storage.acknowledgePromptQueueDispatch(queueKey, "req-flow-3");
    await storage.enqueuePromptQueueMessage(queueKey, ENV_A, { id: "user-next", text: "next" });
    await drainAccept(ENV_A, "user-next");
    await service.reconcileOnce();
    expect(await requestOf(ENV_A, "req-flow-3")).toMatchObject({
      state: "running",
      reservation: true,
    });
    // A second cancel is refused: a newer turn is live, and it is not stopped.
    const again = await service.cancelRequest(
      ENV_A,
      "req-flow-3",
      (await requestOf(ENV_A, "req-flow-3")).revision,
    );
    expect(again).toMatchObject({ outcome: "not-cancellable", refusal: "newer-turn" });
    expect(invoked.some((call) => call.command === "stop_native_agent_session")).toBe(false);

    activity.set(ENV_A, "idle");
    await service.reconcileOnce();
    expect(await requestOf(ENV_A, "req-flow-3")).toMatchObject({
      state: "awaiting-review",
      cancelArrivedLate: true,
      reservation: false,
    });
  });

  test("work finishing in environment A while B is in use recovers without re-running", async () => {
    await createSession(ENV_A);
    await createSession(ENV_B);
    const a = await note(ENV_A, "Environment A change");
    const b = await note(ENV_B, "Environment B change");
    await sendRequest(ENV_A, [a.annotationId], "req-a");
    await sendRequest(ENV_B, [b.annotationId], "req-b");
    await drainAccept(ENV_A, "req-a");
    await drainAccept(ENV_B, "req-b");
    activity.set(ENV_A, "idle");
    activity.set(ENV_B, "working");
    await service.reconcileOnce();
    await service.reconcileOnce();
    expect((await requestOf(ENV_A, "req-a")).state).toBe("awaiting-review");
    expect((await requestOf(ENV_B, "req-b")).state).toBe("running");

    // Returning to A: the transcript turn is correlated by marker, once.
    projections.set(ENV_A, {
      messages: [
        {
          id: "user-a",
          role: "user",
          content: `${webAnnotationRequestMarker("req-a", "implement", 1)}\n\nbody`,
        },
        { id: "assistant-a", role: "assistant", content: "Done in A." },
      ],
    });
    const response = await service.requestResponse(ENV_A, "req-a");
    expect(response.response).toMatchObject({ text: "Done in A.", messageId: "assistant-a" });
    expect(response.request.transcript).toMatchObject({ messageId: "user-a" });
    await restart();
    await service.reconcileOnce();
    const sessionA = await storage.getNativeAgentSession(sessionKey(ENV_A));
    expect(sessionA?.dispatchedRequestIds).toEqual(["req-a"]);
    expect(
      (await storage.getPromptQueue(webAnnotationQueueKey(destination(ENV_A))))?.messages,
    ).toEqual([]);
  });

  test("prepare and send leave the destination's native compose draft untouched", async () => {
    const draftValue = { text: "my unsent chat draft", mentions: [], attachments: [] };
    await storage.saveComposeDraft(draftKey(ENV_A), "environment", ENV_A, draftValue);
    const before = await storage.getComposeDraft(draftKey(ENV_A));
    const x = await note(ENV_A, "Reword the banner");
    await sendRequest(ENV_A, [x.annotationId], "req-flow-5");
    await service.reconcileOnce();
    const after = await storage.getComposeDraft(draftKey(ENV_A));
    expect(after).toEqual(before);
    expect(await requestOf(ENV_A, "req-flow-5")).toMatchObject({
      state: "queued",
      blockedReason: "compose-draft",
    });
  });

  test("the evidence manifest matches the attachments the agent receives", async () => {
    const shared = await stage(ENV_A, 1);
    const own = await stage(ENV_A, 2);
    const x = await note(ENV_A, "Align the icons", [shared.id]);
    const y = await note(ENV_A, "Align the labels", [shared.id, own.id]);
    const { preparation, request } = await sendRequest(
      ENV_A,
      [x.annotationId, y.annotationId],
      "req-flow-6",
    );
    // Deduplicated by digest: two distinct images for three references.
    expect(preparation.evidence.imageCount).toBe(2);
    expect(preparation.attachments.map((item) => item.assetId).sort()).toEqual(
      [shared.id, own.id].sort(),
    );
    for (const item of preparation.evidence.items) expect(item.included).toContain("image");
    const [message] = (await storage.getPromptQueue(webAnnotationQueueKey(destination(ENV_A))))!
      .messages as Array<{ attachments: Array<{ path: string; filename: string }> }>;
    expect(message!.attachments.map((attachment) => attachment.path)).toEqual(
      request.attachments.map((attachment) => attachment.materializedPath!),
    );
    expect(message!.attachments).toHaveLength(preparation.evidence.imageCount);
    const written = invoked.filter((call) => call.command === "write_local_file");
    expect(written).toHaveLength(2);
  });

  test("removing the request from the chat queue cancels it and frees the note", async () => {
    const x = await note(ENV_A, "Remove the badge");
    await sendRequest(ENV_A, [x.annotationId], "req-flow-7");
    const queueKey = webAnnotationQueueKey(destination(ENV_A));
    // Frozen: the chat cannot turn it into an editable draft.
    await expect(
      storage.transferPromptQueueMessageToComposeDraft(
        queueKey,
        ENV_A,
        "req-flow-7",
        draftKey(ENV_A),
        "environment",
        ENV_A,
      ),
    ).rejects.toThrow("frozen");
    // An older client removes it directly: the tombstone still settles it.
    await storage.removePromptQueueMessage(queueKey, ENV_A, "req-flow-7");
    await service.reconcileOnce();
    expect(await requestOf(ENV_A, "req-flow-7")).toMatchObject({
      state: "cancelled",
      cancelSource: "chat-queue",
      reservation: false,
    });
    expect((await service.get(ENV_A, x.annotationId)).annotation.activeRequestId).toBeNull();

    // The chat-queue cancel path settles through annotation cancellation.
    await sendRequest(ENV_A, [x.annotationId], "req-flow-8");
    const handled = await service.cancelFromChatQueue(ENV_A, "req-flow-8");
    expect(handled).toMatchObject({ removed: true, request: { state: "cancelled" } });
    expect((await storage.getPromptQueue(queueKey))?.messages).toEqual([]);
  });

  test("the chat's queue commands route annotation items through their request", async () => {
    const commands = new Map<string, CommandHandler>();
    registerPromptCommands((name, handler) => commands.set(name, handler), {
      conditionalManifestSnapshot: async () => undefined,
    } as never);
    const context = { storage, webAnnotations: service } as unknown as CommandContext;
    const call = (name: string, args: Record<string, unknown>) =>
      commands.get(name)!(args, context) as Promise<any>;
    const queueKey = webAnnotationQueueKey(destination(ENV_A));
    const x = await note(ENV_A, "Shorten the title");
    await sendRequest(ENV_A, [x.annotationId], "req-flow-9");
    await call("enqueue_prompt_queue_message", {
      queueKey,
      environmentId: ENV_A,
      message: { id: "user-1", text: "mine" },
    });
    // A client cannot forge a backend-authored origin.
    await expect(
      call("enqueue_prompt_queue_message", {
        queueKey,
        environmentId: ENV_A,
        message: { id: "forged", text: "x", origin: { kind: "web-annotation", requestId: "x" } },
      }),
    ).rejects.toThrow("assigned by the backend");
    await expect(
      call("transfer_prompt_queue_message_to_compose_draft", {
        queueKey,
        environmentId: ENV_A,
        messageId: "req-flow-9",
        draftKey: draftKey(ENV_A),
        ownerType: "environment",
        ownerId: ENV_A,
      }),
    ).rejects.toThrow(WEB_ANNOTATION_QUEUE_ITEM_FROZEN);
    const removed = await call("remove_prompt_queue_message", {
      queueKey,
      environmentId: ENV_A,
      messageId: "req-flow-9",
    });
    expect(removed.removed).toMatchObject({
      id: "req-flow-9",
      origin: { kind: "web-annotation", requestId: "req-flow-9" },
    });
    expect(removed.queue.messages.map((message: { id: string }) => message.id)).toEqual(["user-1"]);
    expect(await requestOf(ENV_A, "req-flow-9")).toMatchObject({
      state: "cancelled",
      cancelSource: "chat-queue",
      reservation: false,
    });
    // Ordinary prompts are removed exactly as before.
    const plain = await call("remove_prompt_queue_message", {
      queueKey,
      environmentId: ENV_A,
      messageId: "user-1",
    });
    expect(plain.removed).toMatchObject({ id: "user-1" });
  });
});
