import type {
  JsonSchema,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
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
  checkHealth as checkOpenCodeHealth,
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
    logicalSessionKey?: string,
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

function backendPipelinePhase(
  phase: LoopedReviewSessionPhase,
): "review" | "fix" | "pr" {
  if (phase === "fix") return "fix";
  if (phase === "pr") return "pr";
  return "review";
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

interface ClaudeAdapterDependencies {
  createSession: typeof createClaudeSession;
  sendStructuredPrompt: typeof sendClaudeStructuredPrompt;
  getStructuredOutput: typeof getClaudeStructuredOutput;
  lookupSession: typeof lookupClaudeSession;
  abortSession: typeof abortClaudeSession;
  ensureSession?: typeof backend.ensureNativeAgentSession;
}

interface CodexAdapterDependencies {
  createSession: typeof createCodexSession;
  sendPrompt: typeof sendCodexPrompt;
  getStructuredOutput: typeof getCodexStructuredOutput;
  lookupSessionStatus: typeof lookupCodexSessionStatus;
  abortSession: typeof abortCodexSession;
  ensureSession?: typeof backend.ensureNativeAgentSession;
}

interface OpenCodeAdapterDependencies {
  createSession: typeof createOpenCodeSession;
  sendStructuredPrompt: typeof sendOpenCodeStructuredPrompt;
  getStructuredOutput: typeof getOpenCodeStructuredOutput;
  lookupSessionStatus: typeof lookupOpenCodeSessionStatus;
  abortSession: typeof abortOpenCodeSession;
  ensureSession?: typeof backend.ensureNativeAgentSession;
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
): Promise<{ port: number; authToken?: string }> {
  if (environment.environmentType === "local") {
    if (agent === "claude") {
      const status = await backend.getLocalClaudeServerStatus(environment.id);
      if (status.running && status.port && status.authToken) {
        return { port: status.port, authToken: status.authToken };
      }
      const started = await backend.startLocalClaudeServer(environment.id);
      if (!started.authToken) throw new Error("Claude bridge did not return an authentication token");
      return { port: started.port, authToken: started.authToken };
    }
    if (agent === "codex") {
      const status = await backend.getLocalCodexServerStatus(environment.id);
      if (status.running && status.port && status.authToken) {
        return { port: status.port, authToken: status.authToken };
      }
      const started = await backend.startLocalCodexServer(environment.id);
      if (!started.authToken) throw new Error("Codex bridge did not return an authentication token");
      return { port: started.port, authToken: started.authToken };
    }
    const status = await backend.getLocalOpencodeServerStatus(environment.id);
    if (status.running && status.port && status.authToken) {
      return { port: status.port, authToken: status.authToken };
    }
    const started = await backend.startLocalOpencodeServer(environment.id);
    if (!started.authToken) throw new Error("OpenCode server did not return an authentication credential");
    return { port: started.port, authToken: started.authToken };
  }

  if (!environment.containerId) {
    throw new Error("Container ID is required for a containerized review");
  }
  if (agent === "claude") {
    const status = await backend.getClaudeServerStatus(environment.containerId);
    if (status.running && status.hostPort && status.authToken) {
      return { port: status.hostPort, authToken: status.authToken };
    }
    const started = await backend.startClaudeServer(environment.containerId);
    return { port: started.hostPort, authToken: started.authToken };
  }
  if (agent === "codex") {
    const status = await backend.getCodexServerStatus(environment.containerId);
    if (status.running && status.hostPort && status.authToken) {
      return { port: status.hostPort, authToken: status.authToken };
    }
    const started = await backend.startCodexServer(environment.containerId);
    return { port: started.hostPort, authToken: started.authToken };
  }
  const status = await backend.getOpenCodeServerStatus(environment.containerId);
  if (status.running && status.hostPort && status.authToken) {
    return { port: status.hostPort, authToken: status.authToken };
  }
  const started = await backend.startOpenCodeServer(environment.containerId);
  return { port: started.hostPort, authToken: started.authToken };
}

export function claudeAdapter(
  client: ClaudeClient,
  workflow: LoopedReviewWorkflow,
  dependencies: ClaudeAdapterDependencies = {
    createSession: createClaudeSession,
    sendStructuredPrompt: sendClaudeStructuredPrompt,
    getStructuredOutput: getClaudeStructuredOutput,
    lookupSession: lookupClaudeSession,
    abortSession: abortClaudeSession,
    ensureSession: backend.ensureNativeAgentSession,
  },
): NativeStructuredAgent {
  const phases = sessionPhases(workflow);
  return {
    provider: "claude",
    async createSession(phase, label, logicalSessionKey) {
      if (dependencies.ensureSession) {
        const ensured = await dependencies.ensureSession({
          environmentId: workflow.environmentId,
          agent: "claude",
          logicalSessionKey:
            logicalSessionKey
            ?? `looped-review:${workflow.id}:${phase}:${label}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          title: label,
          model: workflow.model === "default" ? undefined : workflow.model,
          reasoningEffort: workflow.reasoningEffort,
          phase: backendPipelinePhase(phase),
        });
        phases.set(ensured.providerSessionId, phase);
        return ensured.providerSessionId;
      }
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
  dependencies: CodexAdapterDependencies = {
    createSession: createCodexSession,
    sendPrompt: sendCodexPrompt,
    getStructuredOutput: getCodexStructuredOutput,
    lookupSessionStatus: lookupCodexSessionStatus,
    abortSession: abortCodexSession,
    ensureSession: backend.ensureNativeAgentSession,
  },
): NativeStructuredAgent {
  const phases = sessionPhases(workflow);
  return {
    provider: "codex",
    async createSession(phase, label, logicalSessionKey) {
      const policy = getStructuredReviewPhasePolicy(phase);
      if (dependencies.ensureSession) {
        const ensured = await dependencies.ensureSession({
          environmentId: workflow.environmentId,
          agent: "codex",
          logicalSessionKey:
            logicalSessionKey
            ?? `looped-review:${workflow.id}:${phase}:${label}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          title: label,
          model: workflow.model,
          reasoningEffort: workflow.reasoningEffort,
          phase: backendPipelinePhase(phase),
          // The phase alone is not enough: `preparation` and `discovery` both map
          // onto `review`, which the bridge would create read-only — but only
          // discovery is read-only. Preparation has to commit changes and write
          // its validation output, so the policy decides, not the phase.
          sessionMode: policy.codexMode,
        });
        phases.set(ensured.providerSessionId, phase);
        return ensured.providerSessionId;
      }
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
  dependencies: OpenCodeAdapterDependencies = {
    createSession: createOpenCodeSession,
    sendStructuredPrompt: sendOpenCodeStructuredPrompt,
    getStructuredOutput: getOpenCodeStructuredOutput,
    lookupSessionStatus: lookupOpenCodeSessionStatus,
    abortSession: abortOpenCodeSession,
    ensureSession: backend.ensureNativeAgentSession,
  },
): NativeStructuredAgent {
  const phases = sessionPhases(workflow);
  return {
    provider: "opencode",
    async createSession(phase, label, logicalSessionKey) {
      if (dependencies.ensureSession) {
        const ensured = await dependencies.ensureSession({
          environmentId: workflow.environmentId,
          agent: "opencode",
          logicalSessionKey:
            logicalSessionKey
            ?? `looped-review:${workflow.id}:${phase}:${label}`,
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          title: label,
          model: workflow.model === "default" ? undefined : workflow.model,
          reasoningEffort: workflow.reasoningEffort,
          phase: backendPipelinePhase(phase),
        });
        phases.set(ensured.providerSessionId, phase);
        return ensured.providerSessionId;
      }
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
  const { port, authToken } = await resolveProviderPort(workflow.agent, environment);
  const baseUrl = `http://127.0.0.1:${port}`;
  if (workflow.agent === "claude") {
    if (!authToken) throw new Error("Claude bridge authentication is unavailable");
    const client = createClaudeClient(baseUrl, authToken);
    if (!await checkClaudeHealth(client)) {
      throw new Error("Claude native bridge health check failed");
    }
    return claudeAdapter(client, workflow);
  }
  if (workflow.agent === "codex") {
    if (!authToken) throw new Error("Codex bridge authentication is unavailable");
    const client = createCodexClient(baseUrl, authToken);
    if (!await checkCodexHealth(client)) {
      throw new Error("Codex native bridge health check failed");
    }
    return codexAdapter(client, workflow);
  }
  if (!authToken) throw new Error("OpenCode server authentication is unavailable");
  if (!await checkOpenCodeHealth(baseUrl, authToken)) {
    throw new Error("OpenCode server health check failed");
  }
  return openCodeAdapter(
    createOpenCodeClient(
      baseUrl,
      environment.environmentType === "local"
        ? environment.worktreePath
        : undefined,
      authToken,
    ),
    workflow,
  );
}
