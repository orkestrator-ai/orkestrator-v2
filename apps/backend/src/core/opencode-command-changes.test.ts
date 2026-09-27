import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { WorkspaceChangeProbe } from "@orkestrator/protocol/workspace-change-probe";
import { openCodeFake, waitUntil } from "./agent-provider-test-support.js";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import {
  OpenCodeCommandChanges,
  openCodeCommandChangeJournalDirectory,
  removeOpenCodeCommandChangeJournals,
  type CommandChangeProbe,
} from "./opencode-command-changes.js";

const CHANGE: MeasuredWorkspaceChange = {
  additions: 3,
  deletions: 1,
  files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
};

type ProbeCall = [method: string, ...args: unknown[]];

function fakeProbe(result: MeasuredWorkspaceChange | undefined = CHANGE) {
  const calls: ProbeCall[] = [];
  const probe: CommandChangeProbe = {
    begin: async (cwd, id, options) => {
      calls.push(["begin", cwd, id, options]);
    },
    note: async (cwd, id) => {
      calls.push(["note", cwd, id]);
    },
    end: async (id) => {
      calls.push(["end", id]);
      return result;
    },
    discard: (id) => {
      calls.push(["discard", id]);
    },
    prime: async (cwd) => {
      calls.push(["prime", cwd]);
    },
  };
  return { probe, calls };
}

