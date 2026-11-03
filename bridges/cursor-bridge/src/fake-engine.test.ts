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
