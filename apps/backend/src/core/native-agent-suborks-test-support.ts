/**
 * A world for subork tests: real storage (mailboxes included), the real result
 * service and agent tools server, so an "agent" calls `ask_agents` and its
 * result tool over MCP as a bridge's agent would, and one fake provider per
 * platform whose agent follows a script. No test here reaches a real provider.
 * Backend "processes" can be replaced over the same store. Test-only.
 */
import { rm } from "node:fs/promises";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentSettingsTiers } from "@orkestrator/protocol/agent-settings";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { fixture } from "./agent-mail-storage-test-support.js";
import { AgentToolsServer } from "./agent-tools.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  fakeAgentTools,
  FakeAgentProvider,
  toolContent,
  type FakeAgentScript,
  type FakeAgentTools,
} from "./graph-agent-test-support.js";
import { GraphAgentProviders } from "./graph-agent-providers.js";
import {
  NativeAgentSuborkService,
  type NativeAgentSuborkServiceOptions,
} from "./native-agent-suborks.js";
import type { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

export const CATALOG: AgentModel[] = [
  { platform: "claude", id: "opus", label: "Opus", resolvedModel: "claude-opus-5-5" },
  { platform: "claude", id: "sonnet", label: "Sonnet", resolvedModel: "claude-sonnet-5-5" },
  { platform: "codex", id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { platform: "codex", id: "gpt-6.1-mini", label: "GPT-6.1 Mini" },
  { platform: "cursor", id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { platform: "cursor", id: "grok-4.7", label: "Grok 4.7" },
  { platform: "cursor", id: "grok-4.6", label: "Grok 4.6" },
  { platform: "grok", id: "grok-code", label: "Grok Code" },
];

/** Answers with text naming the agent that ran, through the turn's result tool. */
export function answering(text: (agent: AgentPlatform) => string = (a) => `${a} says hi`) {
  return (agent: AgentPlatform): FakeAgentScript =>
    async (turn, tools) => {
      const capability = turn.options.agentMcp?.workflowResultCapability;
      await tools.call("submit_subork_answer", {
        resultKey: turn.options.workflowResultKey,
        ...(capability ? { capability } : {}),
        result: { answer: text(agent) },
      });
      return "idle";
    };
}

export interface SuborkWorldOptions {
  script?: (agent: AgentPlatform) => FakeAgentScript;
  enabled?: AgentPlatform[];
  tiers?: AgentSettingsTiers;
  rolloutAllows?: (agent: AgentPlatform) => boolean;
  environmentType?: "local" | "container";
  service?: Partial<NativeAgentSuborkServiceOptions>;
  /** The read-only guard's probe; its submit-time check goes on the world's result service. */
  workspaceProbe?: NativeAgentSuborkServiceOptions["workspaceProbe"];
  /** What a fake transcript holds. */
  messages?: () => unknown[];
  contextUsage?: () => Record<string, unknown> | undefined;
}

export interface SuborkWorld {
  storage: StorageService;
  service: NativeAgentSuborkService;
  providers: Map<AgentPlatform, FakeAgentProvider>;
  announced: string[];
  /** The caller's tool connection, tab-scoped as a native tab's is. */
  tools: FakeAgentTools;
  agentTools: AgentToolsServer;
  reachabilityChecks: string[];
  connectionTargets: string[];
  /** The environment each subork turn's tool connection was issued for. */
  connectionEnvironments: string[];
  provider(agent: AgentPlatform): FakeAgentProvider;
  /** Calls `ask_agents` as the caller and returns the handle. */
  ask(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Passes until the call has settled and delivered, or the bound runs out. */
  drive(batchId: string, passes?: number): Promise<void>;
  settleProviders(): Promise<void>;
  /** A new process over the same store; the old one is shut down. */
  restart(): Promise<void>;
  /** The caller's mail bodies from suborks. */
  mail(): Promise<{ id: string; subject: string; body: string; placement: string }[]>;
  cleanup(): Promise<void>;
}

export async function suborkWorld(options: SuborkWorldOptions = {}): Promise<SuborkWorld> {
  const { storage, dataDir } = await fixture();
  const workflowResults = new WorkflowResultService(dataDir);
  const agentTools = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
  await agentTools.start();
  const scripts = options.script ?? answering();
  const providers = new Map<AgentPlatform, FakeAgentProvider>(
    AGENT_PLATFORMS.map((agent) => {
      const provider = new FakeAgentProvider(agent, scripts(agent));
      provider.runningPolls = 0;
      return [agent, provider] as const;
    }),
  );
  const instance = (agent: AgentPlatform): BuildPipelineProvider => {
    const base = providers.get(agent)!.asProvider();
    return {
      ...base,
      ...(options.messages ? { messages: async () => options.messages!() } : {}),
      observeSession: async (id: string) => ({
        ...(await (
          base as unknown as { observeSession(id: string): Promise<object> }
        ).observeSession(id)),
        ...(options.contextUsage?.() ? { contextUsage: options.contextUsage() } : {}),
      }),
    } as unknown as BuildPipelineProvider;
  };
  const announced: string[] = [];
  const reachabilityChecks: string[] = [];
  const connectionTargets: string[] = [];
  const connectionEnvironments: string[] = [];
  const container = options.environmentType === "container";
  // A container turn's URL names the host from inside Docker, which a test cannot
  // reach, so the target is recorded and the call stays on loopback.
  const serviceStorage: StorageService = container
    ? Object.create(storage, {
        getEnvironment: {
          value: async (id: string) => ({
            ...(await storage.getEnvironment(id)),
            environmentType: "container",
            containerId: "container-1",
          }),
        },
      })
    : storage;
  const build = () =>
    new NativeAgentSuborkService({
      storage: serviceStorage,
      providers: new GraphAgentProviders({ create: async (_env, agent) => instance(agent) }),
      workflowResults,
      agentTools: {
        workflowResultConnection: (environmentId, projectId, target, resultKey, provider) => {
          connectionTargets.push(target);
          connectionEnvironments.push(environmentId);
          return agentTools.workflowResultConnection(
            environmentId,
            projectId,
            "host",
            resultKey,
            provider,
          );
        },
      },
      assertAgentToolsReachable: async (environmentId, stage) => {
        reachabilityChecks.push(`${environmentId}:${stage}`);
      },
      rollout: {
        refresh: async () => undefined,
        allows: (agent) => options.rolloutAllows?.(agent) ?? true,
      },
      modelCatalog: async () => CATALOG,
      settingsTiers: async () =>
        options.tiers ?? { global: { platforms: { codex: { model: "gpt-6.1-sol" } } } },
      enforcementHost: () => ({ claudeSandbox: true }),
      announce: (sessionKey) => announced.push(sessionKey),
      autoAdvance: false,
      pollIntervalMs: 0,
      ...(options.workspaceProbe
        ? { workspaceProbe: options.workspaceProbe, acceptanceChecks: workflowResults }
        : {}),
      ...options.service,
    });
  const config = await storage.loadConfig();
  await storage.saveConfig({
    ...config,
    global: {
      ...config.global,
      enabledAgentPlatforms: options.enabled ?? [...AGENT_PLATFORMS],
      agentMessaging: { ...config.global.agentMessaging, enabled: true },
    },
  } as typeof config);
  let service = build();
  agentTools.setSuborkToolHost(service);
  const tools = fakeAgentTools(agentTools.connection("e1", "p1", "host", "agent"));
  const settleProviders = async () => {
    await Promise.all([...providers.values()].map((provider) => provider.settle()));
  };
  return {
    storage,
    get service() {
      return service;
    },
    providers,
    announced,
    tools,
    agentTools,
    reachabilityChecks,
    connectionTargets,
    connectionEnvironments,
    provider: (agent) => providers.get(agent)!,
    ask: async (args) => {
      const result = await tools.call("ask_agents", args);
      if (result.isError) {
        const content = result.content as { text?: string }[] | undefined;
        throw new Error(content?.[0]?.text ?? "ask_agents failed");
      }
      return toolContent(result);
    },
    settleProviders,
    drive: async (batchId, passes = 30) => {
      for (let pass = 0; pass < passes; pass += 1) {
        const view = await service.advanceNow(batchId);
        await settleProviders();
        if (view && view.status !== "running" && view.delivery !== "waiting") return;
      }
    },
    restart: async () => {
      await service.shutdown();
      service = build();
      agentTools.setSuborkToolHost(service);
      await service.init();
    },
    mail: async () => {
      const mailbox = await storage.getAgentMailMailbox("e1", "agent", { limit: 50 });
      const bodies = await Promise.all(
        mailbox.messages
          .filter((message) => message.subject?.startsWith("Subork answers"))
          .map(async (message) => ({
            id: message.id,
            subject: message.subject ?? "",
            placement: message.placement,
            body: (await storage.getAgentMailMessage("e1", "agent", message.id)).body,
          })),
      );
      return bodies;
    },
    cleanup: async () => {
      await service.shutdown();
      await agentTools.stop();
      workflowResults.closeStorage();
      storage.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
