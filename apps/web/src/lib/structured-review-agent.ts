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
  getSession as getClaudeSession,
  getStructuredOutput as getClaudeStructuredOutput,
  sendStructuredPrompt as sendClaudeStructuredPrompt,
  type ClaudeClient,
  type ClaudeEffortLevel,
} from "@/lib/claude-client";
import {
  abortSession as abortCodexSession,
  checkHealth as checkCodexHealth,
  createClient as createCodexClient,
  createSession as createCodexSession,
  getSessionStatus as getCodexSessionStatus,
  getStructuredOutput as getCodexStructuredOutput,
  sendPrompt as sendCodexPrompt,
  type CodexClient,
  type CodexReasoningEffort,
} from "@/lib/codex-client";
import {
  abortSession as abortOpenCodeSession,
  createClient as createOpenCodeClient,
  createSession as createOpenCodeSession,
  getSessionStatus as getOpenCodeSessionStatus,
  getStructuredOutput as getOpenCodeStructuredOutput,
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
  getStatus(sessionId: string): Promise<"running" | "idle" | "error" | null>;
  abort(sessionId: string): Promise<boolean>;
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

function claudeAdapter(
  client: ClaudeClient,
  workflow: LoopedReviewWorkflow,
): NativeStructuredAgent {
  return {
    provider: "claude",
    async createSession(_phase, label) {
      const result = await createClaudeSession(client, label);
      if (!result) throw new Error("Claude failed to create a native session");
      return result.sessionId;
    },
    async send(sessionId, prompt, schema, requestId) {
      const result = await sendClaudeStructuredPrompt(
        client,
        sessionId,
        prompt,
        schema,
        {
          model: workflow.model === "default" ? undefined : workflow.model,
          effort: workflow.reasoningEffort as ClaudeEffortLevel | undefined,
          permissionMode: "bypassPermissions",
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
      getClaudeStructuredOutput(client, sessionId, requestId),
    async getStatus(sessionId) {
      const session = await getClaudeSession(client, sessionId);
      return session?.status ?? null;
    },
    abort: (sessionId) => abortClaudeSession(client, sessionId),
  };
}

function codexAdapter(
  client: CodexClient,
  workflow: LoopedReviewWorkflow,
): NativeStructuredAgent {
  return {
    provider: "codex",
    async createSession(_phase, label) {
      const result = await createCodexSession(client, {
        title: label,
        model: workflow.model,
        modelReasoningEffort:
          workflow.reasoningEffort as CodexReasoningEffort | undefined,
        mode: "build",
      });
      return result.sessionId;
    },
    async send(sessionId, prompt, schema, requestId) {
      const result = await sendCodexPrompt(client, sessionId, prompt, {
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
      getCodexStructuredOutput(client, sessionId, requestId),
    async getStatus(sessionId) {
      const status = await getCodexSessionStatus(client, sessionId, {
        throwOnError: true,
      });
      return status?.status ?? null;
    },
    abort: async (sessionId) =>
      (await abortCodexSession(client, sessionId)).status === "accepted",
  };
}

function openCodeAdapter(
  client: OpencodeClient,
  workflow: LoopedReviewWorkflow,
): NativeStructuredAgent {
  return {
    provider: "opencode",
    async createSession(_phase, label) {
      return (await createOpenCodeSession(client, label)).id;
    },
    async send(sessionId, prompt, schema, requestId) {
      const result = await sendOpenCodeStructuredPrompt(
        client,
        sessionId,
        prompt,
        schema,
        {
          model: workflow.model === "default" ? undefined : workflow.model,
          variant: workflow.reasoningEffort,
          mode: "build",
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
      getOpenCodeStructuredOutput(client, sessionId, requestId),
    async getStatus(sessionId) {
      const status = await getOpenCodeSessionStatus(client, sessionId, {
        throwOnError: true,
      });
      return status === "busy" || status === "retry"
        ? "running"
        : status === "idle"
          ? "idle"
          : null;
    },
    abort: (sessionId) => abortOpenCodeSession(client, sessionId),
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
