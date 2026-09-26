/**
 * Discovery, tab-resolution and launch-validation actions shared by the
 * Control MCP adapter and the public command contract (`public_action`).
 *
 * Both transports call these through a command invoker, so they see the same
 * registry commands, the same summaries, and the same validation. Transport-
 * specific concerns stay with each adapter: MCP result formatting, tool
 * annotations and coordinator scope live in `control-mcp-server.ts`; public
 * envelopes, receipts and error codes live in `public-api/`.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { normalizeAgentPlatforms } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities, type AgentModel } from "@orkestrator/protocol/native-agent";

export type ControlMcpInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** Invokes a registered backend command. */
export type CommandInvoker = ControlMcpInvoker;

type JsonRecord = Record<string, unknown>;

export const MAX_TRANSCRIPT_MESSAGES = 100;
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function projectSummary(project: JsonRecord): JsonRecord {
  return {
    id: project.id,
    name: project.name,
    addedAt: project.addedAt,
    order: project.order,
    hasLocalCheckout: typeof project.localPath === "string" && project.localPath.length > 0,
  };
}

export function environmentSummary(environment: JsonRecord): JsonRecord {
  return {
    id: environment.id,
    projectId: environment.projectId,
    name: environment.name,
    branch: environment.branch,
    environmentType: environment.environmentType,
    status: environment.status,
    setupPhase: environment.setupPhase,
    lifecycleOperation: environment.lifecycleOperation,
    lifecycleError: environment.lifecycleError,
    agentActivityState: environment.agentActivityState,
    hasUnreadWork: environment.hasUnreadWork,
    pendingAgentLaunch: environment.pendingAgentLaunch,
    startupAgentSession: environment.startupAgentSession,
    prUrl: environment.prUrl,
    prState: environment.prState,
    createdAt: environment.createdAt,
    lastActivityAt: environment.lastActivityAt,
  };
}

export function paneTabs(layout: unknown): JsonRecord[] {
  if (!isRecord(layout)) return [];
  const tabs: JsonRecord[] = [];
  const activePaneId = typeof layout.activePaneId === "string" ? layout.activePaneId : null;
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.kind === "leaf" && typeof node.id === "string" && Array.isArray(node.tabs)) {
      for (const rawTab of node.tabs) {
        if (!isRecord(rawTab) || typeof rawTab.id !== "string") continue;
        const native = isRecord(rawTab.nativeAgentData) ? rawTab.nativeAgentData : undefined;
        tabs.push({
          id: rawTab.id,
          type: rawTab.type,
          title: rawTab.displayTitle,
          paneId: node.id,
          active: activePaneId === node.id && node.activeTabId === rawTab.id,
          ...(native
            ? {
                agent: native.platform,
                hasProviderSession:
                  typeof native.sessionId === "string" && native.sessionId.length > 0,
              }
            : {}),
        });
      }
      return;
    }
    if (node.kind === "split" && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(layout.root);
  return tabs;
}

export function terminalSessionId(
  environment: JsonRecord,
  environmentId: string,
  tabId: string,
): string {
  return environment.environmentType === "local"
    ? `local-${environmentId}:${tabId}`
    : `${String(environment.containerId ?? "")}:${tabId}`;
}

