import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RICH_INTERACTION_LIMITS,
  parseRichInteractionPrompt,
} from "@orkestrator/protocol/rich-interactions";
import { RICH_KIND_FIXTURES } from "@orkestrator/protocol/testing/rich-interaction-fixtures";
import { StorageService } from "../storage/service.js";
import {
  ProductCommandRegistry,
  graphWorkflowCommands,
  type GraphRunControls,
} from "./product-commands.js";
import { RichInteractionError, RichInteractionService, type FollowupDelivery } from "./service.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

interface FakeQueue {
  delivery: FollowupDelivery;
  queued: Map<string, { text: string; queueKey: string }>;
  dispatched: Set<string>;
  failNext: number;
  notified: string[];
}

function fakeDelivery(): FakeQueue {
  const fake: FakeQueue = {
    queued: new Map(),
    dispatched: new Set(),
    failNext: 0,
    notified: [],
    delivery: {
      resolveAgent: async () => "claude",
      async enqueue(input) {
        if (fake.failNext > 0) {
          fake.failNext -= 1;
          throw new Error("database is locked");
        }
        const existing = fake.queued.get(input.requestId);
        if (existing) return existing.text === input.text ? "present" : "conflict";
        if (fake.dispatched.has(input.requestId)) return "consumed";
        fake.queued.set(input.requestId, { text: input.text, queueKey: input.queueKey });
        return "queued";
      },
      notify: (queueKey) => fake.notified.push(queueKey),
      dispatched: async (_e, _a, _l, requestId) => fake.dispatched.has(requestId),
    },
  };
  return fake;
}

async function setup(options: { graphRuns?: GraphRunControls; now?: () => Date } = {}) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-rich-interactions-"));
  directories.push(dataDir);
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  const queue = fakeDelivery();
  const commands = new ProductCommandRegistry();
  for (const command of graphWorkflowCommands(() => options.graphRuns)) commands.register(command);
  const service = new RichInteractionService({
    hasPublishedArtifact: (_owner, ref) => ref.artifactId === "shot-after" && ref.revision === 1,
    store: () => storage.richInteractionStore(),
    delivery: queue.delivery,
    commands,
    ...(options.now ? { now: options.now } : {}),
  });
  return { storage, service, queue, commands };
}

const caller = { environmentId: "env-1", tabId: "tab-1" };

async function present(
  service: RichInteractionService,
  kind: keyof typeof RICH_KIND_FIXTURES,
  requestKey = "k1",
  extra: Record<string, unknown> = {},
) {
  const fixture = RICH_KIND_FIXTURES[kind];
  return service.present(
    caller,
    { requestKey, kind, title: fixture.title, spec: fixture.spec, ...extra },
    "toolu_1",
  );
}

async function rejection(work: () => Promise<unknown> | unknown): Promise<RichInteractionError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof RichInteractionError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("present_interaction", () => {
  test("creates once per requestKey; a different payload under the same key conflicts", async () => {
    const { service } = await setup();
    const first = await present(service, "choice");
    expect(first.created).toBe(true);
    expect(first.request.owner).toMatchObject({
      environmentId: "env-1",
      tabId: "tab-1",
      logicalSessionKey: "env-env-1:tab-1",
      agent: "claude",
    });
    expect(first.request.toolCallId).toBe("toolu_1");
    const replay = await present(service, "choice");
    expect(replay).toMatchObject({
      created: false,
      request: { interactionId: first.request.interactionId },
    });
    const conflict = await rejection(() =>
      service.present(caller, {
        requestKey: "k1",
        kind: "choice",
        title: "Other",
        spec: RICH_KIND_FIXTURES.choice.spec,
      }),
    );
    expect(conflict.code).toBe("conflict");
  });

  test("a superseded request refuses submissions and names its replacement", async () => {
    const { service } = await setup();
    const old = await present(service, "choice", "a");
    const next = await present(service, "choice", "b", {
      supersedes: old.request.interactionId,
      title: "Revised",
    });
    const view = service.get("env-1", old.request.interactionId);
    expect(view.request).toMatchObject({
      state: "superseded",
      supersededBy: next.request.interactionId,
    });
    const refused = await rejection(() =>
      service.submit("env-1", {
        interactionId: old.request.interactionId,
        expectedRevision: 1,
        actionId: "submit",
        idempotencyKey: "i1",
        result: RICH_KIND_FIXTURES.choice.result,
      }),
    );
    expect(refused.code).toBe("closed");
  });

  test("agents cannot read another conversation's interactions", async () => {
    const { service } = await setup();
    const created = await present(service, "form");
    expect(service.read(caller, created.request.interactionId).request.kind).toBe("form");
    expect(
      (
        await rejection(() =>
          service.read({ environmentId: "env-1", tabId: "tab-2" }, created.request.interactionId),
        )
      ).code,
    ).toBe("not-found");
  });
});

