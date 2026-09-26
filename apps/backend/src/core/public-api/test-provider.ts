import { mock } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import { nativeTabLogicalSessionKey } from "@orkestrator/protocol/public-api-resources";
import type { CommandContext } from "../commands-context.js";
import type { NativeAgentRuntimeProvider } from "../native-agent-provider.js";
import { NativeAgentService, nativeAgentSessionStorageKey } from "../native-agent-service.js";
import { createProject } from "../storage.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * A scriptable provider standing in for a bridge, plus a harness wiring it
 * into a real NativeAgentService over real storage. Nothing spends tokens.
 */

export function controlledProvider(agent: BuildPipelineAgent) {
  let status: () => Promise<string> = async () => "running";
  const messages: unknown[] = [];
  let sendImpl: () => Promise<void> = async () => undefined;
  let counter = 0;
  const pending: AgentInteractionRequest[] = [];
  const sends: Array<{ sessionId: string; prompt: string; requestId?: string }> = [];
  const resolutions: unknown[] = [];
  const provider = {
    agent,
    createSession: async () => `provider-session-${++counter}`,
    registerSession: () => undefined,
    send: mock(async (sessionId: string, prompt: string, options: { requestId?: string }) => {
      sends.push({ sessionId, prompt, requestId: options.requestId });
      await sendImpl();
    }),
    status: mock(() => status()),
    messages: async () => messages,
    structured: async () => null,
    abort: mock(async () => {
      status = async () => "idle";
    }),
    dispose: async () => undefined,
    dispatchStatus: async () => "unknown",
    interactions: {
      listPendingInteractions: async () => ({ version: 1, revision: 1, requests: pending }),
      resolveInteraction: async (sessionId: string, interactionId: string, resolution: unknown) => {
        resolutions.push(resolution);
        const index = pending.findIndex((request) => request.id === interactionId);
        if (index < 0) return { result: "already-resolved", interactionId, sessionId, revision: 2 };
        pending.splice(index, 1);
        return { result: "applied", interactionId, sessionId, revision: 2 };
      },
    },
  } as unknown as NativeAgentRuntimeProvider;
  return {
    provider,
    messages,
    sends,
    pending,
    resolutions,
    setStatus(next: () => Promise<string>) {
      status = next;
    },
    setSend(next: () => Promise<void>) {
      sendImpl = next;
    },
  };
}

export const sessionHarnesses: Array<{ harness: PublicApiHarness; service: NativeAgentService }> =
  [];

export async function cleanupSessionHarnesses(): Promise<void> {
  for (const { harness, service } of sessionHarnesses.splice(0)) {
    await service.shutdown();
    await harness.cleanup();
  }
}

export async function setup(agent: BuildPipelineAgent = "claude") {
  const stub = controlledProvider(agent);
  let service!: NativeAgentService;
  const harness = await createPublicApiHarness({
    context: {
      get nativeAgents() {
        return service;
      },
    } as unknown as Partial<CommandContext>,
  });
  service = new NativeAgentService(
    harness.storage,
    async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
      (await harness.commands.get(name)!(args, harness.context)) as T,
    { provider: async () => stub.provider },
  );
  (harness.context as { nativeAgents?: NativeAgentService }).nativeAgents = service;
  sessionHarnesses.push({ harness, service });
  const project = await harness.storage.addProject(
    createProject("https://example.invalid/session.git"),
  );
  await harness.storage.addEnvironment({
    id: "env-1",
    projectId: project.id,
    name: "sessions",
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
    worktreePath: harness.root,
    setupScriptsComplete: true,
    setupPhase: "ready",
  });
  return { harness, service, stub, projectId: project.id };
}

export function setActivity(
  service: NativeAgentService,
  agent: BuildPipelineAgent,
  tabId: string,
  providerSessionId: string,
  state: "idle" | "working" | "waiting",
  environmentId = "env-1",
) {
  (
    service as unknown as {
      observedSessionActivity: Map<string, { providerSessionId: string; state: string }>;
    }
  ).observedSessionActivity.set(
    nativeAgentSessionStorageKey(
      environmentId,
      agent,
      nativeTabLogicalSessionKey(environmentId, tabId),
    ),
    { providerSessionId, state },
  );
}
