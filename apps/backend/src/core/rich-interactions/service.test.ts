import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRichInteractionPrompt } from "@orkestrator/protocol/rich-interactions";
import { RICH_KIND_FIXTURES } from "@orkestrator/protocol/testing/rich-interaction-fixtures";
import { StorageService } from "../storage.js";
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
    store: () => storage.richInteractionStore(),
    delivery: queue.delivery,
    commands,
    ...(options.now ? { now: options.now } : {}),
  });
  return { storage, service, queue };
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
    const [[requestId, queued]] = [...queue.queued.entries()];
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
      result: { nodeId: "validation", attemptId: "attempt-3", snapshotRevision: 4 },
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