describe("submissions", () => {
  test("a follow-up commits once, is queued for the creating tab and recovers its receipt on retry", async () => {
    const { service, queue } = await setup();
    const { request } = await present(service, "choice");
    const input = {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "submit",
      idempotencyKey: "click-1",
      result: RICH_KIND_FIXTURES.choice.result,
    };
    const receipt = await service.submit("env-1", input);
    expect(receipt.delivery).toBe("queued");
    expect(queue.queued.size).toBe(1);
    const [requestId, queued] = [...queue.queued.entries()][0]!;
    expect(requestId).toBe(receipt.receiptId);
    expect(queued!.queueKey).toBe("claude\0env-env-1:tab-1");
    expect(parseRichInteractionPrompt(queued!.text)?.envelope).toMatchObject({
      interactionId: request.interactionId,
      receiptId: receipt.receiptId,
      actionId: "submit",
    });
    expect(queued!.text).toContain("Focused list");
    // Lost response: the same key returns the same receipt and queues nothing new.
    const again = await service.submit("env-1", input);
    expect(again.receiptId).toBe(receipt.receiptId);
    expect(queue.queued.size).toBe(1);
    // The single-use question is closed.
    expect(service.get("env-1", request.interactionId).request.state).toBe("closed");
    // A changed payload under the same key is a conflict.
    const conflict = await rejection(() =>
      service.submit("env-1", {
        ...input,
        result: { answers: [{ questionId: "findings-layout", optionIds: ["board"] }] },
      }),
    );
    expect(conflict.code).toBe("conflict");
  });

  test("delivery advances to delivered once the session dispatches the request", async () => {
    const { service, queue } = await setup();
    const { request } = await present(service, "form");
    const receipt = await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "submit",
      idempotencyKey: "s1",
      result: RICH_KIND_FIXTURES.form.result,
    });
    queue.dispatched.add(receipt.receiptId);
    await service.sweep();
    expect(service.get("env-1", request.interactionId).receipts[0]!.delivery).toBe("delivered");
  });

  test("a commit survives a failed enqueue and the sweep (restart recovery) delivers it", async () => {
    const { service, queue } = await setup();
    const { request } = await present(service, "form");
    queue.failNext = 1;
    const receipt = await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "submit",
      idempotencyKey: "s1",
      result: RICH_KIND_FIXTURES.form.result,
    });
    expect(receipt.delivery).toBe("pending");
    expect(queue.queued.size).toBe(0);
    await service.sweep();
    expect(service.get("env-1", request.interactionId).receipts[0]!.delivery).toBe("queued");
    expect(queue.queued.size).toBe(1);
  });

  test("repeated enqueue failures become unknown and are never resent automatically", async () => {
    const { service, queue } = await setup();
    const { request } = await present(service, "form");
    queue.failNext = 100;
    await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "submit",
      idempotencyKey: "s1",
      result: RICH_KIND_FIXTURES.form.result,
    });
    for (let i = 0; i < 6; i += 1) await service.sweep();
    const receipt = service.get("env-1", request.interactionId).receipts[0]!;
    expect(receipt.delivery).toBe("unknown");
    queue.failNext = 0;
    await service.sweep();
    expect(queue.queued.size).toBe(0);
    const retried = await service.retryDelivery("env-1", receipt.receiptId);
    expect(retried.delivery).toBe("queued");
  });

  test("a stale revision is refused and the draft is kept", async () => {
    const { service } = await setup();
    const { request } = await present(service, "plan");
    service.saveDraft("env-1", {
      interactionId: request.interactionId,
      expectedDraftRevision: 0,
      requestRevision: 1,
      value: { changes: [] },
    });
    await service.update(caller, {
      interactionId: request.interactionId,
      expectedRevision: 1,
      spec: {
        ...(RICH_KIND_FIXTURES.plan.spec as object),
        constraints: [{ id: "c1", text: "new" }],
      },
    });
    const stale = await rejection(() =>
      service.submit("env-1", {
        interactionId: request.interactionId,
        expectedRevision: 1,
        actionId: "accept-scope",
        idempotencyKey: "a",
        result: RICH_KIND_FIXTURES.plan.result,
      }),
    );
    expect(stale.code).toBe("stale");
    expect(service.get("env-1", request.interactionId).draft?.value).toEqual({ changes: [] });
  });

  test("record-only actions deliver nothing; revise actions publish a user revision", async () => {
    const { service, queue } = await setup();
    const { request } = await present(service, "plan");
    const saved = await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "save",
      idempotencyKey: "save-1",
      result: {
        baseRevision: 1,
        changes: [{ op: "setIncluded", stepId: "historical-migration", value: false }],
      },
    });
    expect(saved).toMatchObject({ delivery: "recorded", resultingRevision: 2 });
    expect(queue.queued.size).toBe(0);
    const view = service.get("env-1", request.interactionId);
    expect(view.request).toMatchObject({ revision: 2, revisionAuthor: "user", state: "open" });
    // The agent must re-read before publishing: its stale update is refused.
    expect(
      (
        await rejection(() =>
          service.update(caller, {
            interactionId: request.interactionId,
            expectedRevision: 1,
            spec: RICH_KIND_FIXTURES.plan.spec,
          }),
        )
      ).code,
    ).toBe("stale");
  });

  test("drafts are revision-checked between windows", async () => {
    const { service } = await setup();
    const { request } = await present(service, "form");
    service.saveDraft("env-1", {
      interactionId: request.interactionId,
      expectedDraftRevision: 0,
      requestRevision: 1,
      value: { a: 1 },
    });
    const conflict = await rejection(() =>
      service.saveDraft("env-1", {
        interactionId: request.interactionId,
        expectedDraftRevision: 0,
        requestRevision: 1,
        value: { a: 2 },
      }),
    );
    expect(conflict.code).toBe("conflict");
    expect(service.get("env-1", request.interactionId).draft).toMatchObject({
      revision: 1,
      value: { a: 1 },
    });
  });

  test("another environment cannot submit to a request", async () => {
    const { service } = await setup();
    const { request } = await present(service, "choice");
    const refused = await rejection(() =>
      service.submit("env-2", {
        interactionId: request.interactionId,
        expectedRevision: 1,
        actionId: "submit",
        idempotencyKey: "x",
        result: RICH_KIND_FIXTURES.choice.result,
      }),
    );
    expect(refused.code).toBe("not-found");
  });

  test("expired requests refuse submissions", async () => {
    let now = Date.parse("2026-11-20T00:00:00Z");
    const { service } = await setup({ now: () => new Date(now) });
    const { request } = await present(service, "choice", "k", { expiresInSeconds: 60 });
    now += 120_000;
    expect(service.get("env-1", request.interactionId).request.state).toBe("expired");
    const refused = await rejection(() =>
      service.submit("env-1", {
        interactionId: request.interactionId,
        expectedRevision: 1,
        actionId: "submit",
        idempotencyKey: "x",
        result: RICH_KIND_FIXTURES.choice.result,
      }),
    );
    expect(refused.code).toBe("closed");
  });
});

