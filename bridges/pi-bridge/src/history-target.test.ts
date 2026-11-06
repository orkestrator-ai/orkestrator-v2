import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  captureHistoryEntries,
  lastUserTarget,
  rememberHistoryLeaf,
  resolveHistoryTarget,
  restoreHistoryLeaf,
} from "./history-target.js";
import { newSessionState } from "./session-factory.js";
import { detachSession } from "./agent-session.js";
import type { SessionState } from "./state.js";
import { applySessionEvent } from "./translate.js";

/**
 * A live Pi conversation, built the way the bridge sees one: the bridge mints
 * the row ids, the translator renders Pi's events, and Pi appends each message
 * to its real `SessionManager` only after its listeners saw `message_end`.
 */
class LiveConversation {
  constructor(readonly manager = SessionManager.inMemory("/workspace")) {}
  readonly state: SessionState = newSessionState();
  get session(): AgentSession {
    return { sessionManager: this.manager } as unknown as AgentSession;
  }
  /** Entry id by marker, for the assertions. */
  readonly entries = new Map<string, string>();
  /** Row id by marker. */
  readonly rows = new Map<string, string>();

  prompt(marker: string): void {
    // The prompt row is the bridge's own, with an id Pi never sees.
    const id = randomBytes(12).toString("hex");
    this.state.messages.push({
      id,
      role: "user",
      content: marker,
      parts: [],
      createdAt: new Date().toISOString(),
    });
    this.rows.set(marker, id);
    this.state.status = "running";
    const message = { role: "user", content: marker, timestamp: Date.now() };
    this.state.pendingHistoryPromptId = id;
    applySessionEvent(this.state, { type: "message_start", message });
    applySessionEvent(this.state, { type: "message_end", message });
    this.entries.set(marker, this.manager.appendMessage(message as never));
    captureHistoryEntries(this.state, this.manager);
  }

  respond(marker: string, options: { toolCall?: string; toolOnly?: boolean } = {}): void {
    const message = {
      role: "assistant",
      content: [
        ...(options.toolOnly ? [] : [{ type: "text", text: `Acknowledged ${marker}.` }]),
        ...(options.toolCall
          ? [{ type: "toolCall", id: options.toolCall, name: "bash", arguments: { command: "ls" } }]
          : []),
      ],
      api: "openai-completions",
      provider: "loopback",
      model: "loop-1",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: options.toolCall ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    applySessionEvent(this.state, { type: "message_start", message });
    if (!options.toolOnly)
      applySessionEvent(this.state, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `Acknowledged ${marker}.` },
      });
    applySessionEvent(this.state, { type: "message_end", message });
    // Pi persists after its listeners, holding the very object they saw.
    this.entries.set(marker, this.manager.appendMessage(message as never));
    if (options.toolCall) {
      applySessionEvent(this.state, {
        type: "tool_execution_start",
        toolCallId: options.toolCall,
        toolName: "bash",
        args: { command: "ls" },
      });
    }
    this.rows.set(marker, this.state.messages.at(-1)!.id);
    captureHistoryEntries(this.state, this.manager);
    if (options.toolCall) {
      this.entries.set(
        `${marker}:result`,
        this.manager.appendMessage({
          role: "toolResult",
          toolCallId: options.toolCall,
          toolName: "bash",
          content: [{ type: "text", text: "README.md" }],
          isError: false,
          timestamp: Date.now(),
        }),
      );
    }
  }

  settle(): void {
    this.state.status = "idle";
  }

  resolve(marker: string) {
    return resolveHistoryTarget(this.state, this.session, this.rows.get(marker)!);
  }
}

