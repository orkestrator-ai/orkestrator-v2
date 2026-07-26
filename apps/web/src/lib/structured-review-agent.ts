import type {
  JsonSchema,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import type { Environment } from "@/types";
import type {
  LoopedReviewSessionPhase,
  LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";
import * as backend from "@/lib/backend";
import {
  abortSession as abortClaudeSession,
  checkHealth as checkClaudeHealth,
  createClient as createClaudeClient,
  createSession as createClaudeSession,
  getStructuredOutput as getClaudeStructuredOutput,
  lookupSession as lookupClaudeSession,
  sendStructuredPrompt as sendClaudeStructuredPrompt,
  type ClaudeClient,
  type ClaudeEffortLevel,
} from "@/lib/claude-client";
import {
  abortSession as abortCodexSession,
  checkHealth as checkCodexHealth,
  createClient as createCodexClient,
  createSession as createCodexSession,
  getStructuredOutput as getCodexStructuredOutput,
  lookupSessionStatus as lookupCodexSessionStatus,
  sendPrompt as sendCodexPrompt,
  type CodexClient,
  type CodexReasoningEffort,
} from "@/lib/codex-client";
import {
  abortSession as abortOpenCodeSession,
  createClient as createOpenCodeClient,
  createSession as createOpenCodeSession,
  getStructuredOutput as getOpenCodeStructuredOutput,
  lookupSessionStatus as lookupOpenCodeSessionStatus,
  sendStructuredPrompt as sendOpenCodeStructuredPrompt,
  type OpencodeClient,
} from "@/lib/opencode-client";

export interface NativeStructuredAgent {
  provider: LoopedReviewWorkflow["agent"];
  createSession(
    phase: LoopedReviewSessionPhase,
    label: string,
  ): Promise<string>;
  send(
    sessionId: string,
    prompt: string,
    schema: JsonSchema,
    requestId: string,
  ): Promise<{ accepted: boolean; requestId: string; error?: string }>;
  getResult<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null>;
  getStatus(
    sessionId: string,
  ): Promise<"running" | "idle" | "error" | "missing">;
  abort(sessionId: string): Promise<boolean>;
}

export interface StructuredReviewPhasePolicy {
  readOnly: boolean;
  claudePermissionMode: "plan" | "bypassPermissions";
  codexMode: "plan" | "build";
  openCodeMode: "plan" | "build";
}

export function getStructuredReviewPhasePolicy(
  phase: LoopedReviewSessionPhase,
): StructuredReviewPhasePolicy {
  const readOnly = phase === "discovery";
  return {
    readOnly,
    claudePermissionMode: readOnly ? "plan" : "bypassPermissions",
    codexMode: readOnly ? "plan" : "build",
    openCodeMode: readOnly ? "plan" : "build",
  };
}

function sessionPhases(
  workflow: LoopedReviewWorkflow,
): Map<string, LoopedReviewSessionPhase> {
  return new Map(
    workflow.sessions.map((session) => [
      session.providerSessionId,
      session.phase,
    ]),
  );
}

function requireSessionPhase(
  phases: Map<string, LoopedReviewSessionPhase>,
  sessionId: string,
): LoopedReviewSessionPhase {
  const phase = phases.get(sessionId);
  if (!phase) {
    throw new Error(`Unknown structured review session: ${sessionId}`);
  }
  return phase;
}

async function resolveProviderPort(
  agent: LoopedReviewWorkflow["agent"],
  environment: Environment,
): Promise<number> {
  if (environment.environmentType === "local") {
    if (agent === "claude") {
      const status = await backend.getLocalClaudeServerStatus(environment.id);
      if (status.running && status.port) return status.port;
      return (await backend.startLocalClaudeServer(environment.id)).port;
    }
    if (agent === "codex") {
      const status = await backend.getLocalCodexServerStatus(environment.id);
      if (status.running && status.port) return status.port;
      return (await backend.startLocalCodexServer(environment.id)).port;
    }
    const status = await backend.getLocalOpencodeServerStatus(environment.id);
    if (status.running && status.port) return status.port;
    return (await backend.startLocalOpencodeServer(environment.id)).port;
  }

  if (!environment.containerId) {
    throw new Error("Container ID is required for a containerized review");
  }
  if (agent === "claude") {
    const status = await backend.getClaudeServerStatus(environment.containerId);
    if (status.running && status.hostPort) return status.hostPort;
    return (await backend.startClaudeServer(environment.containerId)).hostPort;
  }
  if (agent === "codex") {
    const status = await backend.getCodexServerStatus(environment.containerId);
    if (status.running && status.hostPort) return status.hostPort;
    return (await backend.startCodexServer(environment.containerId)).hostPort;
  }
  const status = await backend.getOpenCodeServerStatus(environment.containerId);
  if (status.running && status.hostPort) return status.hostPort;
  return (await backend.startOpenCodeServer(environment.containerId)).hostPort;
}

export function claudeAdapter(
  client: ClaudeClient,
  workflow: LoopedReviewWorkflow,
  dependencies = {
    createSession: createClaudeSession,
    sendStructuredPrompt: sendClaudeStructuredPrompt,
    getStructuredOutput: getClaudeStructuredOutput,
    lookupSession: lookupClaudeSession,
    abortSession: abortClaudeSession,
  },
): NativeStructuredAgent {
  const phases = sessionPhases(workflow);
  return {
    provider: "claude",
    async createSession(phase, label) {
      const result = await dependencies.createSession(client, label);
      if (!result) throw new Error("Claude failed to create a native session");
      phases.set(result.sessionId, phase);
      return result.sessionId;
    },
    async send(sessionId, prompt, schema, requestId) {
      const policy = getStructuredReviewPhasePolicy(
        requireSessionPhase(phases, sessionId),
      );
      const result = await dependencies.sendStructuredPrompt(
        client,
        sessionId,
        prompt,
        schema,
        {
          model: workflow.model === "default" ? undefined : workflow.model,
          effort: workflow.reasoningEffort as ClaudeEffortLevel | undefined,
          permissionMode: policy.claudePermissionMode,
          requestId,
        },
      );
      return result
        ? { accepted: true, requestId: result.requestId }
        : {
            accepted: false,
            requestId,
            error: "Claude rejected the structured prompt",
          };
    },
    getResult: (sessionId, requestId) =>
      dependencies.getStructuredOutput(client, sessionId, requestId),
    async getStatus(sessionId) {
      const result = await dependencies.lookupSession(client, sessionId);
      if (result.kind === "missing") return "missing";
      if (result.kind === "unavailable") throw result.error;
      return result.session.status;
    },
    abort: (sessionId) => dependencies.abortSession(client, sessionId),
  };
}

export function codexAdapter(
  client: CodexClient,
  workflow: LoopedReviewWorkflow,
  dependencies = {
    createSession: createCodexSession,
    sendPrompt: sendCodexPrompt,
    getStructuredOutput: getCodexStructuredOutput,
    lookupSessionStatus: lookupCodexSessionStatus,
    abortSession: abortCodexSession,
  },
): NativeStructuredAgent {
  const phases = sessionPhases(workflow);
  return {
    provider: "codex",
    async createSession(phase, label) {
      const policy = getStructuredReviewPhasePolicy(phase);
      const result = await dependencies.createSession(client, {
        title: label,
        model: workflow.model,
        modelReasoningEffort:
          workflow.reasoningEffort as CodexReasoningEffort | undefined,
        mode: policy.codexMode,
      });
      phases.set(result.sessionId, phase);
      return result.sessionId;
    },
    async send(sessionId, prompt, schema, requestId) {
      const result = await dependencies.sendPrompt(client, sessionId, prompt, {
        requestId,
        outputSchema: schema,
      });
      if (result.outcome === "rejected") {
        return {
          accepted: false,
          requestId,
          error: `Codex rejected the structured prompt (HTTP ${result.httpStatus})`,
        };
      }
      // Unknown is intentionally treated as accepted-for-reconciliation. The
      // request ID is journaled by the bridge, and polling resolves whether the
      // turn actually ran without blindly resending it.
      return { accepted: true, requestId };
    },
    getResult: (sessionId, requestId) =>
      dependencies.getStructuredOutput(client, sessionId, requestId),
    async getStatus(sessionId) {
      const result = await dependencies.lookupSessionStatus(client, sessionId);
      if (result.kind === "missing") return "missing";
      if (result.kind === "unavailable") throw result.error;
      return result.session.status;
    },
    abort: async (sessionId) =>
      (await dependencies.abortSession(client, sessionId)).status === "accepted",
  };
}

export function openCodeAdapter(
  client: OpencodeClient,
  workflow: LoopedReviewWorkflow,
  dependencies = {
    createSession: createOpenCodeSession,
    sendStructuredPrompt: sendOpenCodeStructuredPrompt,
    getStructuredOutput: getOpenCodeStructuredOutput,
    lookupSessionStatus: lookupOpenCodeSessionStatus,
    abortSession: abortOpenCodeSession,
  },
): NativeStructuredAgent {
  const phases = sessionPhases(workflow);
  return {
    provider: "opencode",
    async createSession(phase, label) {
      const sessionId = (await dependencies.createSession(client, label)).id;
      phases.set(sessionId, phase);
      return sessionId;
    },
    async send(sessionId, prompt, schema, requestId) {
      const policy = getStructuredReviewPhasePolicy(
        requireSessionPhase(phases, sessionId),
      );
      const result = await dependencies.sendStructuredPrompt(
        client,
        sessionId,
        prompt,
        schema,
        {
          model: workflow.model === "default" ? undefined : workflow.model,
          variant: workflow.reasoningEffort,
          mode: policy.openCodeMode,
          requestId,
        },
      );
      return {
        accepted: result.success,
        requestId: result.requestId ?? requestId,
        error: result.error,
      };
    },
    getResult: (sessionId, requestId) =>
      dependencies.getStructuredOutput(client, sessionId, requestId),
    async getStatus(sessionId) {
      const result = await dependencies.lookupSessionStatus(client, sessionId);
      if (result.kind === "missing") return "missing";
      if (result.kind === "unavailable") throw result.error;
      return result.status === "busy" || result.status === "retry"
        ? "running"
        : "idle";
    },
    abort: (sessionId) => dependencies.abortSession(client, sessionId),
  };
}

export async function connectStructuredReviewAgent(
  workflow: LoopedReviewWorkflow,
  environment: Environment,
): Promise<NativeStructuredAgent> {
  const port = await resolveProviderPort(workflow.agent, environment);
  const baseUrl = `http://127.0.0.1:${port}`;
  if (workflow.agent === "claude") {
    const client = createClaudeClient(baseUrl);
    if (!await checkClaudeHealth(client)) {
      throw new Error("Claude native bridge health check failed");
    }
    return claudeAdapter(client, workflow);
  }
  if (workflow.agent === "codex") {
    const client = createCodexClient(baseUrl);
    if (!await checkCodexHealth(client)) {
      throw new Error("Codex native bridge health check failed");
    }
    return codexAdapter(client, workflow);
  }
  return openCodeAdapter(
    createOpenCodeClient(
      baseUrl,
      environment.environmentType === "local"
        ? environment.worktreePath
        : undefined,
    ),
    workflow,
  );
}