describe("user-originated requests", () => {
  test("a saved note never dispatches; discuss delivers once; agents may only append replies", async () => {
    const { service, queue } = await setup();
    const { request, receipt } = await service.compose("env-1", {
      tabId: "tab-1",
      kind: "feedback",
      title: "Comment",
      spec: RICH_KIND_FIXTURES.feedback.spec,
      actionId: "save-note",
      idempotencyKey: "note-1",
      result: { body: "Check alignment" },
    });
    expect(receipt.delivery).toBe("recorded");
    expect(queue.queued.size).toBe(0);
    expect(request.revision).toBe(2);
    const discuss = await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 2,
      actionId: "discuss",
      idempotencyKey: "d1",
      result: { body: "Why is this misaligned?" },
    });
    expect(discuss.delivery).toBe("queued");
    const view = service.get("env-1", request.interactionId);
    expect((view.request.spec as { entries: unknown[] }).entries).toHaveLength(2);
    const spec = view.request.spec as { entries: Array<Record<string, unknown>> };
    const replied = await service.update(caller, {
      interactionId: request.interactionId,
      expectedRevision: view.request.revision,
      spec: {
        ...spec,
        entries: [
          ...spec.entries,
          { entryId: "a1", author: "agent", body: "Fixed padding", createdAt: "t" },
        ],
      },
    });
    expect((replied.spec as { entries: unknown[] }).entries).toHaveLength(3);
  });

  test("agents cannot create user-originated kinds", async () => {
    const { service } = await setup();
    const refused = await rejection(() =>
      service.present(caller, {
        requestKey: "k",
        kind: "context-packet",
        title: "x",
        spec: RICH_KIND_FIXTURES["context-packet"].spec,
      }),
    );
    expect(refused.code).toBe("invalid");
  });
});

