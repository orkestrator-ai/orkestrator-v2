/**
 * A prompt environment's interaction mode reaches the agent with its opening
 * prompt, on both the native and the terminal launch paths, and never replaces
 * the user's own text in storage.
 */
import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INTERACTIVE_INTERACTION_INSTRUCTION,
  TASK_INTERACTION_INSTRUCTION,
} from "@orkestrator/protocol/environment-interaction";
import { stripSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { NativeAgentService } from "./native-agent-service.js";
import { StorageService } from "./storage.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const refusingInvoke: Invoke = async <T>(command: string): Promise<T> => {
  throw new Error(`Unexpected backend command: ${command}`);
};

function providerStub() {
  const send = mock(async (_sessionId: string, _prompt: string, _options: unknown) => undefined);
  const provider = {
    agent: "codex",
    createSession: mock(async () => "provider-session"),
    registerSession: mock((_sessionId: string) => undefined),
    send,
    status: mock(async () => "idle"),
    messages: async () => [],
    structured: async () => null,
    abort: mock(async () => undefined),
    dispose: mock(async () => undefined),
  } as unknown as NativeAgentRuntimeProvider;
  return { provider, send };
}

async function withService(
  environment: Record<string, unknown>,
  options: { provider?: NativeAgentRuntimeProvider; invoke?: Invoke },
  run: (context: { storage: StorageService; service: NativeAgentService }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-interaction-mode-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/env-1",
    setupScriptsComplete: true,
    ...environment,
  });
  const provider = options.provider;
  const service = new NativeAgentService(
    storage,
    options.invoke ?? refusingInvoke,
    provider ? { provider: async () => provider } : {},
  );
  try {
    await run({ storage, service });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("startup launch interaction mode", () => {
  for (const [mode, instruction] of [
    ["task", TASK_INTERACTION_INSTRUCTION],
    ["interactive", INTERACTIVE_INTERACTION_INSTRUCTION],
  ] as const) {
    test(`a native ${mode} launch tells the agent its mode`, async () => {
      const { provider, send } = providerStub();
      await withService(
        {
          pendingAgentLaunch: true,
          defaultAgent: "codex",
          codexMode: "native",
          initialPrompt: "Fix the login bug",
          interactionMode: mode,
        },
        { provider },
        async ({ storage, service }) => {
          await service.reconcileInitialLaunch("env-1");

          expect(send).toHaveBeenCalledTimes(1);
          const sent = send.mock.calls[0]![1];
          expect(sent).toContain(instruction);
          expect(stripSystemInstructions(sent)).toBe("Fix the login bug");
          const stored = await storage.getEnvironment("env-1");
          expect(stored).toMatchObject({ pendingAgentLaunch: false, interactionMode: mode });
          expect(stored?.initialPrompt).toBe("Fix the login bug");
        },
      );
    });
  }

  test("an environment without a mode sends the prompt unchanged", async () => {
    const { provider, send } = providerStub();
    await withService(
      {
        pendingAgentLaunch: true,
        defaultAgent: "codex",
        codexMode: "native",
        initialPrompt: "Fix the login bug",
      },
      { provider },
      async ({ service }) => {
        await service.reconcileInitialLaunch("env-1");
        expect(send.mock.calls[0]![1]).toBe("Fix the login bug");
      },
    );
  });

  test("a terminal task launch carries the instruction but stores only the user's prompt", async () => {
    const launches: Array<Record<string, unknown> | undefined> = [];
    const invoke: Invoke = async <T>(command: string, args?: Record<string, unknown>) => {
      expect(command).toBe("launch_terminal_job");
      launches.push(args);
      return { status: "started" } as T;
    };
    const { provider } = providerStub();
    await withService(
      {
        pendingAgentLaunch: true,
        defaultAgent: "codex",
        codexMode: "terminal",
        initialPrompt: "Fix the login bug",
        interactionMode: "task",
      },
      { provider, invoke },
      async ({ storage, service }) => {
        await service.reconcileInitialLaunch("env-1");

        expect(launches).toHaveLength(1);
        // The shell quoting mangles punctuation, so look for a quote-free phrase.
        expect(String(launches[0]?.data)).toContain("This environment was opened as a task");
        expect((await storage.getEnvironment("env-1"))?.initialPrompt).toBe("Fix the login bug");
      },
    );
  });
});
