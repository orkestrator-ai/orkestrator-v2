/**
 * Orkestrator's shared agent instructions on Codex.
 *
 * Every thread the engine starts, resumes or forks carries them as developer
 * instructions. That parameter replaces the user's configured
 * `developer_instructions`, so the engine reads the configured text back and
 * keeps it after its own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { BUILD, harness, thread } from "./app-server-engine-test-harness.js";
import type { EngineTurnConfig } from "./types.js";
import { codexReadOnlyExecRulesInstructions } from "../codex-read-only-exec-rules.js";

function policy(overrides: Partial<NativeAgentExecutionPolicy> = {}): NativeAgentExecutionPolicy {
  return {
    id: "interactive",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: true,
    networkAccess: "full",
    ...overrides,
  };
}

/** A harness that reads the configured instructions through `config/read`. */
function reading(configRead: (params: Record<string, unknown>) => unknown) {
  return harness(
    {
      "config/read": configRead,
      "thread/start": () => ({ thread: thread("t1") }),
      "thread/resume": () => ({ thread: thread("t1") }),
      "thread/fork": () => ({ thread: thread("t2") }),
    },
    { readConfiguredDeveloperInstructions: undefined },
  );
}

function sent(h: ReturnType<typeof harness>, method: string) {
  return h.child().requests.find((request) => request.method === method)!.params;
}

describe("developer instructions on Codex threads", () => {
  test("start, resume and fork carry the shared instructions", async () => {
    const h = reading(() => ({ config: { features: { incremental_tools: false } } }));
    const config: EngineTurnConfig = { ...BUILD, policy: policy() };
    try {
      await h.engine.start();
      await h.engine.startThread({ config });
      await h.engine.resumeThread("t1", { config });
      await h.engine.forkThread("t1", config);
      for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
        expect(sent(h, method).developerInstructions).toBe(agentSystemInstructions());
      }
    } finally {
      await h.engine.stop();
    }
  });

  test("keeps the user's configured developer instructions after Orkestrator's", async () => {
    const h = reading(() => ({ config: { developer_instructions: "Answer in British English." } }));
    try {
      await h.engine.start();
      await h.engine.startThread({ config: { ...BUILD, policy: policy() } });
      expect(sent(h, "thread/start").developerInstructions).toBe(
        `${agentSystemInstructions()}\n\nAnswer in British English.`,
      );
    } finally {
      await h.engine.stop();
    }
  });

  test("reads the project layer only when the thread loads project resources", async () => {
    const h = reading(() => ({ config: {} }));
    try {
      await h.engine.start();
      await h.engine.startThread({ config: { ...BUILD, policy: policy() } });
      await h.engine.startThread({
        config: { ...BUILD, policy: policy({ projectResources: false }) },
      });
      expect(
        h
          .child()
          .requests.filter((request) => request.method === "config/read")
          .map((request) => request.params),
      ).toEqual([{ cwd: "/tmp/workspace" }, {}]);
    } finally {
      await h.engine.stop();
    }
  });

  test("an unreadable configuration still sends Orkestrator's instructions", async () => {
    const h = reading(() => {
      throw new Error("config unavailable");
    });
    try {
      await h.engine.start();
      await h.engine.startThread({ config: { ...BUILD, policy: policy() } });
      expect(sent(h, "thread/start").developerInstructions).toBe(agentSystemInstructions());
    } finally {
      await h.engine.stop();
    }
  });

  test("a read-only coordinator without AGENTS.md gets none and reads nothing for them", async () => {
    let reads = 0;
    const h = harness(
      { "thread/start": () => ({ thread: thread("t1") }) },
      {
        readConfiguredDeveloperInstructions: async () => {
          reads += 1;
          return "unused";
        },
      },
    );
    try {
      await h.engine.start();
      await h.engine.startThread({
        config: {
          ...BUILD,
          policy: policy({ id: "coordinator-read-only", projectResources: false }),
        },
      });
      expect(sent(h, "thread/start").developerInstructions).toBeUndefined();
      expect(reads).toBe(0);
    } finally {
      await h.engine.stop();
    }
  });
});

describe("the repository's AGENTS.md on Codex threads", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "codex-agents-md-"));
    await writeFile(join(workspace, "AGENTS.md"), "Always show visual changes as images.\n");
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function instructionsFor(overrides: Partial<NativeAgentExecutionPolicy>) {
    const h = harness({ "thread/start": () => ({ thread: thread("t1") }) });
    try {
      await h.engine.start();
      await h.engine.startThread({
        config: { ...BUILD, cwd: workspace, policy: policy(overrides) },
      });
      return sent(h, "thread/start").developerInstructions as string | undefined;
    } finally {
      await h.engine.stop();
    }
  }

  test("a thread pinned untrusted carries it after the shared instructions", async () => {
    const instructions = await instructionsFor({ projectResources: false });
    expect(instructions).toStartWith(agentSystemInstructions());
    expect(instructions).toContain("# Repository instructions (AGENTS.md)");
    expect(instructions).toContain("Always show visual changes as images.");
  });

  test("a thread that loads the project leaves it to Codex", async () => {
    expect(await instructionsFor({ projectResources: true })).toBe(agentSystemInstructions());
  });

  test("a read-only turn without Codex's sandbox excludes them and names its allowed commands on start and resume, an ordinary one restores them", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "thread/resume": () => ({ thread: thread("t1") }),
    });
    const ordinary: EngineTurnConfig = {
      ...BUILD,
      cwd: workspace,
      policy: policy({ projectResources: false }),
    };
    // What `app-server-runtime-prompt.ts` sends for a read-only turn whose
    // command sandbox cannot run (`codex-read-only-sandbox.ts`).
    const sandboxOff: EngineTurnConfig = {
      ...ordinary,
      sandbox: "danger-full-access",
      approvalPolicy: "untrusted",
      readOnlyCommandSandboxOff: "Codex's command sandbox cannot run commands in this container.",
    };
    const instructions = (method: string, occurrence: number) =>
      h.child().requests.filter((request) => request.method === method)[occurrence]!.params
        .developerInstructions as string | undefined;
    try {
      await h.engine.start();
      await h.engine.startThread({ config: sandboxOff });
      await h.engine.resumeThread("t1", { config: sandboxOff });
      await h.engine.resumeThread("t1", { config: ordinary });
      for (const sent of [instructions("thread/start", 0), instructions("thread/resume", 0)]) {
        expect(sent).toStartWith(agentSystemInstructions());
        expect(sent).not.toContain("Always show visual changes as images.");
        // The model is told which commands the bridge's exec-policy rules let
        // run, so it does not spend the turn on commands that are declined.
        expect(sent).toContain(codexReadOnlyExecRulesInstructions());
      }
      expect(instructions("thread/resume", 1)).toContain("Always show visual changes as images.");
      expect(instructions("thread/resume", 1)).not.toContain(codexReadOnlyExecRulesInstructions());
    } finally {
      await h.engine.stop();
    }
  });

  test("a read-only coordinator excludes repository instructions", async () => {
    const instructions = await instructionsFor({
      id: "coordinator-read-only",
      projectResources: false,
    });
    expect(instructions).toBeUndefined();
  });
});