describe("product commands", () => {
  const graphRun = (revision: number) =>
    ({ id: "run-3", revision, status: "running", environmentId: "env-1" }) as unknown as Awaited<
      ReturnType<GraphRunControls["retry"]>
    >;

  test("unregistered commands are unavailable and refused before commit", async () => {
    const { service } = await setup();
    const { request } = await present(service, "diagnostics");
    const view = service.get("env-1", request.interactionId);
    expect(view.actions.find((a) => a.id === "rerun-selection")).toMatchObject({
      available: false,
    });
    const refused = await rejection(() =>
      service.submit("env-1", {
        interactionId: request.interactionId,
        expectedRevision: 1,
        actionId: "rerun-selection",
        idempotencyKey: "r",
        result: { runRevision: 7, caseIds: ["auth:expired-session"] },
      }),
    );
    expect(refused.code).toBe("unavailable");
    expect(service.get("env-1", request.interactionId).receipts).toHaveLength(0);
  });

  test("a graph retry rechecks the live revision and names the attempt", async () => {
    const calls: string[] = [];
    let liveRevision = 4;
    const graphRuns: GraphRunControls = {
      get: async () => graphRun(liveRevision),
      retry: async (runId, activationKey) => {
        calls.push(`${runId}:${activationKey}`);
        return graphRun(5);
      },
      cancel: async () => graphRun(5),
    };
    const { service } = await setup({ graphRuns });
    const spec = {
      ...(RICH_KIND_FIXTURES["workflow-actions"].spec as object),
      workflowId: "graph",
    };
    const { request } = await service.present(caller, {
      requestKey: "w",
      kind: "workflow-actions",
      title: "Validation",
      spec,
    });
    const ok = await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "retry-node",
      idempotencyKey: "r1",
      result: { nodeId: "validation", attemptId: "attempt-3", snapshotRevision: 4 },
    });
    expect(ok.delivery).toBe("applied");
    expect(calls).toEqual(["run-3:attempt-3"]);
    liveRevision = 6;
    const stale = await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "retry-node",
      idempotencyKey: "r2",
      result: { nodeId: "validation", attemptId: "attempt-3", snapshotRevision: 4 },
    });
    expect(stale.delivery).toBe("failed");
    expect(stale.deliveryDetail).toContain("advanced");
    expect(calls).toHaveLength(1);
  });

  test("a committed operation recovers against its original run after a card update", async () => {
    const targets: string[] = [];
    const controls: GraphRunControls = {
      get: async (id) => ({ ...graphRun(4), id }),
      retry: async (id) => {
        targets.push(id);
        return graphRun(5);
      },
      cancel: async () => graphRun(5),
    };
    const { storage, service, queue, commands } = await setup({ graphRuns: controls });
    const spec = {
      ...(RICH_KIND_FIXTURES["workflow-actions"].spec as object),
      workflowId: "graph",
    };
    const { request } = await present(service, "workflow-actions", "recover", { spec });
    const store = storage.richInteractionStore();
    const atomic = store.atomic.bind(store);
    const interrupt = spyOn(store, "atomic").mockImplementationOnce((work) => {
      atomic(work);
      throw new Error("interrupted after commit");
    });
    try {
      await expect(
        service.submit("env-1", {
          interactionId: request.interactionId,
          expectedRevision: 1,
          actionId: "retry-node",
          idempotencyKey: "recover",
          result: { nodeId: "validation", attemptId: "attempt-3", snapshotRevision: 4 },
        }),
      ).rejects.toThrow("interrupted after commit");
    } finally {
      interrupt.mockRestore();
    }
    expect(targets).toEqual([]);
    await service.update(caller, {
      interactionId: request.interactionId,
      expectedRevision: 1,
      spec: { ...spec, runId: "replacement-run" },
    });
    const restarted = new RichInteractionService({
      store: () => store,
      commands,
      delivery: queue.delivery,
    });
    await restarted.sweep();
    expect(targets).toEqual(["run-3"]);
    expect(restarted.get("env-1", request.interactionId).receipts[0]?.delivery).toBe("applied");
  });

  test("graph operations refuse a run without an owning environment", async () => {
    let calls = 0;
    const { service } = await setup({
      graphRuns: {
        get: async () => {
          const { environmentId: _environmentId, ...run } = graphRun(4);
          return run;
        },
        retry: async () => {
          calls += 1;
          return graphRun(5);
        },
        cancel: async () => {
          calls += 1;
          return graphRun(5);
        },
      },
    });
    const spec = {
      ...(RICH_KIND_FIXTURES["workflow-actions"].spec as object),
      workflowId: "graph",
    };
    const { request } = await present(service, "workflow-actions", "unowned", { spec });
    const receipt = await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "retry-node",
      idempotencyKey: "unowned",
      result: { nodeId: "validation", attemptId: "attempt-3", snapshotRevision: 4 },
    });
    expect(receipt.delivery).toBe("failed");
    expect(receipt.deliveryDetail).toContain("belongs to another environment");
    expect(calls).toBe(0);
  });

  test("a stop that does not report cancelled stays unknown", async () => {
    const graphRuns: GraphRunControls = {
      get: async () => graphRun(4),
      retry: async () => graphRun(4),
      cancel: async () => graphRun(5),
    };
    const { service } = await setup({ graphRuns });
    const spec = structuredClone(RICH_KIND_FIXTURES["workflow-actions"].spec) as {
      workflowId: string;
      nodes: Array<{ state: string }>;
    };
    spec.workflowId = "graph";
    spec.nodes[1]!.state = "running";
    const { request } = await service.present(caller, {
      requestKey: "w",
      kind: "workflow-actions",
      title: "Validation",
      spec,
    });
    const receipt = await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "stop-node",
      idempotencyKey: "s1",
      result: {
        nodeId: "validation",
        attemptId: "attempt-3",
        snapshotRevision: 4,
        confirmWholeRun: true,
      },
    });
    expect(receipt.delivery).toBe("unknown");
  });
});

