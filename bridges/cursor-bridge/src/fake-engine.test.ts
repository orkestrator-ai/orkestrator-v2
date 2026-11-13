import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCursorAgentApi } from "./testing/fake-engine.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

test("live and persisted Cursor runs replay the exact framed SDK input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-fake-history-"));
  directories.push(directory);
  const storePath = join(directory, "vendor.json");
  const api = createFakeCursorAgentApi({ storePath });
  const agent = await api.create({ name: "Orkestrator" });
  const prompt = "Keep this conversation";
  // Deliberately literal: this verifies the fake's boundary, independently of
  // the production helpers that construct and strip instruction frames.
  const sent = `${prompt}\n\n<orkestrator-system-instructions>\nProvider-only guidance\n</orkestrator-system-instructions>`;
  const run = await agent.send({ text: sent });
  await expect(run.wait()).resolves.toMatchObject({
    status: "finished",
    result: `Answer to: ${prompt}`,
  });
  const conversation = [
    {
      type: "conversationTurn",
      turn: {
        userMessage: { text: sent },
        steps: [{ type: "assistantMessage", message: { text: `Answer to: ${prompt}` } }],
      },
    },
  ];
  // Covers conversationOf on the handle returned by send, before any reload.
  await expect(run.conversation()).resolves.toEqual(conversation);
  expect(JSON.parse(readFileSync(storePath, "utf8")).agents[agent.agentId].turns[0]).toMatchObject({
    prompt,
    sent,
  });
  expect((await api.list()).items[0]?.summary).toBe(prompt);
  await agent[Symbol.asyncDispose]();

  // A fresh SDK instance must load the vendor's saved text, including the
  // frame; pre-stripping here would mask the bridge's history stripping.
  const restarted = createFakeCursorAgentApi({ storePath });
  const resumed = await restarted.resume(agent.agentId);
  expect(resumed.agentId).toBe(agent.agentId);
  const runs = await restarted.listRuns(resumed.agentId);
  expect(runs.items).toHaveLength(1);
  expect(runs.items[0]?.id).toBe(run.id);
  await expect(runs.items[0]!.conversation()).resolves.toEqual(conversation);
  await resumed[Symbol.asyncDispose]();
});

test("a FETCH prompt answers with what the bridge process could reach", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-fake-fetch-"));
  directories.push(directory);
  const storePath = join(directory, "vendor.json");
  const api = createFakeCursorAgentApi({ storePath });
  const agent = await api.create({ name: "Orkestrator" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const reachable = `http://127.0.0.1:${server.port}/probe`;
  const deltas: unknown[] = [];
  try {
    const run = await agent.send(
      { text: `Check the network\nFETCH ${reachable}` },
      { onDelta: ({ update }) => deltas.push(update) },
    );
    expect(run.status).toBe("running");
    await expect(run.wait()).resolves.toMatchObject({
      status: "finished",
      result: `Fetch ${reachable}: HTTP 200`,
    });
    expect(deltas).toEqual([{ type: "text-delta", text: `Fetch ${reachable}: HTTP 200` }]);
  } finally {
    await server.stop(true);
  }
  // Nothing listens once the server has stopped: the refusal is reported, not thrown.
  const refused = await agent.send({ text: `FETCH ${reachable}` });
  const result = await refused.wait();
  expect(result.status).toBe("finished");
  expect(result.result).toMatch(
    new RegExp(`^Fetch ${reachable.replaceAll(".", "\\.")}: failed \\(.+\\)$`),
  );
  await agent[Symbol.asyncDispose]();
});

test("create records the bridge's options without the key or server definitions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-fake-options-"));
  directories.push(directory);
  const storePath = join(directory, "vendor.json");
  const api = createFakeCursorAgentApi({ storePath });
  const agent = await api.create({
    name: "Orkestrator",
    apiKey: "never-stored",
    mode: "agent",
    local: { cwd: "/workspace", settingSources: ["user"], sandboxOptions: { enabled: false } },
    mcpServers: { orkestrator: { url: "http://host/mcp", headers: { authorization: "Bearer x" } } },
  } as Parameters<typeof api.create>[0]);
  const raw = readFileSync(storePath, "utf8");
  expect(raw).not.toContain("never-stored");
  expect(raw).not.toContain("Bearer");
  expect(JSON.parse(raw).agents[agent.agentId].options).toEqual({
    mode: "agent",
    cwd: "/workspace",
    settingSources: ["user"],
    sandboxOptions: { enabled: false },
    mcpServerNames: ["orkestrator"],
  });
  await agent[Symbol.asyncDispose]();
});

test("cancelling a pending FETCH keeps live and resumed history cancelled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-fake-cancel-"));
  directories.push(directory);
  const storePath = join(directory, "vendor.json");
  const api = createFakeCursorAgentApi({ storePath });
  const agent = await api.create({ name: "Orkestrator" });
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();
  const served = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      started.resolve();
      await response.promise;
      served.resolve();
      return new Response("late reply");
    },
  });
  const deltas: unknown[] = [];
  try {
    const run = await agent.send(
      { text: `FETCH http://127.0.0.1:${server.port}/delayed` },
      { onDelta: ({ update }) => deltas.push(update) },
    );
    await started.promise;
    const waiting = run.wait();
    await run.cancel();
    await expect(waiting).resolves.toMatchObject({ status: "cancelled", result: undefined });
    response.resolve();
    await served.promise;
    // Let the response/abort callbacks run before inspecting the persisted truth.
    await Bun.sleep(30);
    await run.cancel(); // Repeated cancellation cannot create a new transition.
    expect(deltas).toEqual([]);
    await expect(run.wait()).resolves.toMatchObject({ status: "cancelled", result: undefined });
    const restarted = createFakeCursorAgentApi({ storePath });
    const [stored] = (await restarted.listRuns(agent.agentId)).items;
    expect(stored?.status).toBe("cancelled");
    await expect(stored!.wait()).resolves.toMatchObject({ status: "cancelled", result: undefined });
    await expect(stored!.conversation()).resolves.toMatchObject([{ turn: { steps: [] } }]);
  } finally {
    response.resolve();
    await server.stop(true);
    await agent[Symbol.asyncDispose]();
  }
});

test("a held run keeps every steer it accepted, in order, without the frame", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-fake-steer-"));
  directories.push(directory);
  const storePath = join(directory, "vendor.json");
  const api = createFakeCursorAgentApi({ storePath });
  const agent = await api.create({ name: "Orkestrator" });
  const run = await agent.send({ text: "HOLD until steered" });
  expect(run.status).toBe("running");
  await expect(run.steer("turn left")).resolves.toBe("complete_delivered");
  await expect(
    run.steer(
      "turn right\n\n<orkestrator-system-instructions>\nProvider-only guidance\n</orkestrator-system-instructions>",
    ),
  ).resolves.toBe("complete_delivered");
  const stored = () =>
    JSON.parse(readFileSync(storePath, "utf8")).agents[agent.agentId].turns[0] as {
      status: string;
      steers?: string[];
    };
  expect(stored()).toMatchObject({ status: "running", steers: ["turn left", "turn right"] });
  await run.cancel();
  // Settling the run keeps what it was steered with.
  expect(stored()).toMatchObject({ status: "cancelled", steers: ["turn left", "turn right"] });
  await agent[Symbol.asyncDispose]();
});
