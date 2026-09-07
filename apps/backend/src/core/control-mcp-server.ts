import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { normalizeAgentPlatforms, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { z } from "zod";

const CONTROL_MCP_PATH = "/mcp";
const CONTROL_MCP_DESCRIPTOR = "control-mcp.json";
export const DEFAULT_CONTROL_MCP_PORT = 34_122;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_TRANSCRIPT_MESSAGES = 100;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_TERMINAL_OUTPUT_CHARS = 256 * 1024;
const COORDINATOR_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_COORDINATOR_CREDENTIALS = 512;
const TERMINAL_TAB_TYPES = new Set([
  "plain",
  "claude",
  "opencode",
  "codex",
  "cursor",
  "grok",
  "pi",
  "root",
  "claude-tmux",
]);

const COORDINATOR_TOOL_CAPABILITY = new Map<string, string>([
  ["list_projects", "discovery"],
  ["get_launch_options", "discovery"],
  ["get_repository_context", "discovery"],
  ["list_workflows", "discovery"],
  ["adopt_workflow", "discovery"],
  ["list_environments", "environments"],
  ["get_environment", "environments"],
  ["list_tabs", "environments"],
  ["get_tab_state", "environments"],
  ["get_tab_transcript", "environments"],
  ["launch_environment", "environments"],
  ["start_environment", "environments"],
  ["stop_environment", "environments"],
  ["list_tickets", "tickets"],
  ["get_ticket", "tickets"],
  ["create_ticket", "tickets"],
  ["update_ticket", "tickets"],
  ["add_ticket_comment", "tickets"],
  ["launch_job", "jobs"],
  ["send_prompt_to_tab", "jobs"],
  ["start_build_pipeline", "build-pipelines"],
  ["get_build_pipeline", "build-pipelines"],
  ["pause_build_pipeline", "build-pipelines"],
  ["resume_build_pipeline", "build-pipelines"],
  ["cancel_build_pipeline", "build-pipelines"],
  ["start_multi_review", "multi-review"],
  ["get_multi_review", "multi-review"],
  ["cancel_multi_review", "multi-review"],
  ["address_multi_review", "multi-review"],
  ["list_mailboxes", "mail"],
  ["send_message", "mail"],
  ["read_messages", "mail"],
  ["get_message", "mail"],
  ["get_message_status", "mail"],
  ["ack_message", "mail"],
]);
const COORDINATOR_CAPABILITIES = new Set(COORDINATOR_TOOL_CAPABILITY.values());

export type ControlMcpInfo = {
  url: string;
  descriptorFile: string;
};

export type ControlMcpSettings = {
  enabled: boolean;
  running: boolean;
  url: string;
  token: string;
  error: string | null;
};

export type ControlMcpServerOptions = {
  bindAddress?: string;
  port?: number;
};

export type CoordinatorControlScope = {
  role: "coordinator";
  projectId: string;
  coordinatorId: string;
  conversationId: string;
  mailboxIncarnationId: string;
  capabilities: readonly string[];
};

export type CoordinatorControlConnection = {
  url: string;
  token: string;
};

export type ControlMcpInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function configuredControlMcpPort(): number {
  const configured = process.env.ORKESTRATOR_CONTROL_MCP_PORT?.trim();
  if (!configured) return DEFAULT_CONTROL_MCP_PORT;
  if (!/^\d+$/.test(configured)) throw new Error("ORKESTRATOR_CONTROL_MCP_PORT is invalid");
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ORKESTRATOR_CONTROL_MCP_PORT is invalid");
  }
  return port;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization || Array.isArray(authorization)) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
  return match?.[1] ?? null;
}

function tokenMatches(candidate: string | null, expected: string): boolean {
  if (!candidate || !expected) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      request.resume();
      throw new Error("Control MCP request body is too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("Control MCP request body must be valid JSON");
  }
}

function jsonResponse(response: ServerResponse, status: number, body: JsonRecord): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function toolResult(value: JsonRecord, summary: JsonRecord = value) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
    structuredContent: value,
  };
}

function projectSummary(project: JsonRecord): JsonRecord {
  return {
    id: project.id,
    name: project.name,
    addedAt: project.addedAt,
    order: project.order,
    hasLocalCheckout: typeof project.localPath === "string" && project.localPath.length > 0,
  };
}