describe("deliverables and deletion", () => {
  test("accepting a result review records the accepted artifact revision", async () => {
    const { service } = await setup();
    const { request } = await present(service, "result-review");
    await service.submit("env-1", {
      interactionId: request.interactionId,
      expectedRevision: 1,
      actionId: "accept",
      idempotencyKey: "a",
      result: { expectedResultRevision: 5, decision: "accept" },
    });
    const deliverables = service.listDeliverables("env-1", "env-env-1:tab-1");
    expect(deliverables).toEqual([
      expect.objectContaining({ artifactId: "shot-after", acceptedRevision: 1, pinned: false }),
    ]);
    const pinned = service.updateDeliverable("env-1", {
      logicalSessionKey: "env-env-1:tab-1",
      artifactId: "shot-after",
      expectedRevision: 1,
      patch: { pinned: true, userLabel: "Approved direction" },
    });
    expect(pinned).toMatchObject({
      pinned: true,
      userLabel: "Approved direction",
      acceptedRevision: 1,
      revision: 2,
    });
    expect(
      (
        await rejection(() =>
          service.updateDeliverable("env-1", {
            logicalSessionKey: "env-env-1:tab-1",
            artifactId: "shot-after",
            expectedRevision: 1,
            patch: { pinned: false },
          }),
        )
      ).code,
    ).toBe("conflict");
    expect(
      (
        await rejection(() =>
          service.updateDeliverable("env-1", {
            logicalSessionKey: "env-env-2:tab-1",
            artifactId: "x",
            expectedRevision: 0,
            patch: {},
          }),
        )
      ).code,
    ).toBe("forbidden");
  });

  test("deleting an environment removes its records", async () => {
    const { service } = await setup();
    const { request } = await present(service, "choice");
    service.environmentDeleted("env-1");
    expect((await rejection(() => service.get("env-1", request.interactionId))).code).toBe(
      "not-found",
    );
    expect(service.listForConversation("env-1", undefined)).toEqual([]);
  });
});

