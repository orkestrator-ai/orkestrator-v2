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
