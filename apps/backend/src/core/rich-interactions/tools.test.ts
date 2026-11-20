import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RICH_KIND_FIXTURES } from "@orkestrator/protocol/testing/rich-interaction-fixtures";
import { StorageService } from "../storage.js";
import { ProductCommandRegistry } from "./product-commands.js";
import { RichInteractionService } from "./service.js";
import { registerRichInteractionTools } from "./tools.js";

type Handler = (
  args: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{ structuredContent: Record<string, unknown>; isError?: boolean }>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tools(tabId = "tab-1") {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-rich-tools-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  cleanups.push(async () => {
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const service = new RichInteractionService({
    store: () => storage.richInteractionStore(),
    commands: new ProductCommandRegistry(),
    delivery: {
      resolveAgent: async () => "codex",
      enqueue: async () => "queued",
      notify: () => undefined,
      dispatched: async () => false,
    },
  });
  const register = (scopeTab: string) => {
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _definition: unknown, handler: Handler) =>
        handlers.set(name, handler),
    };
    registerRichInteractionTools(server as never, service, {
      environmentId: "env-1",
      tabId: scopeTab,
    });
    return handlers;
  };
  return { service, handlers: register(tabId), register };
}

describe("rich interaction agent tools", () => {
  test("registers the four tools", async () => {
    const { handlers } = await tools();
    expect([...handlers.keys()].sort()).toEqual([
      "list_interactions",
      "present_interaction",
      "read_interaction_result",
      "update_interaction",
    ]);
  });

  test("present, read and list in the caller's conversation; errors carry a path", async () => {
    const { handlers, register } = await tools();
    const created = await handlers.get("present_interaction")!(
      { requestKey: "k", kind: "choice", title: "Layout", spec: RICH_KIND_FIXTURES.choice.spec },
      { mcpReq: { _meta: { "claudecode/toolUseId": "toolu_9" } } },
    );
    expect(created.structuredContent).toMatchObject({
      ok: true,
      created: true,
      revision: 1,
      state: "open",
    });
    const interactionId = created.structuredContent.interactionId as string;
    const read = await handlers.get("read_interaction_result")!({ interactionId });
    expect(read.structuredContent).toMatchObject({
      ok: true,
      interaction: { interactionId, kind: "choice", receipts: [] },
    });
    const listed = await handlers.get("list_interactions")!({});
    expect((listed.structuredContent.interactions as unknown[]).length).toBe(1);
    // Another tab of the same environment cannot see it.
    const other = register("tab-2");
    const foreign = await other.get("read_interaction_result")!({ interactionId });
    expect(foreign).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not-found" } },
    });
    const invalid = await handlers.get("present_interaction")!({
      requestKey: "k2",
      kind: "choice",
      title: "x",
      spec: { questions: [{ id: "q", prompt: "p", options: [] }] },
    });
    expect(invalid).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invalid", path: "$.spec.questions[0].options" } },
    });
  });

  test("update publishes a revision and can close", async () => {
    const { handlers } = await tools();
    const created = await handlers.get("present_interaction")!({
      requestKey: "k",
      kind: "plan",
      title: "Plan",
      spec: RICH_KIND_FIXTURES.plan.spec,
    });
    const interactionId = created.structuredContent.interactionId as string;
    const updated = await handlers.get("update_interaction")!({
      interactionId,
      expectedRevision: 1,
      spec: RICH_KIND_FIXTURES.plan.spec,
      close: true,
    });
    expect(updated.structuredContent).toMatchObject({ ok: true, revision: 2, state: "closed" });
    const stale = await handlers.get("update_interaction")!({
      interactionId,
      expectedRevision: 5,
      close: true,
    });
    expect(stale).toMatchObject({ isError: true });
  });
});

test("the agent tools return only reviewed user context", async () => {
  const { service, handlers } = await tools();
  const caller = { environmentId: "env-1", tabId: "tab-1" };
  for (const kind of ["context-packet", "voice-request", "demonstration"] as const) {
    const fixture = RICH_KIND_FIXTURES[kind];
    const spec = structuredClone(fixture.spec) as Record<string, unknown>;
    let result = fixture.result;
    if (kind === "context-packet") {
      const items = spec.items as Record<string, unknown>[];
      items.push({
        ...items[0],
        itemId: "private-item",
        included: false,
        label: "withheld-marker",
        excerpt: "withheld-marker",
        source: { kind: "file", path: "private.ts", live: true },
      });
    } else if (kind === "voice-request") {
      spec.recognized = "withheld-marker";
    } else {
      const steps = spec.steps as Record<string, unknown>[];
      steps[2]!.userObservation = "withheld-marker";
      steps[2]!.route = "/withheld-marker";
      result = { stepIds: ["step-1"], expectedOutcome: "The menu remains visible" };
    }
    const composed = await service.compose(caller.environmentId, {
      tabId: caller.tabId,
      kind,
      title: fixture.title,
      spec,
      actionId: fixture.actionId,
      idempotencyKey: kind,
      result,
    });
    expect(
      JSON.stringify(
        service.get(caller.environmentId, composed.request.interactionId).request.spec,
      ),
    ).toContain("withheld-marker");
    const read = await handlers.get("read_interaction_result")!({
      interactionId: composed.request.interactionId,
    });
    const listed = await handlers.get("list_interactions")!({});
    expect(read.structuredContent.ok).toBe(true);
    expect(JSON.stringify(read)).not.toContain("withheld-marker");
    expect(JSON.stringify(listed)).not.toContain("withheld-marker");
    if (kind === "voice-request")
      expect(JSON.stringify(read)).toContain("Explain why this changed");
    if (kind === "demonstration") expect(JSON.stringify(read)).toContain("step-1");
  }
});