function toolEvent(tool: string, status: string, callID = "call-1", sessionID = "session-1") {
  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        id: `part-${callID}`,
        sessionID,
        messageID: "assistant-1",
        type: "tool",
        callID,
        tool,
        state: { status, input: { command: "sed -i s/a/b/ a.ts" } },
      },
    },
  };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opencode-command-changes-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("OpenCodeCommandChanges", () => {
  test("measures a bash call from its first running update to its completion", async () => {
    const { probe, calls } = fakeProbe();
    const measured: string[] = [];
    const tracker = new OpenCodeCommandChanges("/repo", { probe }, (id) => measured.push(id));

    tracker.observe(toolEvent("bash", "pending"));
    tracker.observe(toolEvent("bash", "running"));
    tracker.observe(toolEvent("bash", "completed"));
    // A later update of the finished part does not end it twice.
    tracker.observe(toolEvent("bash", "completed"));
    await waitUntil(() => measured.length === 1);

    expect(calls).toEqual([
      ["begin", "/repo", "opencode:session-1:call-1", { baseline: true }],
      ["end", "opencode:session-1:call-1"],
    ]);
    expect(measured).toEqual(["session-1"]);
    expect((await tracker.changes("session-1")).get("call-1")).toEqual(CHANGE);
  });

  test("notes edit tools without recording a measurement, and ignores other tools", async () => {
    const { probe, calls } = fakeProbe();
    const measured: string[] = [];
    const tracker = new OpenCodeCommandChanges("/repo", { probe }, (id) => measured.push(id));

    tracker.observe(toolEvent("edit", "running", "edit-1"));
    tracker.observe(toolEvent("read", "running", "read-1"));
    tracker.observe(toolEvent("edit", "completed", "edit-1"));
    tracker.observe(toolEvent("read", "completed", "read-1"));
    await waitUntil(() => calls.length === 2);
    await Promise.resolve();

    expect(calls).toEqual([
      ["note", "/repo", "opencode:session-1:edit-1"],
      ["end", "opencode:session-1:edit-1"],
    ]);
    expect(measured).toEqual([]);
    expect((await tracker.changes("session-1")).size).toBe(0);
  });

  test("does not record a measurement with nothing changed", async () => {
    const { probe } = fakeProbe({ additions: 0, deletions: 0, files: [] });
    const measured: string[] = [];
    const tracker = new OpenCodeCommandChanges("/repo", { probe }, (id) => measured.push(id));

    tracker.observe(toolEvent("bash", "running"));
    tracker.observe(toolEvent("bash", "completed"));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(measured).toEqual([]);
    expect((await tracker.changes("session-1")).size).toBe(0);
  });

  test("ignores a completion whose start was never seen", async () => {
    const { probe, calls } = fakeProbe();
    const tracker = new OpenCodeCommandChanges("/repo", { probe }, () => undefined);

    tracker.observe(toolEvent("bash", "completed"));

    expect(calls).toEqual([]);
  });

  test("primes on dispatch and once per busy turn", () => {
    const { probe, calls } = fakeProbe();
    const tracker = new OpenCodeCommandChanges("/repo", { probe }, () => undefined);
    const status = (type: string) => ({
      type: "session.status",
      properties: { sessionID: "session-1", status: { type } },
    });

    tracker.beginTurn("session-1");
    tracker.observe(status("busy"));
    tracker.observe(status("busy"));
    tracker.observe(status("idle"));
    // A turn another client started still gets its baseline.
    tracker.observe(status("busy"));
    // Dispatch always primes: an idle event may have been lost in a gap.
    tracker.beginTurn("session-1");

    expect(calls.filter(([method]) => method === "prime")).toHaveLength(3);
  });

  test("waits for the first baseline before a dispatch can continue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { probe } = fakeProbe();
    probe.prime = async () => gate;
    const tracker = new OpenCodeCommandChanges("/repo", { probe }, () => undefined);
    let ready = false;
    const priming = tracker.beginTurn("session-1").then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    release();
    await priming;
    expect(ready).toBe(true);
  });

  test("journals measurements so a new backend process overlays them", async () => {
    const journalDirectory = openCodeCommandChangeJournalDirectory(dataDir, "env-1");
    const { probe } = fakeProbe();
    const measured: string[] = [];
    const first = new OpenCodeCommandChanges("/repo", { probe, journalDirectory }, (id) =>
      measured.push(id),
    );
    first.observe(toolEvent("bash", "running"));
    first.observe(toolEvent("bash", "completed"));
    await waitUntil(() => measured.length === 1);

    const restarted = new OpenCodeCommandChanges(
      "/repo",
      { probe: fakeProbe().probe, journalDirectory },
      () => undefined,
    );
    await waitUntil(() => existsSync(join(journalDirectory, "session-1.jsonl")));
    expect((await restarted.changes("session-1")).get("call-1")).toEqual(CHANGE);

    // Releasing a tab keeps the journal for a resume; deleting the session does not.
    restarted.forget("session-1");
    expect((await restarted.changes("session-1")).get("call-1")).toEqual(CHANGE);
    restarted.observe({ type: "session.deleted", properties: { sessionID: "session-1" } });
    await waitUntil(() => !existsSync(join(journalDirectory, "session-1.jsonl")));
  });

  test("environment deletion removes that environment's journals only", async () => {
    const kept = openCodeCommandChangeJournalDirectory(dataDir, "env-kept");
    const doomed = openCodeCommandChangeJournalDirectory(dataDir, "env-doomed");
    for (const journalDirectory of [kept, doomed]) {
      const measured: string[] = [];
      const tracker = new OpenCodeCommandChanges(
        "/repo",
        { probe: fakeProbe().probe, journalDirectory },
        (id) => measured.push(id),
      );
      tracker.observe(toolEvent("bash", "running"));
      tracker.observe(toolEvent("bash", "completed"));
      await waitUntil(() => measured.length === 1);
      await waitUntil(() => existsSync(join(journalDirectory, "session-1.jsonl")));
    }

    await removeOpenCodeCommandChangeJournals(dataDir, "env-doomed");

    expect(existsSync(doomed)).toBe(false);
    expect(existsSync(join(kept, "session-1.jsonl"))).toBe(true);
  });

  test("environment deletion drains an append already queued for that journal", async () => {
    const doomed = openCodeCommandChangeJournalDirectory(dataDir, "env-pending");
    const measured: string[] = [];
    const tracker = new OpenCodeCommandChanges(
      "/repo",
      { probe: fakeProbe().probe, journalDirectory: doomed },
      (id) => measured.push(id),
    );
    tracker.observe(toolEvent("bash", "running"));
    tracker.observe(toolEvent("bash", "completed"));
    await waitUntil(() => measured.length === 1);
    await removeOpenCodeCommandChangeJournals(dataDir, "env-pending");
    expect(existsSync(doomed)).toBe(false);
    tracker.observe(toolEvent("bash", "running", "late"));
    tracker.observe(toolEvent("bash", "completed", "late"));
    await waitUntil(() => measured.length === 2);
    expect(existsSync(doomed)).toBe(false);
  });

  test("keeps an environment id with path syntax inside the journal root", () => {
    const directory = openCodeCommandChangeJournalDirectory(dataDir, "../../escape");
    expect(directory.startsWith(join(dataDir, "opencode-command-changes"))).toBe(true);
    expect(directory).not.toContain("escape");
  });

  test("measures a real worktree change against the turn's baseline", async () => {
    const repo = mkdtempSync(join(tmpdir(), "opencode-command-repo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "probe@example.com");
      git("config", "user.name", "Probe");
      writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      const probe = new WorkspaceChangeProbe({ tempDir: dataDir });
      const measured: string[] = [];
      const tracker = new OpenCodeCommandChanges(repo, { probe }, (id) => measured.push(id));
      // The turn's baseline, awaited here only to make the test deterministic.
      await probe.prime(repo);

      tracker.observe(toolEvent("bash", "running"));
      // The command already ran by the time OpenCode reports it running.
      writeFileSync(join(repo, "a.txt"), "one\n2\nthree\n");
      tracker.observe(toolEvent("bash", "completed"));
      await waitUntil(() => measured.length === 1, 10_000);

      expect((await tracker.changes("session-1")).get("call-1")).toEqual({
        additions: 2,
        deletions: 1,
        files: [{ path: "a.txt", status: "M", additions: 2, deletions: 1 }],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("does not silently charge child edits to a later parent shell", async () => {
    const repo = mkdtempSync(join(tmpdir(), "opencode-child-repo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const probe = new WorkspaceChangeProbe({ tempDir: dataDir });
    try {
      git("init", "-q");
      git("config", "user.email", "probe@example.com");
      git("config", "user.name", "Probe");
      writeFileSync(join(repo, "tracked.txt"), "start\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      await probe.prime(repo);
      const measured: string[] = [];
      const tracker = new OpenCodeCommandChanges(repo, { probe }, (id) => measured.push(id));
      tracker.observe(toolEvent("task", "running", "parent-task", "parent"));
      tracker.observe(toolEvent("edit", "running", "child-edit", "child"));
      writeFileSync(join(repo, "child.txt"), "child\n");
      tracker.observe(toolEvent("edit", "completed", "child-edit", "child"));
      tracker.observe(toolEvent("task", "completed", "parent-task", "parent"));
      tracker.observe(toolEvent("bash", "running", "parent-shell", "parent"));
      writeFileSync(join(repo, "parent.txt"), "parent\n");
      tracker.observe(toolEvent("bash", "completed", "parent-shell", "parent"));
      await waitUntil(() => measured.includes("parent"), 10_000);
      const change = (await tracker.changes("parent")).get("parent-shell");
      expect(change).toBeDefined();
      expect(
        change?.approximate === true || !change?.files.some((file) => file.path === "child.txt"),
      ).toBe(true);
    } finally {
      await probe.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("OpenCode provider shell badges", () => {
  function bashMessage(status: string) {
    return {
      info: {
        id: "assistant-1",
        sessionID: "owned-session",
        role: "assistant",
        time: { created: 1_700_000_000_000 },
      },
      parts: [
        {
          id: "part-bash",
          sessionID: "owned-session",
          messageID: "assistant-1",
          type: "tool",
          callID: "call-bash",
          tool: "bash",
          state: { status, input: { command: "make fmt" }, output: "", title: "make fmt" },
        },
      ],
    };
  }

  function provider(
    fake: ReturnType<typeof openCodeFake>,
    probe: CommandChangeProbe,
    directory: string | undefined,
    journalDirectory?: string,
  ) {
    return createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        ...(directory ? { directory } : {}),
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
        autoAnswerRequests: false,
        monitorRetryMs: 1,
        openCodeStatusReconcileIntervalMs: 60_000,
        commandChanges: { probe, ...(journalDirectory ? { journalDirectory } : {}) },
      },
    );
  }

  function bashPart(snapshot: { messages: unknown[] }) {
    const message = snapshot.messages[0] as { parts?: Array<Record<string, unknown>> } | undefined;
    return message?.parts?.[0];
  }

  test("overlays the measurement on the shell row and moves the transcript revision", async () => {
    const fake = openCodeFake();
    fake.setMessagesResponse({ data: [bashMessage("running")] });
    const { probe, calls } = fakeProbe();
    const subject = provider(fake, probe, "/worktree");
    subject.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1 && fake.messageCalls.length > 0);
      const options = { limit: 50, targetBytes: 1_000_000 };
      const before = await subject.transcriptSnapshot!("owned-session", options);
      if ("unchanged" in before) throw new Error("expected a transcript");

      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "message.part.updated",
        properties: { sessionID: "owned-session", part: bashMessage("running").parts[0] },
      });
      stream.push({
        type: "message.part.updated",
        properties: { sessionID: "owned-session", part: bashMessage("completed").parts[0] },
      });
      await waitUntil(() => calls.some(([method]) => method === "end"));

      let after = await subject.transcriptSnapshot!("owned-session", {
        ...options,
        knownSourceToken: before.sourceToken,
      });
      for (
        let attempt = 0;
        attempt < 100 && !("messages" in after && bashPart(after)?.commandChanges);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        after = await subject.transcriptSnapshot!("owned-session", options);
      }
      if ("unchanged" in after) throw new Error("expected a changed transcript");
      expect(after.sourceToken).not.toBe(before.sourceToken);
      expect(bashPart(after)).toMatchObject({
        type: "tool-invocation",
        toolName: "bash",
        commandChanges: CHANGE,
      });
      expect(bashPart(after)?.toolDiff).toBeUndefined();
      expect(calls[0]).toEqual([
        "begin",
        "/worktree",
        "opencode:owned-session:call-bash",
        { baseline: true },
      ]);

      const interactive = await subject.interactiveSnapshot!("owned-session");
      expect(bashPart(interactive)?.commandChanges).toEqual(CHANGE);
    } finally {
      await subject.dispose?.();
    }
  });

  test("overlays journaled measurements on a fresh provider's first read", async () => {
    const journalDirectory = openCodeCommandChangeJournalDirectory(dataDir, "env-1");
    const seed = new OpenCodeCommandChanges(
      "/worktree",
      { probe: fakeProbe().probe, journalDirectory },
      () => undefined,
    );
    seed.observe(toolEvent("bash", "running", "call-bash", "owned-session"));
    seed.observe(toolEvent("bash", "completed", "call-bash", "owned-session"));
    await waitUntil(() => existsSync(join(journalDirectory, "owned-session.jsonl")));
    // Appends are serialized behind the file creation; let the line land.
    await seed.changes("owned-session");

    const fake = openCodeFake();
    fake.setMessagesResponse({ data: [bashMessage("completed")] });
    const subject = provider(fake, fakeProbe().probe, "/worktree", journalDirectory);
    subject.registerSession?.("owned-session");
    try {
      const snapshot = await subject.transcriptSnapshot!("owned-session", {
        limit: 50,
        targetBytes: 1_000_000,
      });
      if ("unchanged" in snapshot) throw new Error("expected a transcript");
      expect(bashPart(snapshot)?.commandChanges).toEqual(CHANGE);
    } finally {
      await subject.dispose?.();
    }
  });

  test("hydrates child shell badges and observes its live tool events", async () => {
    const journalDirectory = openCodeCommandChangeJournalDirectory(dataDir, "env-child");
    const seed = new OpenCodeCommandChanges(
      "/worktree",
      { probe: fakeProbe().probe, journalDirectory },
      () => undefined,
    );
    seed.observe(toolEvent("bash", "running", "child-bash", "child-session"));
    seed.observe(toolEvent("bash", "completed", "child-bash", "child-session"));
    await seed.changes("child-session");

    const fake = openCodeFake();
    const task = {
      id: "task-part",
      sessionID: "owned-session",
      type: "tool",
      tool: "task",
      callID: "parent-task",
      state: {
        status: "completed",
        input: { description: "Inspect" },
        metadata: { sessionId: "child-session" },
      },
    };
    fake.setMessagesHandler(async (parameters) => ({
      data:
        parameters?.sessionID === "child-session"
          ? [
              {
                info: { id: "child-message", role: "assistant", time: { created: 2 } },
                parts: [
                  {
                    ...bashMessage("completed").parts[0],
                    sessionID: "child-session",
                    callID: "child-bash",
                  },
                ],
              },
            ]
          : [
              {
                info: { id: "root-message", role: "assistant", time: { created: 1 } },
                parts: [task],
              },
            ],
    }));
    const { probe, calls } = fakeProbe();
    const subject = provider(fake, probe, "/worktree", journalDirectory);
    subject.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "session.updated",
        properties: { info: { id: "child-session", parentID: "owned-session" } },
      });
      stream.push({
        type: "message.part.updated",
        properties: {
          sessionID: "child-session",
          part: {
            ...task,
            sessionID: "child-session",
            tool: "bash",
            callID: "live-child",
            state: { status: "running", input: { command: "true" } },
          },
        },
      });
      await waitUntil(() =>
        calls.some(
          ([method, , id]) => method === "begin" && id === "opencode:child-session:live-child",
        ),
      );
      stream.push({
        type: "message.part.updated",
        properties: { sessionID: "owned-session", part: task },
      });
      const snapshot = await subject.interactiveSnapshot!("owned-session");
      const root = snapshot.messages[0] as {
        parts: Array<{ subagentActions?: Array<{ commandChanges?: MeasuredWorkspaceChange }> }>;
      };
      expect(root.parts[0]?.subagentActions?.[0]?.commandChanges).toEqual(CHANGE);
    } finally {
      await subject.dispose?.();
    }
  });

  test("never probes a connection without a host directory (container environments)", async () => {
    const fake = openCodeFake();
    fake.setMessagesResponse({ data: [bashMessage("running")] });
    const { probe, calls } = fakeProbe();
    const subject = provider(fake, probe, undefined);
    subject.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      await subject.send("owned-session", "Run it", { requestId: "request-1" });
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "message.part.updated",
        properties: { sessionID: "owned-session", part: bashMessage("running").parts[0] },
      });
      stream.push({
        type: "message.part.updated",
        properties: { sessionID: "owned-session", part: bashMessage("completed").parts[0] },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(calls).toEqual([]);
    } finally {
      await subject.dispose?.();
    }
  });
});
