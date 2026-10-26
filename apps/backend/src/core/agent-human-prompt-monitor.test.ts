import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { humanPromptObservation } from "@orkestrator/protocol/human-prompts";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  AgentHumanPromptMonitor,
  isTaskOutputFile,
  runningShellSources,
  runningTaskOutputFiles,
  type MonitoredSession,
} from "./agent-human-prompt-monitor.js";
import { HumanPromptRegistry } from "./human-prompt-registry.js";
import { readTaskOutputTail } from "./task-output-tail.js";

const GH_DEVICE =
  "! First copy your one-time code: 1A2B-3C4D\nPress Enter to open https://github.com/login/device in your browser... ";
const TASK_FILE =
  "/private/tmp/claude-501/-Users-me-worktree/9680739d-4785-48ba-b2c7-0a23681fc64d/tasks/b22y6b1by.output";

function shellRow(state: "pending" | "success", output: string, id = "toolu_1") {
  return {
    id: `row-${id}`,
    role: "assistant",
    parts: [
      {
        type: "tool-invocation",
        toolName: "Bash",
        toolUseId: id,
        toolArgs: { command: "gh auth login --web" },
        toolState: state,
        toolOutput: output,
      },
    ],
  };
}

function monitor(
  read: () => { messages?: unknown; backgroundTasks?: unknown } | null,
  files = new Map<string, string>(),
) {
  const prompts = new HumanPromptRegistry();
  let sessions: MonitoredSession[] = [
    {
      environmentId: "env",
      agent: "codex",
      logicalSessionKey: "env-env:startup-agent",
      local: true,
    },
  ];
  const instance = new AgentHumanPromptMonitor({
    prompts,
    workingSessions: async () => sessions,
    projection: async () => {
      const raw = read();
      return raw ? humanPromptObservation(raw.messages, raw.backgroundTasks) : null;
    },
    readFileTail: async (file) => files.get(file) ?? null,
  });
  return {
    prompts,
    instance,
    stopWorking: () => {
      sessions = [];
    },
  };
}