describe("resolving a fork or rewind target", () => {
  test("a live response row resolves to the entry Pi appended for it, not the newest prompt", () => {
    // Live rows carry bridge ids. Before this, a response row resolved to
    // nothing and a fork fell back to the newest prompt: forking at the first
    // response kept turns 1 and 2 (loopback-model run, 2026-11-06).
    const live = new LiveConversation();
    for (const marker of ["HX1", "HX2", "HX3"]) {
      live.prompt(marker);
      live.respond(`${marker}:reply`);
      live.settle();
    }

    expect(live.resolve("HX1:reply")).toEqual({
      entryId: live.entries.get("HX1:reply")!,
      position: "at",
    });
    expect(live.resolve("HX3:reply")).toEqual({
      entryId: live.entries.get("HX3:reply")!,
      position: "at",
    });
  });

  test("a prompt row resolves to its own entry, cut before it", () => {
    const live = new LiveConversation();
    for (const marker of ["HX1", "HX2", "HX3"]) {
      live.prompt(marker);
      live.respond(`${marker}:reply`);
      live.settle();
    }

    expect(live.resolve("HX2")).toEqual({ entryId: live.entries.get("HX2")!, position: "before" });
    expect(lastUserTarget(live.session)).toEqual({
      entryId: live.entries.get("HX3")!,
      position: "before",
    });
  });

  test("a response that called tools is kept with its results", () => {
    const live = new LiveConversation();
    live.prompt("HX1");
    live.respond("HX1:call", { toolCall: "call-1" });
    live.respond("HX1:reply");
    live.settle();

    // Cutting at the call itself would leave a call without its result.
    expect(live.resolve("HX1:call")).toEqual({
      entryId: live.entries.get("HX1:call:result")!,
      position: "at",
    });
    expect(live.resolve("HX1:reply")).toEqual({
      entryId: live.entries.get("HX1:reply")!,
      position: "at",
    });
  });

  test("prompts are matched on the active branch, not on every branch in the file", () => {
    // Pi's `getUserMessagesForForking` lists every branch, so after a rewind
    // the transcript's second prompt was matched to the abandoned branch's.
    const live = new LiveConversation();
    for (const marker of ["HX1", "HX2", "HX3"]) {
      live.prompt(marker);
      live.respond(`${marker}:reply`);
      live.settle();
    }
    // Rewind to before HX2, as `navigateTree` does, and continue.
    live.manager.branch(live.entries.get("HX1:reply")!);
    live.state.messages = live.state.messages.slice(0, 2);
    live.prompt("HX6");
    live.respond("HX6:reply");
    live.settle();

    expect(live.resolve("HX6")).toEqual({ entryId: live.entries.get("HX6")!, position: "before" });
    expect(live.resolve("HX6:reply")).toEqual({
      entryId: live.entries.get("HX6:reply")!,
      position: "at",
    });
  });

  test("a trimmed transcript front does not shift a prompt onto an older one", () => {
    const live = new LiveConversation();
    for (const marker of ["HX1", "HX2", "HX3"]) {
      live.prompt(marker);
      live.respond(`${marker}:reply`);
      live.settle();
    }
    // The bound drops whole rows from the front.
    live.state.messages = live.state.messages.slice(2);

    expect(live.resolve("HX2")).toEqual({ entryId: live.entries.get("HX2")!, position: "before" });
  });

  test("an entry id (a replayed row, or a branch entry) resolves as itself", () => {
    const live = new LiveConversation();
    live.prompt("HX1");
    live.respond("HX1:reply");
    live.settle();

    const entry = live.entries.get("HX1:reply")!;
    expect(resolveHistoryTarget(live.state, live.session, entry)).toEqual({
      entryId: entry,
      position: "at",
    });
  });

  test("unknown response mappings are refused instead of inferring a cut from nearby rows", () => {
    const live = new LiveConversation();
    live.prompt("HX1");
    live.respond("HX1:call", { toolCall: "call-1" });
    live.respond("HX1:reply");
    live.prompt("HX2");
    live.respond("HX2:reply");
    live.settle();
    live.state.historyMessages?.clear();
    live.state.historyEntries?.clear();
    for (const marker of ["HX1:call", "HX1:reply", "HX2:reply"]) {
      expect(live.resolve(marker)).toBeUndefined();
    }
  });

  for (const local of ["/steer local", "/compact", "cancelled before send"]) {
    test(`local-only row ${local} cannot shift an earlier prompt or response`, () => {
      const live = new LiveConversation();
      live.prompt("HX1");
      live.respond("HX1:reply");
      live.prompt("HX2");
      live.respond("HX2:reply");
      live.settle();
      live.state.messages.push({
        id: "local",
        role: "user",
        content: local,
        parts: [],
        createdAt: new Date().toISOString(),
      });
      expect(live.resolve("HX2")).toEqual({ entryId: live.entries.get("HX2"), position: "before" });
      expect(live.resolve("HX2:reply")).toEqual({
        entryId: live.entries.get("HX2:reply"),
        position: "at",
      });
      expect(resolveHistoryTarget(live.state, live.session, "local")).toBeUndefined();
      live.state.historyEntries?.delete(live.rows.get("HX2:reply")!);
      expect(live.resolve("HX2:reply")).toBeUndefined();
    });
  }

  test("a tool-only response resolves after its result and before the final text response", () => {
    const live = new LiveConversation();
    live.prompt("HX1");
    live.respond("HX1:tool", { toolCall: "call-only", toolOnly: true });
    live.respond("HX1:final");
    live.settle();
    const target = live.resolve("HX1:tool");
    expect(target).toEqual({ entryId: live.entries.get("HX1:tool:result"), position: "at" });
    live.manager.branch(target!.entryId);
    expect(live.manager.getBranch().at(-1)?.id).toBe(live.entries.get("HX1:tool:result"));
  });

  test("stable response ids survive replacement with newly parsed entry objects", () => {
    const live = new LiveConversation();
    live.prompt("HX1");
    live.respond("HX1:tool", { toolCall: "call-1", toolOnly: true });
    live.respond("HX1:final");
    live.settle();
    const branch = JSON.parse(JSON.stringify(live.manager.getBranch()));
    const reopened = { sessionManager: { getBranch: () => branch } } as unknown as AgentSession;
    expect(resolveHistoryTarget(live.state, reopened, live.rows.get("HX1:tool")!)).toEqual({
      entryId: live.entries.get("HX1:tool:result"),
      position: "at",
    });
  });

  test("an id that names nothing in the session resolves to nothing", () => {
    const live = new LiveConversation();
    live.prompt("HX1");
    live.respond("HX1:reply");
    live.settle();

    expect(resolveHistoryTarget(live.state, live.session, "not-a-message")).toBeUndefined();
    expect(resolveHistoryTarget(live.state, live.session, "  ")).toBeUndefined();
  });
});

