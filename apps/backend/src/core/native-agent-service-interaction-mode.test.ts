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
import { STARTUP_AGENT_TAB_ID } from "@orkestrator/protocol/tab-initial-prompt";
import type { ProviderStatus } from "./agent-provider-contract.js";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { NativeAgentService } from "./native-agent-service.js";
import { StorageService } from "./storage.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const refusingInvoke: Invoke = async <T>(command: string): Promise<T> => {
  throw new Error(`Unexpected backend command: ${command}`);
};

function providerStub(overrides: Partial<NativeAgentRuntimeProvider> = {}) {
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
    ...overrides,
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
  if (environment.claudeNativeBackend === "tmux") {
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({ ...config.global, experimentalTmux: true });
  }
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

  test.each(["task", "interactive"] as const)(
    "sends the %s frame for an image-only launch",
    async (mode) => {
      const { provider, send } = providerStub();
      await withService(
        {
          pendingAgentLaunch: true,
          defaultAgent: "codex",
          codexMode: "native",
          interactionMode: mode,
          initialPromptAttachments: [
            { id: "image-1", name: "diagram.png", mimeType: "image/png", base64Data: "YQ==" },
          ],
        },
        { provider },
        async ({ storage, service }) => {
          await service.reconcileInitialLaunch("env-1");
          expect(send).toHaveBeenCalledTimes(1);
          const [, prompt, options] = send.mock.calls[0]!;
          expect(prompt).toContain(
            mode === "task" ? TASK_INTERACTION_INSTRUCTION : INTERACTIVE_INTERACTION_INSTRUCTION,
          );
          expect(stripSystemInstructions(prompt)).toBe("");
          expect(options).toMatchObject({ images: [{ filename: "diagram.png", data: "YQ==" }] });
          expect((await storage.getEnvironment("env-1"))?.initialPrompt).toBeUndefined();
        },
      );
    },
  );

  test("stages a file-only launch and frames the prepared prompt once", async () => {
    const { provider, send } = providerStub();
    const invoke: Invoke = async <T>(command: string) => {
      expect(command).toBe("write_initial_prompt_attachments");
      return [{ id: "file-1", name: "notes.txt", path: "/tmp/env-1/notes.txt" }] as T;
    };
    await withService(
      {
        pendingAgentLaunch: true,
        defaultAgent: "codex",
        codexMode: "native",
        interactionMode: "task",
        initialPromptAttachments: [
          {
            id: "file-1",
            name: "notes.txt",
            type: "file",
            mimeType: "text/plain",
            base64Data: "YQ==",
          },
        ],
      },
      { provider, invoke },
      async ({ service }) => {
        await service.reconcileInitialLaunch("env-1");
        expect(send).toHaveBeenCalledTimes(1);
        const sent = send.mock.calls[0]![1];
        expect(stripSystemInstructions(sent)).toContain("notes.txt");
        expect(sent.split(TASK_INTERACTION_INSTRUCTION)).toHaveLength(2);
      },
    );
  });

  test.each([false, true])(
    "frames a manual first turn after a prompt-less create (auto-launch=%s)",
    async (pendingAgentLaunch) => {
      const { provider, send } = providerStub();
      await withService(
        {
          pendingAgentLaunch,
          defaultAgent: "codex",
          codexMode: "native",
          interactionMode: "task",
        },
        { provider },
        async ({ service }) => {
          await service.reconcileInitialLaunch("env-1");
          expect(send).not.toHaveBeenCalled();
          const input = {
            environmentId: "env-1",
            agent: "codex" as const,
            logicalSessionKey: `env-env-1:${pendingAgentLaunch ? STARTUP_AGENT_TAB_ID : "manual"}`,
          };
          await service.dispatchPrompt({
            ...input,
            prompt: "First manual request",
            requestId: "first",
          });
          await service.dispatchPrompt({ ...input, prompt: "Follow-up", requestId: "second" });
          expect(send.mock.calls[0]?.[1]).toContain(TASK_INTERACTION_INSTRUCTION);
          expect(send.mock.calls[1]?.[1]).toBe("Follow-up");
        },
      );
    },
  );

  test("routes Grok's opening work to a native session when its preference is terminal", async () => {
    const { provider, send } = providerStub({ agent: "grok" });
    await withService(
      {
        pendingAgentLaunch: true,
        defaultAgent: "grok",
        grokMode: "terminal",
        initialPrompt: "Fix the login bug",
        interactionMode: "task",
      },
      { provider },
      async ({ storage, service }) => {
        await service.reconcileInitialLaunch("env-1");
        expect(send.mock.calls[0]?.[1]).toContain(TASK_INTERACTION_INSTRUCTION);
        expect((await storage.getEnvironment("env-1"))?.pendingAgentLaunch).toBe(false);
      },
    );
  });

  test("runs bare Codex /compact and frames the first subsequent model prompt", async () => {
    const performSessionAction = mock(async () => ({ outcome: "applied" as const }));
    const { provider, send } = providerStub({ performSessionAction });
    await withService(
      {
        pendingAgentLaunch: true,
        defaultAgent: "codex",
        codexMode: "native",
        initialPrompt: "/compact",
        interactionMode: "task",
      },
      { provider },
      async ({ service }) => {
        await service.reconcileInitialLaunch("env-1");
        expect(performSessionAction).toHaveBeenCalledWith("provider-session", { kind: "compact" });
        expect(send).not.toHaveBeenCalled();
        await service.dispatchPrompt({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: `env-env-1:${STARTUP_AGENT_TAB_ID}`,
          requestId: "after-compact",
          prompt: "Fix the login bug",
        });
        expect(send.mock.calls[0]?.[1]).toContain(TASK_INTERACTION_INSTRUCTION);
      },
    );
  });

  test("keeps provider slash-command arguments intact", async () => {
    const { provider, send } = providerStub({
      agent: "claude",
      commandCatalogue: async () => ({
        status: "ready",
        enhanced: true,
        commands: [
          {
            name: "/review",
            source: "project",
            id: "claude:/review",
            executionKind: "provider-prompt",
          },
        ],
      }),
    });
    await withService(
      {
        pendingAgentLaunch: true,
        defaultAgent: "claude",
        claudeMode: "native",
        initialPrompt: "/review src/auth",
        interactionMode: "task",
      },
      { provider },
      async ({ service }) => {
        await service.reconcileInitialLaunch("env-1");
        expect(send.mock.calls[0]?.[1]).toBe("/review src/auth");
        expect(send.mock.calls[0]?.[2]).toMatchObject({ command: { arguments: "src/auth" } });
      },
    );
  });

  test("declines an opening Task question while preserving approvals and follow-up questions", async () => {
    let status: ProviderStatus = "idle";
    let requests = [
      { id: "opening-question", kind: "question" },
      { id: "opening-approval", kind: "command-approval" },
    ];
    const resolveInteraction = mock(async (_sessionId, interactionId, _resolution) => {
      requests = requests.filter((request) => request.id !== interactionId);
      return { result: "applied" as const };
    }) as unknown as NonNullable<NativeAgentRuntimeProvider["interactions"]>["resolveInteraction"];
    const { provider } = providerStub({
      status: async () => status,
      interactions: {
        listPendingInteractions: async () =>
          ({ requests }) as Awaited<
            ReturnType<
              NonNullable<NativeAgentRuntimeProvider["interactions"]>["listPendingInteractions"]
            >
          >,
        resolveInteraction,
      },
    });
    await withService(
      {
        pendingAgentLaunch: true,
        defaultAgent: "codex",
        codexMode: "native",
        initialPrompt: "Fix the login bug",
        interactionMode: "task",
      },
      { provider },
      async ({ service }) => {
        await service.reconcileInitialLaunch("env-1");
        status = "blocked";
        await service.reconcileAgentActivity();
        expect(resolveInteraction).toHaveBeenCalledTimes(1);
        expect(resolveInteraction).toHaveBeenCalledWith(
          "provider-session",
          "opening-question",
          expect.objectContaining({ action: "decline" }),
        );
        status = "idle";
        await service.reconcileAgentActivity();

        await service.dispatchPrompt({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: `env-env-1:${STARTUP_AGENT_TAB_ID}`,
          requestId: "follow-up",
          prompt: "Follow up",
        });
        requests = [{ id: "follow-up-question", kind: "question" }];
        status = "blocked";
        await service.reconcileAgentActivity();
        expect(resolveInteraction).toHaveBeenCalledTimes(1);
      },
    );
  });

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

  test.each([
    ["task", { defaultAgent: "codex", codexMode: "terminal" }, "codex"],
    ["interactive", { defaultAgent: "codex", codexMode: "terminal" }, "codex"],
    [
      "interactive",
      { defaultAgent: "claude", claudeMode: "native", claudeNativeBackend: "tmux" },
      "claude-tmux",
    ],
  ] as const)(
    "a %s terminal launch applies guidance through %s (%s)",
    async (mode, agentSettings, tabType) => {
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
          ...agentSettings,
          initialPrompt: "Fix the login bug",
          interactionMode: mode,
        },
        { provider, invoke },
        async ({ storage, service }) => {
          await service.reconcileInitialLaunch("env-1");

          expect(launches).toHaveLength(1);
          // The shell quoting mangles punctuation, so look for a quote-free phrase.
          expect(launches[0]?.tabType).toBe(tabType);
          expect(String(launches[0]?.initialPrompt ?? launches[0]?.data)).toContain(
            mode === "task"
              ? "This environment was opened as a task"
              : "This environment was opened for interactive work",
          );
          expect((await storage.getEnvironment("env-1"))?.initialPrompt).toBe("Fix the login bug");
        },
      );
    },
  );
});
