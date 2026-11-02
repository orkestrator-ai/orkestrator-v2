import { describe, expect, test } from "bun:test";
import { humanPromptObservation } from "@orkestrator/protocol/human-prompts";

import {
  AgentHumanPromptMonitor,
  HUMAN_PROMPT_PROJECTION_REUSE_MS,
  type MonitoredSession,
} from "./agent-human-prompt-monitor.js";
import { HumanPromptRegistry } from "./human-prompt-registry.js";

/**
 * While the provider's content revision is unchanged a working session's
 * observation is reused instead of read, and the result is the same.
 */
const GH_DEVICE =
  "! First copy your one-time code: 1A2B-3C4D\nPress Enter to open https://github.com/login/device in your browser... ";
const TASK_FILE =
  "/private/tmp/claude-501/-Users-me-worktree/9680739d-4785-48ba-b2c7-0a23681fc64d/tasks/b22y6b1by.output";

function shellRow(state: "pending" | "success", output: string) {
  return {
    role: "assistant",
    parts: [
      {
        type: "tool-invocation",
        toolName: "Bash",
        toolUseId: "toolu_1",
        toolArgs: { command: "gh auth login --web" },
        toolState: state,
        toolOutput: output,
      },
    ],
  };
}

function harness(options: { revision?: () => string | undefined } = {}) {
  const prompts = new HumanPromptRegistry();
  const state = {
    now: 0,
    reads: 0,
    fileReads: 0,
    revision: "r1" as string | undefined,
    sessions: [
      {
        environmentId: "env",
        agent: "claude",
        logicalSessionKey: "env-env:tab",
        local: true,
      },
    ] as MonitoredSession[],
    messages: [shellRow("pending", "Compiling…\n")] as unknown[],
    tasks: [] as unknown[],
    files: new Map<string, string>(),
  };
  const monitor = new AgentHumanPromptMonitor({
    prompts,
    workingSessions: async () => state.sessions,
    contentRevision: options.revision ?? (() => state.revision),
    projection: async () => {
      state.reads += 1;
      return humanPromptObservation(state.messages, state.tasks);
    },
    readFileTail: async (file) => {
      state.fileReads += 1;
      return state.files.get(file) ?? null;
    },
    now: () => state.now,
  });
  return { prompts, monitor, state };
}

describe("human-prompt monitor content revisions", () => {
  test("an unchanged revision costs no read; a new one reads again", async () => {
    const { prompts, monitor, state } = harness();
    await monitor.tick();
    expect(state.reads).toBe(1);
    expect(prompts.list()).toEqual([]);

    // The content changes and the sweep reports it: read, and the prompt shows.
    state.messages = [shellRow("pending", GH_DEVICE)];
    state.revision = "r2";
    await monitor.tick();
    expect(state.reads).toBe(2);
    expect(prompts.list()).toHaveLength(1);

    // Nothing new: the last observation stands, and so does its prompt.
    await monitor.tick();
    await monitor.tick();
    expect(state.reads).toBe(2);
    expect(prompts.list()).toHaveLength(1);

    state.messages = [shellRow("success", `${GH_DEVICE}\n✓ Logged in\n`)];
    state.revision = "r3";
    await monitor.tick();
    expect(state.reads).toBe(3);
    expect(prompts.list()).toEqual([]);
  });

  test("a provider that reports no revision is read every pass, as before", async () => {
    const { monitor, state } = harness({ revision: () => undefined });
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    expect(state.reads).toBe(3);
  });

  test("reuse is bounded in time, so a sweep that stopped reading cannot hide output", async () => {
    const { prompts, monitor, state } = harness();
    await monitor.tick();
    state.messages = [shellRow("pending", GH_DEVICE)];
    state.now = HUMAN_PROMPT_PROJECTION_REUSE_MS - 1;
    await monitor.tick();
    expect(state.reads).toBe(1);
    expect(prompts.list()).toEqual([]);
    state.now = HUMAN_PROMPT_PROJECTION_REUSE_MS;
    await monitor.tick();
    expect(state.reads).toBe(2);
    expect(prompts.list()).toHaveLength(1);
  });

  test("a background task's output file is still read every pass", async () => {
    const { prompts, monitor, state } = harness();
    state.messages = [];
    state.tasks = [{ id: "b22y6b1by", status: "running", kind: "shell", outputFile: TASK_FILE }];
    await monitor.tick();
    expect(prompts.list()).toEqual([]);
    // The file grows outside the provider's revision.
    state.files.set(
      TASK_FILE,
      "npm notice Log in on https://registry.npmjs.org/\nLogin at:\nhttps://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967\n",
    );
    await monitor.tick();
    expect(state.reads).toBe(1);
    expect(state.fileReads).toBe(2);
    expect(prompts.list()).toEqual([
      expect.objectContaining({ id: "task:b22y6b1by", source: "agent-background-task" }),
    ]);
  });

  test("a session that stops working forgets its observation", async () => {
    const { monitor, state } = harness();
    const working = state.sessions;
    await monitor.tick();
    state.sessions = [];
    await monitor.tick();
    state.sessions = working;
    await monitor.tick();
    // Same revision as before, but the session left the working set between.
    expect(state.reads).toBe(2);
  });

  test("a failed or timed-out read is not reused", async () => {
    const prompts = new HumanPromptRegistry();
    let reads = 0;
    const monitor = new AgentHumanPromptMonitor({
      prompts,
      workingSessions: async () => [
        { environmentId: "env", agent: "claude", logicalSessionKey: "env-env:tab", local: false },
      ],
      contentRevision: () => "r1",
      projection: async () => {
        reads += 1;
        return reads === 1 ? null : humanPromptObservation([shellRow("pending", GH_DEVICE)]);
      },
      readFileTail: async () => null,
    });
    await monitor.tick();
    await monitor.tick();
    expect(reads).toBe(2);
    expect(prompts.list()).toHaveLength(1);
  });
});