export function nativeTab(
  layout: unknown,
  tabId: string,
): { tab: JsonRecord; agent: AgentPlatform } | null {
  if (!isRecord(layout)) return null;
  let result: { tab: JsonRecord; agent: AgentPlatform } | null = null;
  const visit = (node: unknown): void => {
    if (result || !isRecord(node)) return;
    if (node.kind === "leaf" && Array.isArray(node.tabs)) {
      const tab = node.tabs.find((candidate) => isRecord(candidate) && candidate.id === tabId);
      if (!isRecord(tab) || tab.type !== "agent-native" || !isRecord(tab.nativeAgentData)) return;
      const platform = tab.nativeAgentData.platform;
      if (
        platform === "claude" ||
        platform === "codex" ||
        platform === "cursor" ||
        platform === "grok" ||
        platform === "opencode" ||
        platform === "pi"
      ) {
        result = { tab, agent: platform };
      }
      return;
    }
    if (node.kind === "split" && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(layout.root);
  return result;
}

export function compactMessages(messages: unknown[]): {
  messages: JsonRecord[];
  truncated: boolean;
} {
  const compact: JsonRecord[] = [];
  let bytes = 2;
  let truncated = false;
  for (const raw of messages.slice(-MAX_TRANSCRIPT_MESSAGES).reverse()) {
    if (!isRecord(raw)) continue;
    const content = typeof raw.content === "string" ? raw.content.slice(0, 100_000) : "";
    const parts = Array.isArray(raw.parts)
      ? raw.parts.slice(0, 100).flatMap((part) => {
          if (!isRecord(part)) return [];
          return [
            {
              type: part.type,
              ...(typeof part.toolName === "string" ? { toolName: part.toolName } : {}),
              ...(typeof part.name === "string" ? { name: part.name } : {}),
              ...(typeof part.status === "string" ? { status: part.status } : {}),
            },
          ];
        })
      : [];
    const message: JsonRecord = {
      id: raw.id,
      role: raw.role,
      content,
      createdAt: raw.createdAt,
      ...(typeof raw.modelId === "string" ? { modelId: raw.modelId } : {}),
      ...(parts.length > 0 ? { parts } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (bytes + size > MAX_TRANSCRIPT_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    compact.push(message);
  }
  compact.reverse();
  return {
    messages: compact,
    truncated: truncated || messages.length > compact.length,
  };
}

export async function allEnvironments(
  invoke: ControlMcpInvoker,
  projectId?: string,
): Promise<JsonRecord[]> {
  if (projectId) return asArray(await invoke("get_environment_snapshots", { projectId }));
  const projects = asArray(await invoke("get_projects"));
  const groups = await Promise.all(
    projects.map((project) =>
      invoke("get_environment_snapshots", { projectId: project.id }).then(asArray),
    ),
  );
  return groups.flat();
}

export function reasoningOptions(ids: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(ids)) return [];
  return ids.flatMap((id) => {
    if (typeof id !== "string" || !id.trim()) return [];
    const label =
      id === "xhigh"
        ? "Extra high"
        : id.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
    return [{ id, label }];
  });
}

export async function cachedLaunchModels(
  invoke: ControlMcpInvoker,
  projectId: string,
): Promise<AgentModel[]> {
  const [rawCache, rawOpenCode] = await Promise.all([
    invoke<unknown>("get_agent_model_catalog_cache"),
    invoke<unknown>("get_opencode_model_catalog_cache", { projectId }),
  ]);
  const cache = isRecord(rawCache) ? rawCache : {};
  const catalogModels = (key: string): JsonRecord[] => {
    const catalog = isRecord(cache[key]) ? cache[key] : undefined;
    return catalog ? asArray(catalog.models) : [];
  };
  const claude = catalogModels("claude").flatMap((model): AgentModel[] => {
    if (typeof model.id !== "string" || typeof model.name !== "string") return [];
    const reasoning = reasoningOptions(model.supportedEffortLevels ?? ["low", "medium", "high"]);
    return [
      {
        platform: "claude",
        id: model.id,
        label: model.name,
        providerLabel: "Claude",
        reasoning,
        defaultReasoningId: reasoning.some(({ id }) => id === "high") ? "high" : reasoning[0]?.id,
        parameters: [
          {
            id: "thinking",
            label: "Thinking",
            kind: "select",
            options: [
              { id: "adaptive", label: "Adaptive" },
              { id: "budget-8192", label: "8K budget" },
              { id: "budget-16384", label: "16K budget" },
              { id: "disabled", label: "Disabled" },
            ],
            defaultValue: "adaptive",
            scope: "session",
          },
        ],
        supportsSpeed: model.supportsFastMode !== false,
        supportsMode: true,
      },
    ];
  });
  const codex = catalogModels("codex").flatMap((model): AgentModel[] => {
    if (typeof model.id !== "string" || typeof model.name !== "string") return [];
    const explicitReasoning = asArray(model.reasoningOptions).flatMap((option) =>
      typeof option.effort === "string" && typeof option.label === "string"
        ? [{ id: option.effort, label: option.label }]
        : [],
    );
    const reasoning =
      explicitReasoning.length > 0
        ? explicitReasoning
        : reasoningOptions(model.reasoningEfforts ?? ["medium", "high"]);
    return [
      {
        platform: "codex",
        id: model.id,
        label: model.name,
        providerLabel: "Codex",
        reasoning,
        defaultReasoningId:
          typeof model.defaultReasoningEffort === "string"
            ? model.defaultReasoningEffort
            : reasoning[0]?.id,
        supportsSpeed: true,
        supportsMode: true,
      },
    ];
  });
  const openCodeSnapshot = isRecord(rawOpenCode) ? rawOpenCode : {};
  const openCode = asArray(openCodeSnapshot.models).flatMap((model): AgentModel[] => {
    if (
      typeof model.id !== "string" ||
      typeof model.name !== "string" ||
      typeof model.provider !== "string"
    ) {
      return [];
    }
    const variants = Array.isArray(model.variants)
      ? model.variants.filter((variant): variant is string => typeof variant === "string")
      : [];
    return [
      {
        platform: "opencode",
        id: model.id,
        label: model.name,
        providerLabel: model.provider,
        reasoning: [{ id: "default", label: "Default" }, ...reasoningOptions(variants)],
        defaultReasoningId: "default",
        supportsSpeed: false,
        supportsMode: false,
        ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
        ...(typeof model.supportsImageInput === "boolean"
          ? { supportsImageInput: model.supportsImageInput }
          : {}),
      },
    ];
  });
  const providerNeutral = ["cursor", "grok", "pi"].flatMap((key) =>
    catalogModels(key).filter(
      (model): model is JsonRecord & AgentModel =>
        typeof model.id === "string" &&
        typeof model.label === "string" &&
        typeof model.platform === "string",
    ),
  );
  return [...claude, ...codex, ...openCode, ...providerNeutral];
}

export async function launchOptions(
  invoke: ControlMcpInvoker,
  projectId: string,
  preferredEnvironmentId?: string,
): Promise<{ enabledAgents: AgentPlatform[]; models: AgentModel[] }> {
  const project = await invoke<unknown>("get_project", { projectId });
  if (!isRecord(project)) throw new Error(`Project not found: ${projectId}`);
  const config = await invoke<unknown>("get_config");
  const global = isRecord(config) && isRecord(config.global) ? config.global : {};
  const enabledAgents = normalizeAgentPlatforms(global.enabledAgentPlatforms);
  const environments = await allEnvironments(invoke, projectId);
  const environmentId =
    preferredEnvironmentId ??
    (typeof environments[0]?.id === "string" ? environments[0].id : undefined);
  let models: AgentModel[] = [];
  if (environmentId) {
    const raw = await invoke<unknown>("get_native_agent_model_catalog", { environmentId });
    if (Array.isArray(raw)) models = raw as AgentModel[];
  } else {
    models = await cachedLaunchModels(invoke, projectId);
  }
  return { enabledAgents, models };
}

export async function validateSelection(
  invoke: ControlMcpInvoker,
  input: {
    projectId: string;
    environmentId?: string;
    agent: AgentPlatform;
    modelId?: string;
    reasoningId?: string;
    fastMode?: boolean;
  },
): Promise<void> {
  const options = await launchOptions(invoke, input.projectId, input.environmentId);
  if (!options.enabledAgents.includes(input.agent)) {
    throw new Error(`Agent platform is disabled: ${input.agent}`);
  }
  if (input.reasoningId && !input.modelId) throw new Error("reasoningId requires modelId");
  if (input.fastMode === true && !nativeAgentCapabilities(input.agent).composer.speed) {
    throw new Error(`Fast mode is not available for ${input.agent}`);
  }
  if (!input.modelId) return;
  const model = options.models.find(
    (candidate) => candidate.platform === input.agent && candidate.id === input.modelId,
  );
  if (!model) throw new Error(`Model is not available for ${input.agent}: ${input.modelId}`);
  if (input.reasoningId && !(model.reasoning ?? []).some(({ id }) => id === input.reasoningId)) {
    throw new Error(`Reasoning option is not available for ${input.modelId}: ${input.reasoningId}`);
  }
  if (input.fastMode === true && model.supportsSpeed !== true) {
    throw new Error(`Fast mode is not available for ${input.modelId}`);
  }
}

export interface LaunchEnvironmentInput {
  projectId: string;
  name?: string;
  networkAccessMode?: "restricted" | "full";
  prompt: string;
  environmentType: "local" | "containerized";
  agent: AgentPlatform;
  modelId?: string;
  reasoningId?: string;
  fastMode?: boolean;
  conversationMode: "plan" | "build";
  baseBranch?: string;
  baseCommit?: string;
}

/**
 * The `create_environment` arguments of an environment whose startup agent
 * receives one first prompt. The backend's startup reconciliation owns the
 * rest: once setup is ready it dispatches exactly one initial prompt to the
 * `startup-agent` session under a stable request ID.
 */
export function launchEnvironmentCreateInput(input: LaunchEnvironmentInput): JsonRecord {
  return {
    projectId: input.projectId,
    name: input.name,
    networkAccessMode: input.networkAccessMode,
    initialPrompt: input.prompt,
    environmentType: input.environmentType,
    namingPrompt: input.name ? undefined : input.prompt,
    agentSettings: {
      defaultAgent: input.agent,
      platforms: {
        [input.agent]: {
          mode: "native",
          ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
        },
      },
    },
    pendingAgentLaunch: true,
    initialAgentModel: input.modelId,
    initialReasoningEffort: input.reasoningId,
    initialConversationMode: input.conversationMode,
    ...(input.baseBranch ? { delegationBaseBranch: input.baseBranch } : {}),
    ...(input.baseCommit ? { delegationBaseCommit: input.baseCommit } : {}),
  };
}

/** Stable request ID of the startup agent's single initial prompt. */
export function initialPromptRequestId(environmentId: string): string {
  return `initial-prompt:${environmentId}:startup-agent`;
}
