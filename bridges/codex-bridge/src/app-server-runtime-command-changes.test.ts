import { describe, expect, test } from "bun:test";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { BeginOptions } from "@orkestrator/protocol/workspace-change-probe";
import { readCommandChanges, type CommandChangeProbe } from "./sessions/command-changes.js";
import type { NormalizedPart } from "./messages/types.js";

import {
  codexHome,
  deferredSignal,
  harness,
  waitUntil,
  type Harness,
} from "./app-server-runtime-test-harness.js";

const change: MeasuredWorkspaceChange = {
  additions: 4,
  deletions: 2,
  files: [{ path: "src/a.ts", additions: 4, deletions: 2 }],
};

/** Records what the runtime asks of the probe; `end` answers from `results`. */
class FakeProbe implements CommandChangeProbe {
  readonly calls: string[] = [];
  readonly results = new Map<string, MeasuredWorkspaceChange>();
  readonly gates = new Map<string, Promise<void>>();

  async begin(cwd: string, callId: string, options?: BeginOptions): Promise<void> {
    this.calls.push(`begin ${callId} ${cwd}${options?.baseline ? " baseline" : ""}`);
  }

  async note(cwd: string, callId: string): Promise<void> {
    this.calls.push(`note ${callId} ${cwd}`);
  }

  async end(callId: string): Promise<MeasuredWorkspaceChange | undefined> {
    this.calls.push(`end ${callId}`);
    await this.gates.get(callId);
    return this.results.get(callId);
  }

  discard(callId: string): void {
    this.calls.push(`discard ${callId}`);
  }

  async prime(cwd: string): Promise<void> {
    this.calls.push(`prime ${cwd}`);
  }
}

async function startTurn(probe: FakeProbe): Promise<{ h: Harness; sessionId: string }> {
  const h = await harness({}, { commandChangeProbe: probe });
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  await h.runtime.prompt(sessionId, { prompt: "run", requestId: "req-1", attachments: [] });
  return { h, sessionId };
}

function notifyCommand(
  h: Harness,
  method: "item/started" | "item/completed",
  item: Record<string, unknown>,
): void {
  h.child().notify(method, {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      type: "commandExecution",
      command: "bunx prettier --write src",
      aggregatedOutput: null,
      status: method === "item/started" ? "inProgress" : "completed",
      ...(method === "item/completed" ? { exitCode: 0 } : {}),
      ...item,
    },
  });
}

async function bashPart(h: Harness, sessionId: string, id: string): Promise<NormalizedPart> {
  const messages = (await h.runtime.getMessages(sessionId))!;
  return messages.flatMap((message) => message.parts).find((part) => part.toolUseId === id)!;
}

function patchedParts(h: Harness, from = 0): NormalizedPart[] {
  return h.events
    .slice(from)
    .filter((event) => event.type === "message.patched")
    .flatMap((event) => (event.data as { changedParts: { part: NormalizedPart }[] }).changedParts)
    .map(({ part }) => part);
}