describe("review regressions", () => {
  const environmentId = "env-1";
  const voice = {
    tabId: caller.tabId,
    kind: "voice-request" as const,
    title: "Reviewed speech",
    spec: RICH_KIND_FIXTURES["voice-request"].spec,
    actionId: "send",
    idempotencyKey: "compose",
    result: { text: "Reviewed message" },
  };

  test("invalid compose leaves no request and a corrected draft can reuse its key", async () => {
    const { service } = await setup();
    expect(
      (await rejection(() => service.compose(environmentId, { ...voice, result: { text: 1 } })))
        .code,
    ).toBe("invalid");
    expect(service.listForConversation(environmentId, undefined)).toHaveLength(0);
    const sent = await service.compose(environmentId, { ...voice, title: "Corrected" });
    expect(sent.receipt.delivery).toBe("queued");
    expect(
      (await service.compose(environmentId, { ...voice, title: "Corrected" })).receipt.receiptId,
    ).toBe(sent.receipt.receiptId);
  });

  test("compose and present share capacity and supersession frees its predecessor's slot", async () => {
    const { service, storage } = await setup();
    const first = await present(service, "choice");
    const store = storage.richInteractionStore();
    store.atomic((tx) => {
      const template = tx.getRequest(first.request.interactionId)!;
      for (let index = 1; index < RICH_INTERACTION_LIMITS.openPerConversation; index++)
        tx.putRequest({ ...template, interactionId: `seed-${index}` });
    });
    expect((await rejection(() => service.compose(environmentId, voice))).code).toBe("capacity");
    expect((await rejection(() => present(service, "choice", "extra"))).code).toBe("capacity");
    expect(
      (await present(service, "choice", "replacement", { supersedes: first.request.interactionId }))
        .created,
    ).toBe(true);
    store.atomic((tx) => {
      const template = tx.getRequest(first.request.interactionId)!;
      for (const row of tx.listRequests(environmentId))
        tx.putRequest({
          ...row,
          state: "closed",
          ...(row.interactionId === first.request.interactionId
            ? { updatedAt: "2000-01-01T00:00:00Z" }
            : {}),
        });
      for (let index = 0; index < RICH_INTERACTION_LIMITS.perEnvironment; index++)
        tx.putRequest({ ...template, interactionId: `closed-${index}`, state: "closed" });
    });
    expect((await service.compose(environmentId, voice)).receipt.delivery).toBe("queued");
    expect((await present(service, "choice", "extra")).created).toBe(true);
    expect(store.read((tx) => tx.listRequests(environmentId))).toHaveLength(
      RICH_INTERACTION_LIMITS.perEnvironment,
    );
    expect(store.read((tx) => tx.getRequest(first.request.interactionId))).toBeNull();
    expect((await rejection(() => present(service, "choice"))).code).toBe("closed");
  });

  test("title and body updates only replay an identical intent", async () => {
    const { service } = await setup();
    const { request } = await present(service, "choice");
    const update = {
      interactionId: request.interactionId,
      expectedRevision: 1,
      title: "New title",
      body: "New body",
    };
    expect((await service.update(caller, update)).revision).toBe(2);
    expect((await service.update(caller, update)).title).toBe("New title");
    expect(
      (await rejection(() => service.update(caller, { ...update, title: "Other" }))).code,
    ).toBe("stale");
    expect((await rejection(() => service.update(caller, { ...update, body: "Other" }))).code).toBe(
      "stale",
    );
  });

  test("agent criteria cannot claim agreement, and an identical Agree replays after revision advancement", async () => {
    const { service } = await setup();
    const forged = {
      ...(RICH_KIND_FIXTURES.criteria.spec as object),
      phase: "agreed",
      walkthrough: { narrow: [0] },
    };
    const forgedCreate = {
      ...forged,
      assessments: {
        narrow: [
          {
            decision: "accepted",
            criterionHash: "forged",
            assessedAt: "2026-01-01T00:00:00Z",
            observations: [],
          },
        ],
      },
    };
    const { request } = await present(service, "criteria", "forged", { spec: forgedCreate });
    expect(request.spec).toMatchObject({ phase: "proposed", assessments: {}, walkthrough: {} });
    const updated = await service.update(caller, {
      interactionId: request.interactionId,
      expectedRevision: 1,
      spec: forged,
    });
    expect(updated.spec).toMatchObject({ phase: "proposed", assessments: {}, walkthrough: {} });
    const submit = {
      interactionId: request.interactionId,
      expectedRevision: 2,
      actionId: "agree",
      idempotencyKey: "agree",
      result: {},
    };
    const receipt = await service.submit(environmentId, submit);
    expect(receipt.resultingRevision).toBe(3);
    expect(await service.submit(environmentId, submit)).toEqual(receipt);
  });

  test("submission clears only the draft revision it consumed", async () => {
    const { service } = await setup();
    const { request } = await present(service, "criteria");
    const target = { interactionId: request.interactionId, requestRevision: 1 };
    service.saveDraft(environmentId, {
      ...target,
      expectedDraftRevision: 0,
      value: { first: true },
    });
    service.saveDraft(environmentId, {
      ...target,
      expectedDraftRevision: 1,
      value: { second: true },
    });
    await service.submit(environmentId, {
      interactionId: request.interactionId,
      expectedRevision: 1,
      expectedDraftRevision: 1,
      actionId: "agree",
      idempotencyKey: "agree",
      result: {},
    });
    expect(service.get(environmentId, request.interactionId).draft).toMatchObject({
      revision: 2,
      value: { second: true },
    });
  });

  test("late enqueue failures cannot restore receipts deleted with the environment", async () => {
    const { service, storage, queue } = await setup();
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<"queued">();
    queue.delivery.enqueue = () => {
      entered.resolve();
      return blocked.promise;
    };
    const pending = service.compose(environmentId, voice);
    await entered.promise;
    service.environmentDeleted(environmentId);
    blocked.reject(new Error("environment is being deleted"));
    await pending.catch(() => undefined);
    expect(storage.richInteractionStore().read((tx) => tx.listReceipts(environmentId))).toEqual([]);
  });

  test("pending receipts progress past stalled queued receipts and removals settle", async () => {
    const { service, storage, queue } = await setup();
    const sent = await service.compose(environmentId, voice);
    const store = storage.richInteractionStore();
    store.atomic((tx) => {
      const receipt = tx.getReceipt(sent.receipt.receiptId)!;
      for (let index = 0; index < 200; index++)
        tx.putReceipt({ ...receipt, receiptId: `a-${index}`, dispatchRequestId: `a-${index}` });
      tx.putReceipt({
        ...receipt,
        receiptId: "z-pending",
        dispatchRequestId: "z-pending",
        delivery: "pending",
      });
    });
    queue.delivery.removed = async (_key, id) => id === sent.receipt.receiptId;
    await service.sweep();
    expect(queue.queued.has("z-pending")).toBe(true);
    await service.sweep();
    expect(store.read((tx) => tx.getReceipt(sent.receipt.receiptId)?.delivery)).toBe("failed");
  });

  test("acceptance requires a published revision and deliverable capacity has a stable code", async () => {
    const { service, storage } = await setup();
    const spec = structuredClone(RICH_KIND_FIXTURES["result-review"].spec) as {
      comparisons: { after?: { revision: number } }[];
    };
    const after = spec.comparisons.find((comparison) => comparison.after)!.after!;
    after.revision += 1;
    const { request } = await present(service, "result-review", "missing", { spec });
    expect(
      (
        await rejection(() =>
          service.submit(environmentId, {
            interactionId: request.interactionId,
            expectedRevision: 1,
            actionId: "accept",
            idempotencyKey: "a",
            result: { expectedResultRevision: 5, decision: "accept" },
          }),
        )
      ).code,
    ).toBe("unavailable");
    expect(service.get(environmentId, request.interactionId).receipts).toHaveLength(0);
    const logicalSessionKey = request.owner.logicalSessionKey;
    storage.richInteractionStore().atomic((tx) => {
      for (let index = 0; index < 500; index++)
        tx.putDeliverable({
          deliverableId: `dl-${index}`,
          environmentId,
          logicalSessionKey,
          artifactId: `art-${index}`,
          pinned: false,
          revision: 1,
          updatedAt: request.updatedAt,
        });
    });
    expect(
      (
        await rejection(() =>
          service.updateDeliverable(environmentId, {
            logicalSessionKey,
            artifactId: "extra",
            expectedRevision: 0,
            patch: { pinned: true },
          }),
        )
      ).code,
    ).toBe("capacity");
  });
});
