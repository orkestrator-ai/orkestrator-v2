import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_LIMITS,
  isAgentInteractionResolution,
  type AgentInteractionApplyOutcome,
  type AgentInteractionQuestion,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import {
  asRecord,
  assertSdkResponse,
  boundedJoinedText,
  boundedStringArray,
  boundedText,
  InteractionSnapshotTracker,
  MAX_TRACKED_PROVIDER_INTERACTIONS,
  nonEmptyString,
  opaqueOptionId,
  outcome,
  serializedByteLength,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";
import { boundedOwnedOpenCodeCollection } from "./opencode-snapshots.js";

export class OpenCodeInteractionAdapter {
  private readonly providerInteractionIds = new Map<
    string,
    { providerRequestId: string; sessionId: string; actionable?: boolean }
  >();
  private readonly resolvingInteractions = new Set<string>();

  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string | undefined,
    private readonly requestOptions: () => { signal: AbortSignal },
    private readonly interactionTracker: InteractionSnapshotTracker,
  ) {}

  private openCodeInteractionId(
    sessionId: string,
    category: "question" | "permission",
    id: string,
  ): string {
    const interactionId = `opencode:${category}:${encodeURIComponent(sessionId)}:${id}`;
    if (interactionId.length > AGENT_INTERACTION_LIMITS.maxIdLength) {
      throw new ProviderUnavailableError("OpenCode returned an oversized interaction identity");
    }
    return interactionId;
  }

  private mapOpenCodeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const rawSessionId = nonEmptyString(request?.sessionID) ?? nonEmptyString(request?.sessionId);
    const questions = request?.questions;
    if (
      !providerRequestId ||
      rawSessionId !== sessionId ||
      !Array.isArray(questions) ||
      questions.length === 0 ||
      questions.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
    ) {
      throw new ProviderUnavailableError("OpenCode returned a malformed question request");
    }
    const presentationQuestions: AgentInteractionQuestion[] = questions.map(
      (entry, questionIndex) => {
        const question = asRecord(entry);
        const options = question?.options;
        const prompt = nonEmptyString(question?.question);
        if (
          !question ||
          !prompt ||
          !Array.isArray(options) ||
          options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
        ) {
          throw new ProviderUnavailableError("OpenCode returned a malformed question request");
        }
        return {
          id: `q${questionIndex}`,
          prompt: boundedText(prompt, prompt),
          description: nonEmptyString(question.header) ?? undefined,
          required: true,
          multiple: question.multiple === true,
          secret: false,
          allowFreeText: question.custom !== false,
          options: options.map((entry, optionIndex) => {
            const option = asRecord(entry);
            const label = nonEmptyString(option?.label);
            if (!option || !label) {
              throw new ProviderUnavailableError("OpenCode returned a malformed question option");
            }
            return {
              id: opaqueOptionId(questionIndex, optionIndex),
              label: boundedText(label, label),
              providerValue: boundedText(
                label,
                label,
                AGENT_INTERACTION_LIMITS.maxProviderValueLength,
              ),
              description: nonEmptyString(option?.description) ?? undefined,
            };
          }),
        };
      },
    );
    const id = this.openCodeInteractionId(sessionId, "question", providerRequestId);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId, actionable: true },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    const createdAt = this.interactionTracker.firstSeen(id);
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: "opencode",
      kind: "question",
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      presentation: { title: "OpenCode needs input", questions: presentationQuestions },
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapOpenCodePermission(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const rawSessionId = nonEmptyString(request?.sessionID) ?? nonEmptyString(request?.sessionId);
    const permission = nonEmptyString(request?.permission) ?? nonEmptyString(request?.action);
    const patterns = boundedStringArray(request?.patterns, "permission patterns");
    const alwaysPatterns =
      request?.always === undefined
        ? []
        : boundedStringArray(request.always, "permission always patterns");
    if (!providerRequestId || rawSessionId !== sessionId || !permission) {
      throw new ProviderUnavailableError("OpenCode returned a malformed permission request");
    }
    const actionable = patterns.length > 0;
    const id = this.openCodeInteractionId(sessionId, "permission", providerRequestId);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId, actionable },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    const createdAt = this.interactionTracker.firstSeen(id);
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: "opencode",
      kind: "permission",
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      presentation: {
        title: "Approve OpenCode permission",
        body: boundedJoinedText([
          `Permission: ${boundedText(permission, "Permission requested")}`,
          ...patterns.map((pattern) => `Resource: ${pattern}`),
          ...(!actionable ? ["Permission is missing its resource scope."] : []),
        ]),
        questions: [],
        confirmLabel: "Approve once",
        ...(actionable && alwaysPatterns.length > 0
          ? { approveForSessionLabel: "Always allow" }
          : {}),
        declineLabel: "Deny",
      },
      createdAt,
      updatedAt: createdAt,
    };
  }

  async listPendingInteractions(sessionId: string): Promise<AgentInteractionSnapshot> {
    try {
      const [questionsResponse, permissionsResponse] = await Promise.all([
        this.client.question.list({ directory: this.directory }, this.requestOptions()),
        this.client.permission.list({ directory: this.directory }, this.requestOptions()),
      ]);
      assertSdkResponse(questionsResponse, "OpenCode pending question read");
      assertSdkResponse(permissionsResponse, "OpenCode pending permission read");
      const ownedSessionIds = new Set([sessionId]);
      const questions = boundedOwnedOpenCodeCollection(
        questionsResponse.data,
        ownedSessionIds,
        "OpenCode pending question read",
      );
      const permissions = boundedOwnedOpenCodeCollection(
        permissionsResponse.data,
        ownedSessionIds,
        "OpenCode pending permission read",
      );
      if (
        serializedByteLength([questions, permissions]) >
        AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
      ) {
        throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
      }
      if (questions.length + permissions.length > AGENT_INTERACTION_LIMITS.maxPendingRequests) {
        throw new ProviderUnavailableError("OpenCode returned too many interactions");
      }
      const snapshot = this.interactionTracker.snapshot(sessionId, [
        ...questions.map((request) => this.mapOpenCodeQuestion(sessionId, request)),
        ...permissions.map((request) => this.mapOpenCodePermission(sessionId, request)),
      ]);
      const currentIds = new Set(snapshot.requests.map((request) => request.id));
      for (const [interactionId, identity] of this.providerInteractionIds) {
        if (identity.sessionId === sessionId && !currentIds.has(interactionId)) {
          this.providerInteractionIds.delete(interactionId);
        }
      }
      return snapshot;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("OpenCode interactions are unavailable", {
        cause: error,
      });
    }
  }

  async resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome> {
    const knownSession = this.interactionTracker.sessionFor(interactionId);
    if (knownSession !== undefined && knownSession !== sessionId) {
      return outcome("rejected", sessionId, interactionId, 0);
    }
    const snapshot = await this.listPendingInteractions(sessionId);
    const request = snapshot.requests.find((candidate) => candidate.id === interactionId);
    if (!request) return outcome("stale", sessionId, interactionId, snapshot.revision);
    if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (!isAgentInteractionResolution(resolution, request)) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    if (this.resolvingInteractions.has(interactionId)) {
      return outcome("already-resolved", sessionId, interactionId, snapshot.revision);
    }
    const identity = this.providerInteractionIds.get(interactionId);
    if (!identity) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (
      (resolution.action === "answer" || resolution.action === "approve-for-session") &&
      identity.actionable === false
    ) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    const providerRequestId = identity.providerRequestId;
    this.resolvingInteractions.add(interactionId);
    try {
      let response: { error?: unknown };
      try {
        if (request.kind === "question") {
          if (resolution.action === "answer") {
            const byQuestion = new Map(
              resolution.answer!.answers.map((answer) => [answer.questionId, answer]),
            );
            const answers = request.presentation.questions.map((question) => {
              const answer = byQuestion.get(question.id)!;
              const optionValues = new Map(
                question.options.map((option) => [option.id, option.providerValue]),
              );
              return [
                ...(answer.optionIds ?? []).map((id) => optionValues.get(id)!),
                ...(answer.freeText === undefined ? [] : [answer.freeText]),
              ];
            });
            response = await this.client.question.reply(
              {
                requestID: providerRequestId,
                directory: this.directory,
                answers,
              },
              this.requestOptions(),
            );
          } else {
            response = await this.client.question.reject(
              {
                requestID: providerRequestId,
                directory: this.directory,
              },
              this.requestOptions(),
            );
          }
        } else {
          response = await this.client.permission.reply(
            {
              requestID: providerRequestId,
              directory: this.directory,
              reply:
                resolution.action === "approve-for-session"
                  ? "always"
                  : resolution.action === "answer"
                    ? "once"
                    : "reject",
            },
            this.requestOptions(),
          );
        }
        assertSdkResponse(response, "OpenCode interaction response");
      } catch {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
        if (reconciled && !reconciled.requests.some((item) => item.id === interactionId)) {
          return outcome("applied", sessionId, interactionId, reconciled.revision);
        }
        return outcome("provider-unavailable", sessionId, interactionId, snapshot.revision);
      }
      const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
      if (!reconciled) {
        return outcome("provider-unavailable", sessionId, interactionId, snapshot.revision);
      }
      return outcome(
        reconciled.requests.some((item) => item.id === interactionId)
          ? "provider-unavailable"
          : "applied",
        sessionId,
        interactionId,
        reconciled.revision,
      );
    } finally {
      this.resolvingInteractions.delete(interactionId);
    }
  }
}