describe("shell command line changes", () => {
  test("primes before dispatch and puts a live measurement on the command's row", async () => {
    const probe = new FakeProbe();
    const { h, sessionId } = await startTurn(probe);
    expect(probe.calls).toEqual(["prime /tmp/ws"]);

    notifyCommand(h, "item/started", {
      id: "c1",
      cwd: "/tmp/ws/pkg",
      source: "unifiedExecStartup",
    });
    await h.drain();
    expect(probe.calls).toContain("begin c1 /tmp/ws/pkg baseline");

    probe.results.set("c1", change);
    const before = h.events.length;
    notifyCommand(h, "item/completed", {
      id: "c1",
      cwd: "/tmp/ws/pkg",
      source: "unifiedExecStartup",
    });
    await h.drain();

    expect(probe.calls).toContain("end c1");
    // The completed row was published — and cached — before the measurement
    // landed; the measurement still has to reach it.
    expect((await bashPart(h, sessionId, "c1")).commandChanges).toEqual(change);
    expect(patchedParts(h, before).some((part) => part.commandChanges)).toBe(true);
    expect(await readCommandChanges(codexHome, "thread-1")).toEqual(new Map([["c1", change]]));
  });

  test("a measurement that lands after the turn settled patches the stored row", async () => {
    const probe = new FakeProbe();
    const { h, sessionId } = await startTurn(probe);
    const gate = deferredSignal();
    probe.gates.set("c1", gate.promise);
    probe.results.set("c1", change);

    notifyCommand(h, "item/started", { id: "c1" });
    notifyCommand(h, "item/completed", { id: "c1" });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await waitUntil(() => h.runtime.getStatus(sessionId)?.phase === "idle", "turn did not settle");
    const assistant = (await h.runtime.getMessages(sessionId))![1]!;
    const revision = assistant.revision!;
    expect((await bashPart(h, sessionId, "c1")).commandChanges).toBeUndefined();

    const before = h.events.length;
    gate.resolve();
    await h.drain();

    expect((await bashPart(h, sessionId, "c1")).commandChanges).toEqual(change);
    const patch = h.events.slice(before).find((event) => event.type === "message.patched")?.data as
      | { messageId: string; revision: number; changedParts: { part: NormalizedPart }[] }
      | undefined;
    expect(patch?.messageId).toBe(assistant.id);
    expect(patch?.revision).toBe(revision + 1);
    expect(patch?.changedParts.map(({ part }) => part.commandChanges)).toEqual([change]);
  });

  test("a measurement racing its turn's finalization is published once, in order", async () => {
    const probe = new FakeProbe();
    const { h, sessionId } = await startTurn(probe);
    const gate = deferredSignal();
    probe.gates.set("c1", gate.promise);
    probe.results.set("c1", change);

    notifyCommand(h, "item/started", { id: "c1" });
    notifyCommand(h, "item/completed", { id: "c1" });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    // The turn is terminal and its finalization under way, not finished.
    await h.engine.getSupervisor().notificationQueue.drainAll();
    gate.resolve();
    await h.drain();

    const assistant = (await h.runtime.getMessages(sessionId))![1]!;
    expect((await bashPart(h, sessionId, "c1")).commandChanges).toEqual(change);
    expect(h.events.some((event) => event.type === "session.reconcile-required")).toBe(false);
    const revisions = h.events
      .filter(
        (event) =>
          event.type === "message.patched" &&
          (event.data as { messageId: string }).messageId === assistant.id,
      )
      .map((event) => (event.data as { revision: number }).revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(revisions.at(-1)).toBe(assistant.revision);
  });

  test("measures only the agent's commands and notes patches", async () => {
    const probe = new FakeProbe();
    const { h } = await startTurn(probe);

    notifyCommand(h, "item/started", { id: "user", source: "userShell" });
    notifyCommand(h, "item/completed", { id: "user", source: "userShell" });
    notifyCommand(h, "item/started", { id: "stdin", source: "unifiedExecInteraction" });
    notifyCommand(h, "item/completed", { id: "stdin", source: "unifiedExecInteraction" });
    for (const method of ["item/started", "item/completed"] as const) {
      h.child().notify(method, {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "patch",
          type: "fileChange",
          changes: [{ path: "a.ts", kind: { type: "update" } }],
          status: method === "item/started" ? "inProgress" : "completed",
        },
      });
    }
    // A declined command never ran: its window is dropped, not measured.
    notifyCommand(h, "item/started", { id: "declined" });
    notifyCommand(h, "item/completed", { id: "declined", status: "declined", exitCode: null });
    await h.drain();

    expect(probe.calls.slice(1)).toEqual([
      "note patch /tmp/ws",
      "end patch",
      "begin declined /tmp/ws baseline",
      "discard declined",
    ]);
  });

  test("a command still running when its turn completes is not measured", async () => {
    const probe = new FakeProbe();
    const { h } = await startTurn(probe);

    notifyCommand(h, "item/started", { id: "server" });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(probe.calls).toContain("discard server");
    expect(probe.calls).not.toContain("end server");
  });
});