function environmentSummary(environment: JsonRecord): JsonRecord {
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

function paneTabs(layout: unknown): JsonRecord[] {
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

function terminalSessionId(environment: JsonRecord, environmentId: string, tabId: string): string {
  return environment.environmentType === "local"
    ? `local-${environmentId}:${tabId}`
    : `${String(environment.containerId ?? "")}:${tabId}`;
}

function nativeTab(
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

function compactMessages(messages: unknown[]): { messages: JsonRecord[]; truncated: boolean } {
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

function ticketSummary(task: JsonRecord): JsonRecord {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    order: task.order,
    createdAt: task.createdAt,
    commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
    imageCount: Array.isArray(task.images) ? task.images.length : 0,
    environmentId: task.environmentId,
    prUrl: task.prUrl,
    prState: task.prState,
  };
}

function ticketDetail(task: JsonRecord): JsonRecord {
  return {
    ...ticketSummary(task),
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    comments: Array.isArray(task.comments) ? task.comments.slice(-50) : [],
  };
}

function workflowSummary(workflow: JsonRecord): JsonRecord {
  return {
    id: workflow.id,
    projectId: workflow.projectId,
    environmentId: workflow.environmentId,
    taskId: workflow.taskId,
    phase: workflow.phase,
    error: workflow.error,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    revision: workflow.revision ?? workflow.backendRevision,
  };
}

function normalizedWorkflow(value: unknown): JsonRecord | null {
  const transported = isRecord(value) && isRecord(value.record) ? value.record : value;
  if (!isRecord(transported)) return null;
  if (!isRecord(transported.snapshot)) return transported;
  const snapshot = transported.snapshot;
  return {
    ...snapshot,
    id: snapshot.id ?? transported.id,
    projectId: snapshot.projectId ?? transported.projectId,
    environmentId: snapshot.environmentId ?? transported.environmentId,
    updatedAt: transported.updatedAt ?? snapshot.updatedAt,
    revision: transported.revision ?? snapshot.revision ?? snapshot.backendRevision,
  };
}

const agentSelectionSchema = z.object({
  agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
  model: z.string().trim().min(1).max(500),
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
});

async function allEnvironments(
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

function reasoningOptions(ids: unknown): Array<{ id: string; label: string }> {
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

async function cachedLaunchModels(
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

async function launchOptions(
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

async function validateSelection(
  invoke: ControlMcpInvoker,
  input: {
    projectId: string;
    environmentId?: string;
    agent: AgentPlatform;
    modelId?: string;
    reasoningId?: string;
  },
): Promise<void> {
  const options = await launchOptions(invoke, input.projectId, input.environmentId);
  if (!options.enabledAgents.includes(input.agent)) {
    throw new Error(`Agent platform is disabled: ${input.agent}`);
  }
  if (input.reasoningId && !input.modelId) throw new Error("reasoningId requires modelId");
  if (!input.modelId) return;
  const model = options.models.find(
    (candidate) => candidate.platform === input.agent && candidate.id === input.modelId,
  );
  if (!model) throw new Error(`Model is not available for ${input.agent}: ${input.modelId}`);
  if (input.reasoningId && !(model.reasoning ?? []).some(({ id }) => id === input.reasoningId)) {
    throw new Error(`Reasoning option is not available for ${input.modelId}: ${input.reasoningId}`);
  }
}

function readAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

async function createControlMcp(
  invoke: ControlMcpInvoker,
  coordinatorScope?: CoordinatorControlScope,
): Promise<McpServer> {
  const config = await invoke<unknown>("get_config");
  const messagingEnabled =
    isRecord(config) &&
    isRecord(config.global) &&
    isRecord(config.global.agentMessaging) &&
    config.global.agentMessaging.enabled === true;
  const server = new McpServer(
    { name: "orkestrator-control", version: "1.0.0" },
    {
      instructions:
        "Control Orkestrator through project IDs returned by list_projects. " +
        "Use launch_environment for a new workspace and launch_job for an independent " +
        "agent tab in an existing ready environment. Reuse requestId when retrying mutations.",
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Orkestrator projects",
      description: "List safe summaries of the projects configured in Orkestrator.",
      inputSchema: z.object({}),
      annotations: readAnnotations(),
    },
    async () => {
      const projects = asArray(await invoke("get_projects"))
        .filter((project) => !coordinatorScope || project.id === coordinatorScope.projectId)
        .map(projectSummary);
      return toolResult({ projects, total: projects.length });
    },
  );

  server.registerTool(
    "get_launch_options",
    {
      title: "Get agent launch options",
      description: "List enabled agents and validated model choices for a project.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200),
        environmentId: z.string().trim().min(1).max(200).optional(),
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, environmentId }) => {
      const options = await launchOptions(invoke, projectId, environmentId);
      return toolResult(options as unknown as JsonRecord);
    },
  );

  server.registerTool(
    "list_environments",
    {
      title: "List Orkestrator environments",
      description: "List environment lifecycle and agent activity summaries.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200).optional(),
        status: z.enum(["running", "stopped", "error", "creating", "stopping"]).optional(),
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, status }) => {
      const all = await allEnvironments(invoke, projectId ?? coordinatorScope?.projectId);
      const environments = all
        .filter((environment) => !status || environment.status === status)
        .map(environmentSummary);
      return toolResult({ environments, total: environments.length });
    },
  );

  server.registerTool(
    "get_environment",
    {
      title: "Get an Orkestrator environment",
      description: "Read the authoritative lifecycle and activity state of one environment.",
      inputSchema: z.object({ environmentId: z.string().trim().min(1).max(200) }),
      annotations: readAnnotations(),
    },
    async ({ environmentId }) => {
      const environment = await invoke<unknown>("get_environment", { environmentId });
      if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
      return toolResult({ environment: environmentSummary(environment) });
    },
  );

  server.registerTool(
    "list_tabs",
    {
      title: "List environment tabs",
      description: "List tabs from the backend-owned pane layout of an environment.",
      inputSchema: z.object({ environmentId: z.string().trim().min(1).max(200) }),
      annotations: readAnnotations(),
    },
    async ({ environmentId }) => {
      const layout = await invoke<unknown>("get_pane_layout", { environmentId });
      const tabs = paneTabs(layout);
      return toolResult({ environmentId, tabs, total: tabs.length });
    },
  );

  server.registerTool(
    "get_tab_state",
    {
      title: "Get tab state",
      description: "Read native-agent state for a tab without returning its transcript.",
      inputSchema: z.object({
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
      }),
      annotations: readAnnotations(),
    },
    async ({ environmentId, tabId }) => {
      const [layout, environment] = await Promise.all([
        invoke<unknown>("get_pane_layout", { environmentId }),
        invoke<unknown>("get_environment", { environmentId }),
      ]);
      const tab = paneTabs(layout).find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`Tab not found: ${tabId}`);
      const native = nativeTab(layout, tabId);
      if (!native) {
        if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
        if (typeof tab.type !== "string" || !TERMINAL_TAB_TYPES.has(tab.type)) {
          return toolResult({ environmentId, tabId, tab, state: { kind: "persisted" } });
        }
        const state = await invoke<unknown>("get_terminal_session", {
          sessionId: terminalSessionId(environment, environmentId, tabId),
        });
        return toolResult({ environmentId, tabId, tab, state });
      }
      const projection = await invoke<unknown>("get_native_agent_projection", {
        environmentId,
        agent: native.agent,
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        messageLimit: 1,
      });
      if (!isRecord(projection)) {
        return toolResult({ environmentId, tabId, agent: native.agent, connection: "connecting" });
      }
      const { messages: _messages, ...state } = projection;
      return toolResult({ environmentId, tabId, agent: native.agent, state });
    },
  );

  server.registerTool(
    "get_tab_transcript",
    {
      title: "Read a tab transcript",
      description:
        "Read a bounded normalized transcript for a native tab, or a bounded terminal-output tail for a terminal tab.",
      inputSchema: z.object({
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(MAX_TRANSCRIPT_MESSAGES).default(50),
      }),
      annotations: readAnnotations(),
    },
    async ({ environmentId, tabId, limit }) => {
      const [layout, environment] = await Promise.all([
        invoke<unknown>("get_pane_layout", { environmentId }),
        invoke<unknown>("get_environment", { environmentId }),
      ]);
      const native = nativeTab(layout, tabId);
      if (native) {
        const projection = await invoke<unknown>("get_native_agent_projection", {
          environmentId,
          agent: native.agent,
          logicalSessionKey: `env-${environmentId}:${tabId}`,
          messageLimit: limit,
        });
        if (!isRecord(projection)) {
          return toolResult({ environmentId, tabId, agent: native.agent, messages: [] });
        }
        const compact = compactMessages(
          Array.isArray(projection.messages) ? projection.messages : [],
        );
        return toolResult({
          environmentId,
          tabId,
          agent: native.agent,
          ...compact,
          messageWindow: projection.messageWindow,
          revision: projection.revision,
          generation: projection.generation,
        });
      }
      if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
      const tab = paneTabs(layout).find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`Tab not found: ${tabId}`);
      if (typeof tab.type !== "string" || !TERMINAL_TAB_TYPES.has(tab.type)) {
        throw new Error(`Transcript is unavailable for tab type: ${String(tab.type)}`);
      }
      const sessionId = terminalSessionId(environment, environmentId, tabId);
      const snapshot = await invoke<unknown>("get_terminal_output_snapshot", { sessionId });
      const output =
        isRecord(snapshot) && typeof snapshot.output === "string" ? snapshot.output : "";
      const stripped = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
      return toolResult({
        environmentId,
        tabId,
        kind: "terminal-output",
        output: stripped.slice(-MAX_TERMINAL_OUTPUT_CHARS),
        truncated:
          stripped.length > MAX_TERMINAL_OUTPUT_CHARS ||
          (isRecord(snapshot) && snapshot.truncated === true),
        revision: isRecord(snapshot) ? snapshot.revision : undefined,
        generation: isRecord(snapshot) ? snapshot.generation : undefined,
      });
    },
  );

  server.registerTool(
    "list_tickets",
    {
      title: "List Kanban tickets",
      description: "List Kanban tickets for one configured project.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200),
        status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, status }) => {
      const tasks = asArray(await invoke("get_kanban_tasks", { projectId }))
        .filter((task) => !status || task.status === status)
        .map(ticketSummary);
      return toolResult({ tickets: tasks, total: tasks.length });
    },
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Read a Kanban ticket",
      description: "Read one ticket after verifying it belongs to the selected project.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200),
        ticketId: z.string().trim().min(1).max(200),
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, ticketId }) => {
      const task = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!task) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Create a Kanban ticket",
      description: "Create a ticket in one configured project.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(500),
        description: z.string().max(100_000).default(""),
        acceptanceCriteria: z.string().max(100_000).default(""),
        status: z.enum(["backlog", "in-progress", "review", "done"]).default("backlog"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, projectId, title, description, acceptanceCriteria, status }) => {
      const project = await invoke<unknown>("get_project", { projectId });
      if (!isRecord(project)) throw new Error(`Project not found: ${projectId}`);
      const task = await invoke<unknown>("add_kanban_task", {
        projectId,
        title,
        description,
        acceptanceCriteria,
        status,
        requestId,
      });
      if (!isRecord(task)) throw new Error("Kanban ticket creation returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Update a Kanban ticket",
      description: "Update specified editable fields of a ticket in one project.",
      inputSchema: z
        .object({
          projectId: z.string().trim().min(1).max(200),
          ticketId: z.string().trim().min(1).max(200),
          title: z.string().trim().min(1).max(500).optional(),
          description: z.string().max(100_000).optional(),
          acceptanceCriteria: z.string().max(100_000).optional(),
          status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
        })
        .refine(
          ({ title, description, acceptanceCriteria, status }) =>
            title !== undefined ||
            description !== undefined ||
            acceptanceCriteria !== undefined ||
            status !== undefined,
          "Provide at least one field to update",
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, ticketId, ...updates }) => {
      const existing = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!existing) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      const task = await invoke<unknown>("update_kanban_task", { taskId: ticketId, ...updates });
      if (!isRecord(task)) throw new Error("Kanban ticket update returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "add_ticket_comment",
    {
      title: "Add a Kanban ticket comment",
      description: "Append a durable comment to a ticket in one project.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        ticketId: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(20_000),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, projectId, ticketId, text }) => {
      const existing = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!existing) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      const task = await invoke<unknown>("add_kanban_comment", {
        taskId: ticketId,
        text,
        projectId,
        requestId,
      });
      if (!isRecord(task)) throw new Error("Kanban comment creation returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "launch_environment",
    {
      title: "Launch an agent environment",
      description:
        "Create, configure, and start an autonomous coding agent that can execute commands, modify workspace files, and use allowed network access. Reuse requestId when retrying.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        environmentType: z.enum(["local", "containerized"]).default("local"),
        name: z.string().trim().min(1).max(200).optional(),
        agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
        modelId: z.string().trim().min(1).max(500).optional(),
        reasoningId: z.string().trim().min(1).max(100).optional(),
        conversationMode: z.enum(["plan", "build"]).default("build"),
        prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
        networkAccessMode: z.enum(["restricted", "full"]).optional(),
        baseBranch: z.string().trim().min(1).max(500).optional(),
        baseCommit: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      if (coordinatorScope && (!input.baseBranch || !input.baseCommit)) {
        throw new Error("Coordinator launches require an explicit baseBranch and baseCommit");
      }
      const repository = coordinatorScope
        ? await invoke<unknown>("get_project_git_status", {
            projectId: coordinatorScope.projectId,
          })
        : null;
      await validateSelection(invoke, input);
      const createInput = {
        projectId: input.projectId,
        name: input.name,
        networkAccessMode: input.networkAccessMode,
        initialPrompt: input.prompt,
        environmentType: input.environmentType,
        namingPrompt: input.name ? undefined : input.prompt,
        agentSettings: {
          defaultAgent: input.agent,
          platforms: { [input.agent]: { mode: "native" } },
        },
        pendingAgentLaunch: true,
        initialAgentModel: input.modelId,
        initialReasoningEffort: input.reasoningId,
        initialConversationMode: input.conversationMode,
        ...(input.baseBranch ? { delegationBaseBranch: input.baseBranch } : {}),
        ...(input.baseCommit ? { delegationBaseCommit: input.baseCommit } : {}),
      };
      const launch = coordinatorScope
        ? await invoke<unknown>("launch_coordinator_environment", {
            scope: coordinatorScope,
            requestId: input.requestId,
            input: createInput,
          })
        : {
            environment: await invoke<unknown>("create_environment", {
              ...createInput,
              controlRequestId: input.requestId,
            }),
          };
      const environment = isRecord(launch) ? launch.environment : null;
      if (!isRecord(environment) || typeof environment.id !== "string") {
        throw new Error("Environment creation returned no environment");
      }
      let startError =
        isRecord(launch) && typeof launch.startError === "string" ? launch.startError : undefined;
      if (
        !coordinatorScope &&
        environment.status !== "running" &&
        environment.status !== "creating"
      ) {
        try {
          await invoke("start_environment_background", { environmentId: environment.id });
        } catch (error) {
          startError = error instanceof Error ? error.message : "Environment start failed";
        }
      }
      return toolResult({
        environmentId: environment.id,
        tabId: "startup-agent",
        status: startError ? "created" : "accepted",
        ...(isRecord(repository)
          ? {
              delegationBaseBranch: input.baseBranch,
              delegationBaseCommit: input.baseCommit,
              liveCheckoutHasUncommittedChanges:
                Number(repository.trackedChanges ?? 0) + Number(repository.untrackedChanges ?? 0) >
                0,
            }
          : {}),
        ...(startError ? { error: startError } : {}),
      });
    },
  );

  server.registerTool(
    "launch_job",
    {
      title: "Launch a job in an existing environment",
      description:
        "Create a native-agent tab and exactly-once initial turn that can execute commands, modify workspace files, and use configured network access.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        environmentId: z.string().trim().min(1).max(200),
        agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
        modelId: z.string().trim().min(1).max(500).optional(),
        reasoningId: z.string().trim().min(1).max(100).optional(),
        conversationMode: z.enum(["plan", "build"]).default("build"),
        title: z.string().trim().min(1).max(200).optional(),
        prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const environment = await invoke<unknown>("get_environment", {
        environmentId: input.environmentId,
      });
      if (!isRecord(environment) || typeof environment.projectId !== "string") {
        throw new Error(`Environment not found: ${input.environmentId}`);
      }
      await validateSelection(invoke, {
        projectId: environment.projectId,
        environmentId: input.environmentId,
        agent: input.agent,
        modelId: input.modelId,
        reasoningId: input.reasoningId,
      });
      const job = await invoke<unknown>("launch_control_job", {
        ...input,
        ...(coordinatorScope
          ? {
              prompt:
                `<orkestrator-coordinator-delegation>\nProject: ${coordinatorScope.projectId}\nCoordinator: ${coordinatorScope.coordinatorId}\nConversation: ${coordinatorScope.conversationId}\nThis is a server-attested same-project worker delegation. Work only inside this disposable environment under its normal sandbox and approval policy, then report meaningful completion, failure, or blocking details through Orkestrator mail.\n</orkestrator-coordinator-delegation>\n\n` +
                input.prompt,
            }
          : {}),
      });
      if (!isRecord(job)) throw new Error("Job launch returned no result");
      return toolResult(job);
    },
  );

  server.registerTool(
    "send_prompt_to_tab",
    {
      title: "Send a prompt to an existing agent tab",
      description:
        "Dispatch an exactly-once prompt to an autonomous coding agent that can execute commands, modify workspace files, and use configured network access.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
        prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
        conversationMode: z.enum(["plan", "build"]).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ requestId, environmentId, tabId, prompt, conversationMode }) => {
      const layout = await invoke<unknown>("get_pane_layout", { environmentId });
      const native = nativeTab(layout, tabId);
      if (!native) throw new Error(`Native agent tab not found: ${tabId}`);
      const outcome = await invoke<unknown>("dispatch_native_agent_intent", {
        environmentId,
        agent: native.agent,
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        requestId,
        prompt,
        ...(conversationMode ? { mode: conversationMode } : {}),
      });
      if (!isRecord(outcome)) throw new Error("Prompt dispatch returned no result");
      return toolResult({ environmentId, tabId, ...outcome });
    },
  );

  if (coordinatorScope) {
    server.registerTool(
      "get_repository_context",
      {
        title: "Get project repository context",
        description:
          "Read current branch, immutable HEAD commit, dirty state, and upstream freshness. This tool cannot mutate Git.",
        inputSchema: z.object({}),
        annotations: readAnnotations(),
      },
      async () => {
        const status = await invoke<unknown>("get_project_git_status", {
          projectId: coordinatorScope.projectId,
        });
        if (!isRecord(status)) throw new Error("Repository status returned no result");
        return toolResult({ repository: status });
      },
    );
    server.registerTool(
      "list_workflows",
      {
        title: "List coordinator workflows",
        description:
          "List durable worker, build-pipeline, and multi-review associations for this project with bounded authoritative summaries.",
        inputSchema: z.object({}),
        annotations: readAnnotations(),
      },
      async () => {
        const snapshot = await invoke<unknown>("get_project_coordinator", {
          projectId: coordinatorScope.projectId,
        });
        const associations = isRecord(snapshot) ? asArray(snapshot.workflows).slice(-200) : [];
        const workflows = await Promise.all(
          associations.map(async (association) => {
            const kind = association.kind;
            const resourceId =
              typeof association.resourceId === "string" ? association.resourceId : "";
            let resource: JsonRecord | null = null;
            try {
              if (association.pending === true || resourceId.startsWith("pending:")) {
                resource = { id: resourceId, status: "pending" };
              } else if (kind === "environment") {
                const environment = await invoke<unknown>("get_environment", {
                  environmentId: resourceId,
                });
                resource = isRecord(environment) ? environmentSummary(environment) : null;
              } else if (kind === "build-pipeline") {
                const workflow = await invoke<unknown>("get_build_pipeline", {
                  pipelineId: resourceId,
                });
                const record = normalizedWorkflow(workflow);
                resource = record ? workflowSummary(record) : null;
              } else if (kind === "multi-review") {
                const workflow = await invoke<unknown>("get_multi_review_workflow", {
                  workflowId: resourceId,
                });
                const record = normalizedWorkflow(workflow);
                resource = record ? workflowSummary(record) : null;
              }
            } catch {
              resource = { id: resourceId, status: "unavailable" };
            }
            return {
              id: association.id,
              kind,
              resourceId,
              requestId: association.requestId,
              baseBranch: association.baseBranch,
              baseCommit: association.baseCommit,
              createdAt: association.createdAt,
              resource,
            };
          }),
        );
        return toolResult({ workflows, total: workflows.length });
      },
    );
    server.registerTool(
      "adopt_workflow",
      {
        title: "Adopt a coordinator workflow",
        description:
          "Associate an orphaned or closed-tab workflow with this conversation so terminal notifications can be delivered here.",
        inputSchema: z.object({ associationId: z.string().trim().min(1).max(200) }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ associationId }) => {
        const association = await invoke<unknown>("adopt_coordinator_workflow", {
          ...coordinatorScope,
          associationId,
        });
        if (!isRecord(association)) throw new Error("Workflow adoption returned no result");
        return toolResult({ association });
      },
    );
    const scopedWorkflow = async (kind: "build" | "review", workflowId: string) => {
      const raw = await invoke<unknown>(
        kind === "build" ? "get_build_pipeline" : "get_multi_review_workflow",
        kind === "build" ? { pipelineId: workflowId } : { workflowId },
      );
      const record = normalizedWorkflow(raw);
      if (!record || record.projectId !== coordinatorScope.projectId) {
        throw new Error(
          `${kind === "build" ? "Build pipeline" : "Multi-review"} not found in this project`,
        );
      }
      return record;
    };

    for (const [tool, command, title] of [
      ["start_environment", "start_environment_background", "Start a worker environment"],
      ["stop_environment", "stop_environment", "Stop a worker environment"],
    ] as const) {
      server.registerTool(
        tool,
        {
          title,
          description: `${title} that belongs to this coordinator's project.`,
          inputSchema: z.object({ environmentId: z.string().trim().min(1).max(200) }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: tool === "stop_environment",
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ environmentId }) => {
          await invoke("get_environment", { environmentId });
          await invoke(command, { environmentId });
          return toolResult({ environmentId, accepted: true });
        },
      );
    }

    server.registerTool(
      "start_build_pipeline",
      {
        title: "Start a structured build pipeline",
        description:
          "Start Orkestrator's durable build/review/verify/PR workflow in a disposable worker environment.",
        inputSchema: z.object({
          requestId: z.string().trim().min(1).max(256),
          taskId: z.string().trim().min(1).max(200),
          environmentType: z.enum(["local", "containerized"]).default("local"),
          baseBranch: z.string().trim().min(1).max(500),
          baseCommit: z.string().regex(/^[0-9a-f]{40}$/i),
          agentType: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
          taskTitle: z.string().trim().min(1).max(500),
          taskSnapshot: z.object({
            title: z.string().max(500),
            description: z.string().max(100_000),
            acceptanceCriteria: z.string().max(100_000),
            comments: z
              .array(z.object({ text: z.string().max(20_000) }))
              .max(200)
              .default([]),
            images: z
              .array(z.object({ filename: z.string().max(500), data: z.string().max(5_000_000) }))
              .max(20)
              .default([]),
          }),
          existingEnvironmentId: z.string().trim().min(1).max(200).optional(),
          maxIterations: z.number().int().min(1).max(20).optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ requestId, baseBranch, baseCommit, ...input }) => {
        if (input.existingEnvironmentId) {
          await invoke("get_environment", { environmentId: input.existingEnvironmentId });
        }
        const workflow = await invoke<unknown>("start_coordinator_build_pipeline", {
          scope: coordinatorScope,
          requestId,
          input: {
            ...input,
            projectId: coordinatorScope.projectId,
            delegationBaseBranch: baseBranch,
            delegationBaseCommit: baseCommit,
          },
        });
        const record = normalizedWorkflow(workflow);
        if (!record) throw new Error("Build pipeline returned no result");
        return toolResult({ workflow: workflowSummary(record) });
      },
    );

    server.registerTool(
      "get_build_pipeline",
      {
        title: "Get a build pipeline",
        description: "Read authoritative state for a coordinator-associated build pipeline.",
        inputSchema: z.object({ pipelineId: z.string().trim().min(1).max(200) }),
        annotations: readAnnotations(),
      },
      async ({ pipelineId }) =>
        toolResult({ workflow: workflowSummary(await scopedWorkflow("build", pipelineId)) }),
    );

    for (const [tool, command, title] of [
      ["pause_build_pipeline", "pause_build_pipeline", "Pause a build pipeline"],
      ["resume_build_pipeline", "resume_build_pipeline", "Resume a build pipeline"],
      ["cancel_build_pipeline", "cancel_build_pipeline", "Cancel a build pipeline"],
    ] as const) {
      server.registerTool(
        tool,
        {
          title,
          description: `${title} in this coordinator's project.`,
          inputSchema: z.object({ pipelineId: z.string().trim().min(1).max(200) }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: tool === "cancel_build_pipeline",
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ pipelineId }) => {
          await scopedWorkflow("build", pipelineId);
          const workflow = await invoke<unknown>(command, { pipelineId });
          const record = normalizedWorkflow(workflow);
          return toolResult({ workflow: record ? workflowSummary(record) : { id: pipelineId } });
        },
      );
    }

    server.registerTool(
      "start_multi_review",
      {
        title: "Start a multi-review",
        description: "Start a durable multi-model review in an existing worker environment.",
        inputSchema: z.object({
          requestId: z.string().trim().min(1).max(256),
          buildPipelineId: z.string().trim().min(1).max(200),
          environmentId: z.string().trim().min(1).max(200),
          targetBranch: z.string().trim().min(1).max(500),
          reviewInstruction: z.string().max(100_000).optional(),
          reviewers: z.array(agentSelectionSchema).min(1).max(32),
          fixModel: agentSelectionSchema,
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ requestId, buildPipelineId, ...input }) => {
        await invoke("get_environment", { environmentId: input.environmentId });
        const workflow = await invoke<unknown>("start_coordinator_multi_review", {
          scope: coordinatorScope,
          requestId,
          buildPipelineId,
          input: { ...input, projectId: coordinatorScope.projectId },
        });
        const record = normalizedWorkflow(workflow);
        if (!record) throw new Error("Multi-review returned no result");
        return toolResult({ workflow: workflowSummary(record) });
      },
    );

    server.registerTool(
      "get_multi_review",
      {
        title: "Get a multi-review",
        description: "Read authoritative state for a multi-review in this project.",
        inputSchema: z.object({ workflowId: z.string().trim().min(1).max(200) }),
        annotations: readAnnotations(),
      },
      async ({ workflowId }) =>
        toolResult({ workflow: workflowSummary(await scopedWorkflow("review", workflowId)) }),
    );

    for (const [tool, command, title] of [
      ["cancel_multi_review", "cancel_multi_review", "Cancel a multi-review"],
      ["address_multi_review", "address_multi_review", "Address multi-review findings"],
    ] as const) {
      server.registerTool(
        tool,
        {
          title,
          description: `${title} in the associated worker environment.`,
          inputSchema: z.object({ workflowId: z.string().trim().min(1).max(200) }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ workflowId }) => {
          await scopedWorkflow("review", workflowId);
          const workflow = await invoke<unknown>(command, { workflowId });
          const record = normalizedWorkflow(workflow);
          return toolResult({ workflow: record ? workflowSummary(record) : { id: workflowId } });
        },
      );
    }
  }

  if (messagingEnabled) {
    server.registerTool(
      "list_mailboxes",
      {
        title: "List agent mailboxes",
        description:
          "List durable agent-message destinations without transcript or filesystem content.",
        inputSchema: z.object({
          q: z.string().trim().max(200).optional(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(200).default(100),
        }),
        annotations: readAnnotations(),
      },
      async ({ q, offset, limit }) => {
        const page = await invoke<unknown>("list_agent_mailboxes", {
          q,
          offset,
          limit,
          ...(coordinatorScope
            ? { projectId: coordinatorScope.projectId, strictProjectScope: true }
            : {}),
        });
        if (!isRecord(page)) throw new Error("Mailbox directory returned no result");
        return toolResult(page);
      },
    );

    server.registerTool(
      "send_message",
      {
        title: coordinatorScope ? "Send a coordinator message" : "Send an external agent message",
        description: coordinatorScope
          ? "Durably send an authenticated same-project delegation or reply from this coordinator conversation."
          : "Durably place text in one Orkestrator tab inbox. External messages are never auto-injected into an agent turn.",
        inputSchema: z.object({
          requestId: z.string().trim().min(1).max(256),
          toEnvironmentId: z.string().trim().min(1).max(200),
          toTabId: z.string().trim().min(1).max(200),
          subject: z.string().trim().max(200).optional(),
          body: z
            .string()
            .min(1)
            .refine(
              (value) => Buffer.byteLength(value, "utf8") <= 32 * 1024,
              "body must be at most 32 KiB UTF-8",
            ),
          replyToMessageId: z.string().trim().min(1).max(300).optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const message = await invoke<unknown>(
          coordinatorScope ? "send_coordinator_agent_mail" : "send_external_agent_mail",
          coordinatorScope ? { ...input, ...coordinatorScope } : input,
        );
        if (!isRecord(message)) throw new Error("Message send returned no result");
        const { body: _body, ...summary } = message;
        return toolResult({ message: summary });
      },
    );

    if (coordinatorScope)
      server.registerTool(
        "read_messages",
        {
          title: "Read mailbox messages",
          description:
            "Read a bounded mailbox page. Coordinator credentials may only read their own conversation mailbox.",
          inputSchema: z.object({
            environmentId: z.string().trim().min(1).max(200),
            tabId: z.string().trim().min(1).max(200),
            unreadOnly: z.boolean().default(false),
            offset: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(200).default(100),
          }),
          annotations: readAnnotations(),
        },
        async (input) => {
          if (coordinatorScope) {
            const ownEnvironmentId = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
            const workspace = await invoke<unknown>("get_project_coordinator", {
              projectId: coordinatorScope.projectId,
            });
            const conversations =
              isRecord(workspace) &&
              isRecord(workspace.workspace) &&
              Array.isArray(workspace.workspace.conversations)
                ? workspace.workspace.conversations
                : [];
            const own = conversations.find(
              (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
            );
            if (
              input.environmentId !== ownEnvironmentId ||
              !isRecord(own) ||
              input.tabId !== own.tabId
            ) {
              throw new Error("Coordinator credential may only read its own mailbox");
            }
          }
          const page = await invoke<unknown>("get_agent_mail_mailbox", input);
          if (!isRecord(page)) throw new Error("Mailbox returned no result");
          return toolResult(page);
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "get_message",
        {
          title: "Get a mailbox message",
          description: "Read one message body from this coordinator conversation's own mailbox.",
          inputSchema: z.object({
            environmentId: z.string().trim().min(1).max(200),
            tabId: z.string().trim().min(1).max(200),
            messageId: z.string().trim().min(1).max(300),
          }),
          annotations: readAnnotations(),
        },
        async (input) => {
          const ownEnvironmentId = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
          const workspace = await invoke<unknown>("get_project_coordinator", {
            projectId: coordinatorScope.projectId,
          });
          const conversations =
            isRecord(workspace) &&
            isRecord(workspace.workspace) &&
            Array.isArray(workspace.workspace.conversations)
              ? workspace.workspace.conversations
              : [];
          const own = conversations.find(
            (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
          );
          if (
            input.environmentId !== ownEnvironmentId ||
            !isRecord(own) ||
            input.tabId !== own.tabId
          ) {
            throw new Error("Coordinator credential may only read its own mailbox");
          }
          const message = await invoke<unknown>("get_agent_mail_message", input);
          if (!isRecord(message)) throw new Error("Mailbox message was not found");
          return toolResult({ message });
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "get_message_status",
        {
          title: "Get message delivery status",
          description:
            "Inspect durable stored, pending, injected, acknowledged, and seen state without returning the message body.",
          inputSchema: z.object({ messageId: z.string().trim().min(1).max(300) }),
          annotations: readAnnotations(),
        },
        async ({ messageId }) => {
          const status = await invoke<unknown>("get_agent_mail_status", { messageId });
          if (!isRecord(status)) throw new Error("Message status was not found");
          const ownRuntime = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
          const from = isRecord(status.from) ? status.from : null;
          const allowedBySender = from?.projectId === coordinatorScope.projectId;
          const destination =
            typeof status.toEnvironmentId === "string" ? status.toEnvironmentId : "";
          if (!allowedBySender && destination !== ownRuntime) {
            const environment = await invoke<unknown>("get_environment", {
              environmentId: destination,
            });
            if (!isRecord(environment) || environment.projectId !== coordinatorScope.projectId) {
              throw new Error("Coordinator credential cannot inspect that message");
            }
          }
          return toolResult({ message: status });
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "ack_message",
        {
          title: "Acknowledge a mailbox message",
          description: "Mark a message handled without claiming that its task succeeded.",
          inputSchema: z.object({
            environmentId: z.string().trim().min(1).max(200),
            tabId: z.string().trim().min(1).max(200),
            messageId: z.string().trim().min(1).max(300),
          }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (input) => {
          if (coordinatorScope) {
            const ownEnvironmentId = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
            const workspace = await invoke<unknown>("get_project_coordinator", {
              projectId: coordinatorScope.projectId,
            });
            const conversations =
              isRecord(workspace) &&
              isRecord(workspace.workspace) &&
              Array.isArray(workspace.workspace.conversations)
                ? workspace.workspace.conversations
                : [];
            const own = conversations.find(
              (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
            );
            if (
              input.environmentId !== ownEnvironmentId ||
              !isRecord(own) ||
              input.tabId !== own.tabId
            ) {
              throw new Error("Coordinator credential may only acknowledge its own mailbox");
            }
          }
          const result = await invoke<unknown>("ack_agent_mail", input);
          if (!isRecord(result)) throw new Error("Message acknowledgement returned no result");
          const { body: _body, ...summary } = result;
          return toolResult({ message: summary });
        },
      );
  }

  return server;
}

export class ControlMcpServer {
  private server: Server | null = null;
  private token = "";
  private info: ControlMcpInfo | null = null;
  private startError: string | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly bindAddress: string;
  private readonly port: number;
  private readonly coordinatorCredentials = new Map<
    string,
    { scope: CoordinatorControlScope; expiresAt: number }
  >();

  constructor(
    private readonly dataDir: string,
    private readonly invoke: ControlMcpInvoker,
    options: ControlMcpServerOptions = {},
  ) {
    this.bindAddress = options.bindAddress ?? "127.0.0.1";
    this.port = options.port ?? configuredControlMcpPort();
  }

  getInfo(): ControlMcpInfo | null {
    return this.info;
  }

  getSettings(): ControlMcpSettings {
    const enabled = process.env.ORKESTRATOR_CONTROL_MCP_DISABLED !== "1";
    return {
      enabled,
      running: Boolean(this.server),
      url: this.info?.url ?? this.configuredUrl(),
      token: enabled ? this.token : "",
      error: this.startError,
    };
  }

  issueCoordinatorCredential(scope: CoordinatorControlScope): CoordinatorControlConnection {
    if (!this.server || !this.info || process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
      throw new Error("Orkestrator control MCP is disabled or unavailable");
    }
    if (
      scope.capabilities.length === 0 ||
      scope.capabilities.some((capability) => !COORDINATOR_CAPABILITIES.has(capability))
    ) {
      throw new Error("Coordinator capabilities are invalid");
    }
    this.revokeCoordinatorCredentials(scope.coordinatorId, scope.conversationId);
    while (this.coordinatorCredentials.size >= MAX_COORDINATOR_CREDENTIALS) {
      const oldest = this.coordinatorCredentials.keys().next().value;
      if (!oldest) break;
      this.coordinatorCredentials.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.coordinatorCredentials.set(token, {
      scope: Object.freeze({ ...scope }),
      expiresAt: Date.now() + COORDINATOR_CREDENTIAL_TTL_MS,
    });
    return { url: this.info.url, token };
  }

  revokeCoordinatorCredentials(coordinatorId: string, conversationId?: string): void {
    for (const [token, credential] of this.coordinatorCredentials) {
      const scope = credential.scope;
      if (
        scope.coordinatorId === coordinatorId &&
        (conversationId === undefined || scope.conversationId === conversationId)
      ) {
        this.coordinatorCredentials.delete(token);
      }
    }
  }

  async start(): Promise<void> {
    const start = this.lifecycle.then(async () => {
      if (this.server) return;
      const descriptorFile = path.join(this.dataDir, CONTROL_MCP_DESCRIPTOR);
      if (process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
        this.startError = null;
        return;
      }
      this.token = await this.readPersistedToken(descriptorFile);
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            jsonResponse(response, 500, {
              error: error instanceof Error ? error.message : "Control MCP request failed",
            });
          } else {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, this.bindAddress, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error("Control MCP server did not receive a TCP port");
      }
      this.server = server;
      server.unref();
      this.startError = null;
      this.info = {
        url: `http://${this.bindAddress}:${address.port}${CONTROL_MCP_PATH}`,
        descriptorFile,
      };
      try {
        await this.writeDescriptor(descriptorFile, this.info.url);
      } catch (error) {
        this.server = null;
        this.info = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
    });
    this.lifecycle = start.catch(() => undefined);
    try {
      await start;
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const stop = this.lifecycle.then(async () => {
      const server = this.server;
      this.server = null;
      this.info = null;
      this.coordinatorCredentials.clear();
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    });
    this.lifecycle = stop.catch(() => undefined);
    await stop;
  }

  async rotateToken(): Promise<ControlMcpSettings> {
    const rotate = this.lifecycle.then(async () => {
      if (process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
        throw new Error("Orkestrator control MCP is disabled");
      }
      const previousToken = this.token;
      this.token = randomBytes(32).toString("base64url");
      const descriptorFile =
        this.info?.descriptorFile ?? path.join(this.dataDir, CONTROL_MCP_DESCRIPTOR);
      try {
        await this.writeDescriptor(descriptorFile, this.info?.url ?? this.configuredUrl());
      } catch (error) {
        this.token = previousToken;
        throw error;
      }
    });
    this.lifecycle = rotate.catch(() => undefined);
    await rotate;
    return this.getSettings();
  }

  private configuredUrl(): string {
    const port = this.port === 0 ? "<dynamic>" : String(this.port);
    return `http://${this.bindAddress}:${port}${CONTROL_MCP_PATH}`;
  }

  private async readPersistedToken(descriptorFile: string): Promise<string> {
    try {
      const descriptor = await readControlMcpDescriptor(descriptorFile);
      return descriptor.token;
    } catch {
      return randomBytes(32).toString("base64url");
    }
  }

  private async writeDescriptor(descriptorFile: string, url: string): Promise<void> {
    await mkdir(path.dirname(descriptorFile), { recursive: true });
    const temporary = `${descriptorFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, url, token: this.token, pid: process.pid }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, descriptorFile);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://control-mcp.invalid");
    if (url.pathname !== CONTROL_MCP_PATH) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      response.end();
      return;
    }
    const presentedToken = bearerToken(request);
    const coordinatorCredential = presentedToken
      ? this.coordinatorCredentials.get(presentedToken)
      : undefined;
    if (presentedToken && coordinatorCredential && coordinatorCredential.expiresAt <= Date.now()) {
      this.coordinatorCredentials.delete(presentedToken);
    }
    const coordinatorScope =
      coordinatorCredential && coordinatorCredential.expiresAt > Date.now()
        ? coordinatorCredential.scope
        : undefined;
    if (!tokenMatches(presentedToken, this.token) && !coordinatorScope) {
      response.setHeader("www-authenticate", 'Bearer realm="orkestrator-control"');
      jsonResponse(response, 401, { error: "Invalid control MCP credential" });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      jsonResponse(response, 400, {
        error: error instanceof Error ? error.message : "Invalid request body",
      });
      return;
    }
    if (coordinatorScope) {
      const snapshot = await this.invoke<unknown>("get_project_coordinator", {
        projectId: coordinatorScope.projectId,
      });
      const workspace =
        isRecord(snapshot) && isRecord(snapshot.workspace) ? snapshot.workspace : null;
      const conversations =
        workspace && Array.isArray(workspace.conversations) ? workspace.conversations : [];
      const conversation = conversations.find(
        (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
      );
      if (
        !workspace ||
        workspace.id !== coordinatorScope.coordinatorId ||
        !isRecord(conversation) ||
        conversation.closedAt !== undefined ||
        conversation.mailboxIncarnationId !== coordinatorScope.mailboxIncarnationId
      ) {
        this.coordinatorCredentials.delete(presentedToken!);
        jsonResponse(response, 401, { error: "Coordinator credential is no longer valid" });
        return;
      }
      if (workspace.lifecycleState !== "ready") {
        jsonResponse(response, 409, { error: "Coordinator is paused or unavailable" });
        return;
      }
      // Expire abandoned credentials without interrupting a healthy,
      // long-lived coordinator bridge that continues to revalidate normally.
      if (coordinatorCredential) {
        coordinatorCredential.expiresAt = Date.now() + COORDINATOR_CREDENTIAL_TTL_MS;
      }
      const messages = Array.isArray(body) ? body : [body];
      for (const message of messages) {
        if (!isRecord(message) || message.method !== "tools/call") continue;
        const requestedTool = isRecord(message.params) ? message.params.name : undefined;
        if (typeof requestedTool !== "string") {
          jsonResponse(response, 403, { error: "Coordinator capability denied" });
          return;
        }
        const required = COORDINATOR_TOOL_CAPABILITY.get(requestedTool);
        if (!required || !coordinatorScope.capabilities.includes(required)) {
          jsonResponse(response, 403, { error: "Coordinator capability denied" });
          return;
        }
      }
    }
    const scopedInvoke: ControlMcpInvoker = coordinatorScope
      ? async <T>(command: string, args: Record<string, unknown> = {}) => {
          const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
          if (projectId && projectId !== coordinatorScope.projectId) {
            throw new Error("Coordinator credential cannot access another project");
          }
          if (typeof args.environmentId === "string") {
            const ownRuntime = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
            if (args.environmentId !== ownRuntime) {
              const environment = await this.invoke<unknown>("get_environment", {
                environmentId: args.environmentId,
              });
              if (!isRecord(environment) || environment.projectId !== coordinatorScope.projectId) {
                throw new Error("Coordinator credential cannot access that environment");
              }
            }
          }
          const denied = new Set([
            "update_config",
            "remove_project",
            "merge_environment",
            "delete_environment",
            "write_file",
            "move_file",
          ]);
          if (denied.has(command)) throw new Error("Coordinator capability denied");
          return this.invoke<T>(command, args);
        }
      : this.invoke;
    const handler = createMcpHandler(() => createControlMcp(scopedInvoke, coordinatorScope), {
      legacy: "stateless",
    });
    try {
      await toNodeHandler(handler)(request, response, body);
    } finally {
      await handler.close().catch(() => undefined);
    }
  }
}

export async function readControlMcpDescriptor(
  descriptorFile: string,
): Promise<{ version: 1; url: string; token: string; pid: number }> {
  const value = JSON.parse(await readFile(descriptorFile, "utf8")) as unknown;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.url !== "string" ||
    typeof value.token !== "string" ||
    typeof value.pid !== "number"
  ) {
    throw new Error("Control MCP descriptor is invalid");
  }
  return value as { version: 1; url: string; token: string; pid: number };
}
