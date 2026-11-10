import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  listSessionBranches,
  MAX_BRANCH_PROMPT_CHARS,
  MAX_LISTED_BRANCHES,
} from "./session-branches.js";

function prompt(manager: SessionManager, text: string): string {
  return manager.appendMessage({ role: "user", content: text, timestamp: 0 });
}

function respond(manager: SessionManager, text: string): string {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "model",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as never);
}

/** Three exchanges on one branch; returns the entry ids in order. */
function threeTurns(manager: SessionManager): string[] {
  const ids: string[] = [];
  for (const text of ["first", "second", "third"]) {
    ids.push(prompt(manager, text), respond(manager, `reply ${text}`));
  }
  return ids;
}

describe("listSessionBranches", () => {
  test("a session with one branch lists nothing to switch to", () => {
    const manager = SessionManager.inMemory("/workspace");
    const ids = threeTurns(manager);
    expect(listSessionBranches(manager)).toEqual({
      activeEntryId: ids[5]!,
      branches: [],
      truncated: false,
    });
  });

  test("a rewind leaves the abandoned turns listed by their leaf entry id", () => {
    const manager = SessionManager.inMemory("/workspace");
    const ids = threeTurns(manager);
    // Rewind to before "second": the leaf moves to the first reply.
    manager.branch(ids[1]!);
    const listed = listSessionBranches(manager);
    expect(listed.activeEntryId).toBe(ids[1]!);
    expect(listed.branches).toEqual([
      { entryId: ids[5]!, prompt: "second", entries: 6, updatedAt: expect.any(String) },
    ]);
  });

  test("after new turns on the kept branch, the old branch stays reachable", () => {
    const manager = SessionManager.inMemory("/workspace");
    const ids = threeTurns(manager);
    manager.branch(ids[1]!);
    prompt(manager, "second, again");
    const newLeaf = respond(manager, "another reply");
    const listed = listSessionBranches(manager);
    expect(listed.activeEntryId).toBe(newLeaf);
    expect(listed.branches.map((branch) => [branch.entryId, branch.prompt])).toEqual([
      [ids[5]!, "second"],
    ]);
    // Switching back lists the branch just left instead.
    manager.branch(ids[5]!);
    expect(listSessionBranches(manager).branches.map((branch) => branch.prompt)).toEqual([
      "second, again",
    ]);
  });

  test("a branch that diverges after a response is described by its newest prompt", () => {
    const manager = SessionManager.inMemory("/workspace");
    const ids = threeTurns(manager);
    manager.branch(ids[3]!);
    const alternative = respond(manager, "a different second reply");
    manager.branch(ids[5]!);
    const listed = listSessionBranches(manager);
    expect(listed.branches).toEqual([
      { entryId: alternative, prompt: "second", entries: 5, updatedAt: expect.any(String) },
    ]);
  });

  test("a branch holding only bookkeeping entries is not offered", () => {
    const manager = SessionManager.inMemory("/workspace");
    const ids = threeTurns(manager);
    manager.branch(ids[1]!);
    manager.appendThinkingLevelChange("high");
    manager.branch(ids[5]!);
    expect(listSessionBranches(manager).branches).toEqual([]);
  });

  test("a rewind before the first prompt lists the whole conversation", () => {
    const manager = SessionManager.inMemory("/workspace");
    const ids = threeTurns(manager);
    manager.resetLeaf();
    const listed = listSessionBranches(manager);
    expect(listed.activeEntryId).toBeNull();
    expect(listed.branches.map((branch) => [branch.entryId, branch.prompt])).toEqual([
      [ids[5]!, "first"],
    ]);
  });

  test("prompts are collapsed and bounded, and the list is capped", () => {
    const manager = SessionManager.inMemory("/workspace");
    const root = prompt(manager, "root");
    const rootReply = respond(manager, "root reply");
    const long = `${"word ".repeat(200)}\n\nend`;
    for (let index = 0; index <= MAX_LISTED_BRANCHES; index += 1) {
      manager.branch(rootReply);
      prompt(manager, index === MAX_LISTED_BRANCHES ? long : `try ${index}`);
    }
    manager.branch(root);
    const listed = listSessionBranches(manager);
    expect(listed.truncated).toBe(true);
    expect(listed.branches).toHaveLength(MAX_LISTED_BRANCHES);
    // Newest first: the long prompt was appended last.
    const newest = listed.branches[0]!.prompt;
    expect(newest.length).toBe(MAX_BRANCH_PROMPT_CHARS);
    expect(newest.endsWith("…")).toBe(true);
    expect(newest).not.toContain("\n");
  });
});