describe("the leaf a rewind chose", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-bridge-history-leaf-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** A real session file with three turns; returns it and its entry ids by marker. */
  function threeTurns() {
    const manager = SessionManager.create("/workspace", directory);
    const ids = new Map<string, string>();
    for (const marker of ["HX1", "HX2", "HX3"]) {
      ids.set(marker, manager.appendMessage({ role: "user", content: marker, timestamp: 0 }));
      ids.set(
        `${marker}:reply`,
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: `Acknowledged ${marker}.` }],
          api: "openai-completions",
          provider: "loopback",
          model: "loop-1",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        } as never),
      );
    }
    return { manager, file: manager.getSessionFile()!, ids };
  }

  test("detach captures intermediate response ids before a real JSONL reopen", async () => {
    const live = new LiveConversation(SessionManager.create("/workspace", directory));
    live.prompt("HX1");
    live.respond("HX1:tool", { toolCall: "call-1", toolOnly: true });
    live.respond("HX1:final");
    live.settle();
    // Model the interval just after message_end: only transient identities remain.
    live.state.historyEntries?.clear();
    for (const marker of ["HX1:tool", "HX1:final"]) {
      const entry = live.manager.getEntry(live.entries.get(marker)!);
      if (entry?.type === "message")
        live.state.historyMessages!.set(live.rows.get(marker)!, entry.message);
    }
    live.state.session = {
      sessionManager: live.manager,
      dispose: () => {},
    } as unknown as AgentSession;
    await detachSession(live.state);
    expect(live.state.historyMessages?.size).toBe(0);
    const manager = SessionManager.open(live.manager.getSessionFile()!, directory, "/workspace");
    const session = { sessionManager: manager } as unknown as AgentSession;
    const target = resolveHistoryTarget(live.state, session, live.rows.get("HX1:tool")!);
    expect(target).toEqual({ entryId: live.entries.get("HX1:tool:result"), position: "at" });
    manager.branch(target!.entryId);
    expect(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message.role),
    ).toEqual(["user", "assistant", "toolResult"]);
  });

  test("a reopened file returns to the rewound leaf, which Pi keeps only in memory", () => {
    // Before this, a rewind rendered from the reopened file showed all three
    // turns again, and a restarted bridge resumed Pi on the dropped turns
    // (loopback-model run, 2026-11-06).
    const { manager, file, ids } = threeTurns();
    const state = newSessionState();
    manager.branch(ids.get("HX1:reply")!);
    rememberHistoryLeaf(state, manager);

    const reopened = SessionManager.open(file, directory, "/workspace");
    expect(reopened.getLeafId()).toBe(ids.get("HX3:reply")!);
    restoreHistoryLeaf(state, reopened);
    expect(reopened.getLeafId()).toBe(ids.get("HX1:reply")!);
    expect(reopened.getBranch().length).toBe(2);
  });

  test("a rewind to before the first prompt reopens empty", () => {
    const { manager, file } = threeTurns();
    const state = newSessionState();
    manager.resetLeaf();
    rememberHistoryLeaf(state, manager);

    const reopened = SessionManager.open(file, directory, "/workspace");
    restoreHistoryLeaf(state, reopened);
    expect(reopened.getLeafId()).toBeNull();
    expect(reopened.getBranch()).toEqual([]);
  });

  test("once a prompt is appended under it, the file's own leaf is right and the record goes", () => {
    const { manager, file, ids } = threeTurns();
    const state = newSessionState();
    manager.branch(ids.get("HX1:reply")!);
    rememberHistoryLeaf(state, manager);
    const next = manager.appendMessage({ role: "user", content: "HX6", timestamp: 0 });

    const reopened = SessionManager.open(file, directory, "/workspace");
    restoreHistoryLeaf(state, reopened);
    expect(reopened.getLeafId()).toBe(next);
    expect(state.historyLeaf).toBeUndefined();
  });
});