describe("agent shell output that needs the user", () => {
  test("a running shell call's device code is published for its tab and cleared when it settles", async () => {
    let row = shellRow("pending", GH_DEVICE);
    const { prompts, instance } = monitor(() => ({ messages: [row] }));
    await instance.tick();
    expect(prompts.list()).toEqual([
      expect.objectContaining({
        id: "tool:toolu_1",
        environmentId: "env",
        tabId: "startup-agent",
        source: "agent-tool",
        command: "gh auth login --web",
        prompt: expect.objectContaining({
          kind: "device-code",
          url: "https://github.com/login/device",
          code: "1A2B-3C4D",
        }),
      }),
    ]);
    row = shellRow("success", `${GH_DEVICE}\n✓ Logged in\n`);
    await instance.tick();
    expect(prompts.list()).toEqual([]);
  });

  test("a running background shell's output file is read on this host (the npm login incident)", async () => {
    const files = new Map([
      [
        TASK_FILE,
        "npm notice Log in on https://registry.npmjs.org/\nLogin at:\nhttps://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967\n",
      ],
    ]);
    const launch = {
      id: "row-launch",
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Bash",
          toolUseId: "toolu_bg",
          toolArgs: {
            command: "npm login --auth-type=web > /tmp/npm-login.log 2>&1",
            run_in_background: true,
          },
          toolState: "success",
          toolOutput: `Command running in background with ID: b22y6b1by. Output is being written to: ${TASK_FILE}. You will be notified when it completes.`,
        },
      ],
    };
    let tasks: unknown[] = [
      { id: "b22y6b1by", status: "running", kind: "shell", toolUseId: "toolu_bg" },
    ];
    let messages: unknown[] = [launch];
    const { prompts, instance } = monitor(() => ({ messages, backgroundTasks: tasks }), files);
    await instance.tick();
    expect(prompts.list()).toEqual([
      expect.objectContaining({
        id: "task:b22y6b1by",
        source: "agent-background-task",
        command: "npm login --auth-type=web > /tmp/npm-login.log 2>&1",
        prompt: expect.objectContaining({ kind: "sign-in" }),
      }),
    ]);
    // The launch row scrolls out of the read; the task is still followed.
    messages = [];
    await instance.tick();
    expect(prompts.list()).toHaveLength(1);
    tasks = [{ id: "b22y6b1by", status: "completed", kind: "shell", toolUseId: "toolu_bg" }];
    await instance.tick();
    expect(prompts.list()).toEqual([]);
  });

  test("a tab that stops working has nothing waiting any more", async () => {
    const { prompts, instance, stopWorking } = monitor(() => ({
      messages: [shellRow("pending", GH_DEVICE)],
    }));
    await instance.tick();
    expect(prompts.list()).toHaveLength(1);
    stopWorking();
    await instance.tick();
    expect(prompts.list()).toEqual([]);
  });

  test("ordinary output, finished calls and non-shell tools are ignored", () => {
    expect(runningShellSources([shellRow("pending", "Compiling 312 modules…\n")])).toHaveLength(1);
    expect(runningShellSources([shellRow("success", GH_DEVICE)])).toEqual([]);
    expect(
      runningShellSources([
        {
          role: "assistant",
          parts: [
            {
              type: "tool-invocation",
              toolName: "Read",
              toolUseId: "r",
              toolState: "pending",
              toolOutput: GH_DEVICE,
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  test("grouped and nested parts are found", () => {
    const nested = {
      role: "assistant",
      parts: [{ type: "tool-group", parts: [shellRow("pending", GH_DEVICE).parts[0]] }],
    };
    expect(runningShellSources([nested]).map((source) => source.id)).toEqual(["tool:toolu_1"]);
  });
});

describe("task output files", () => {
  test("only the provider's own task output files qualify", () => {
    expect(isTaskOutputFile(TASK_FILE)).toBe(true);
    expect(isTaskOutputFile("/tmp/claude-1000/-workspace/abc/tasks/x1.output")).toBe(true);
    expect(isTaskOutputFile("/Users/me/.ssh/id_ed25519")).toBe(false);
    expect(isTaskOutputFile("/tmp/claude-501/a/../../etc/tasks/x.output")).toBe(false);
    expect(isTaskOutputFile("/tmp/claude-501/a/tasks/x.output.bak")).toBe(false);
    expect(
      runningTaskOutputFiles([], [{ id: "t", status: "running", outputFile: "/etc/passwd" }]),
    ).toEqual([]);
    expect(
      runningTaskOutputFiles(
        [],
        [{ id: "t", status: "running", kind: "agent", outputFile: TASK_FILE }],
      ),
    ).toEqual([]);
  });

  test("the tail read returns the last bytes and refuses a planted symlink", async () => {
    const root = `/tmp/claude-${900000000 + Math.floor(Math.random() * 99999999)}`;
    const tasks = path.join(root, "-work", "session", "tasks");
    mkdirSync(tasks, { recursive: true });
    try {
      const real = path.join(tasks, "real1.output");
      writeFileSync(real, `${"x".repeat(100)}TAIL`);
      expect(await readTaskOutputTail(real, 4)).toBe("TAIL");
      const secret = path.join(root, "secret.txt");
      writeFileSync(secret, "do not read");
      const link = path.join(tasks, "link1.output");
      symlinkSync(secret, link);
      expect(isTaskOutputFile(link)).toBe(true);
      expect(await readTaskOutputTail(link, 64)).toBeNull();
      const fifo = path.join(tasks, "fifo1.output");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const start = Date.now();
      expect(await readTaskOutputTail(fifo, 64)).toBeNull();
      expect(Date.now() - start).toBeLessThan(1000);
      expect(await readTaskOutputTail(real, 4)).toBe("TAIL");
      const prompts = new HumanPromptRegistry();
      const sessions = ["fifo", "later"].map((tab) => ({
        environmentId: "env",
        agent: "codex",
        logicalSessionKey: `env-env:${tab}`,
        local: true,
      }));
      const scanner = new AgentHumanPromptMonitor({
        prompts,
        workingSessions: async () => sessions,
        projection: async (session) =>
          session.logicalSessionKey.endsWith("fifo")
            ? humanPromptObservation([], [{ id: "fifo", status: "running", outputFile: fifo }])
            : humanPromptObservation([shellRow("pending", GH_DEVICE)]),
        readFileTail: readTaskOutputTail,
      });
      await scanner.tick();
      expect(prompts.list()[0]?.tabId).toBe("later");
      await scanner.tick();
      expect(prompts.list()).toHaveLength(1);
      // Not a task file at all: refused before any open.
      expect(await readTaskOutputTail(secret, 64)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("an observation started before owner cleanup cannot resurrect its prompt", async () => {
  const prompts = new HumanPromptRegistry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observing!: () => void;
  const started = new Promise<void>((resolve) => {
    observing = resolve;
  });
  const session = {
    environmentId: "env",
    agent: "codex",
    logicalSessionKey: "env-env:tab",
    local: true,
  };
  const monitor = new AgentHumanPromptMonitor({
    prompts,
    workingSessions: async () => [session],
    projection: async () => {
      observing();
      await gate;
      return humanPromptObservation([shellRow("pending", GH_DEVICE)]);
    },
    readFileTail: async () => null,
  });
  const tick = monitor.tick();
  await started;
  prompts.clearTab("env", "tab");
  release();
  await tick;
  expect(prompts.list()).toEqual([]);
});
