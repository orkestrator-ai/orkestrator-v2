import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_LIMITS,
  isAgentInteractionResolution,
  type AgentInteractionApplyOutcome,
  type AgentInteractionQuestion,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import {
  type BridgeConnection,
  ProviderUnavailableError,
  type ProviderSessionRegistration,
} from "./agent-provider-contract.js";
import {
  asRecord,
  boundedText,
  InteractionSnapshotTracker,
  isTransientHttpStatus,
  MAX_TRACKED_PROVIDER_INTERACTIONS,
  nonEmptyString,
  opaqueOptionId,
  outcome,
  requestCreatedAt,
  setBoundedMapEntry,
  truncatedJoinedText,
  truncatedText,
} from "./agent-provider-runtime.js";
import { assertOk, boundedJson, bridgeFetch } from "./http-bridge-transport.js";

const MCP_FORM_CONTENT_QUESTION_ID = "mcp-form-content";
const MAX_RENDERED_FILE_CHANGES = 48;
const MAX_RENDERED_FILE_CHANGE_TEXT_LENGTH = 256;

export class HttpBridgeInteractionAdapter {
  private readonly interactionTracker = new InteractionSnapshotTracker();
  private readonly providerInteractionIds = new Map<
    string,
    { providerRequestId: string; sessionId: string; actionable?: boolean }
  >();
  private readonly resolvingInteractions = new Set<string>();

  constructor(
    readonly agent: "claude" | "codex" | "cursor" | "grok" | "pi",
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {}

  registerSession(sessionId: string, interaction?: ProviderSessionRegistration): void {
    this.interactionTracker.register(sessionId, interaction);
  }

  private normalizedId(sessionId: string, providerRequestId: string, category: string): string {
    if (
      sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength ||
      providerRequestId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) {
      throw new ProviderUnavailableError(
        `${this.agent} returned an oversized interaction identity`,
      );
    }
    const id = `${this.agent}:${category}:${encodeURIComponent(sessionId)}:${providerRequestId}`;
    if (id.length > AGENT_INTERACTION_LIMITS.maxIdLength) {
      throw new ProviderUnavailableError(
        `${this.agent} returned an oversized interaction identity`,
      );
    }
    return id;
  }

  private interactionRequest(
    sessionId: string,
    providerRequestId: string,
    category: string,
    input: Omit<
      AgentInteractionRequest,
      "version" | "id" | "provider" | "origin" | "sessionId" | "state" | "revision"
    >,
  ): AgentInteractionRequest {
    const id = this.normalizedId(sessionId, providerRequestId, category);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: this.agent,
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      ...input,
    };
  }

  private mapClaudeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const questions = request?.questions;
    const expiresAt = request?.expiresAt;
    if (
      !request ||
      !providerRequestId ||
      !Array.isArray(questions) ||
      questions.length === 0 ||
      questions.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest ||
      (expiresAt !== undefined && !Number.isSafeInteger(expiresAt))
    ) {
      throw new ProviderUnavailableError("Claude returned a malformed question request");
    }
    const mapped: AgentInteractionQuestion[] = questions.map((entry, questionIndex) => {
      const question = asRecord(entry);
      const options = question?.options;
      const prompt = nonEmptyString(question?.question);
      if (
        !question ||
        !prompt ||
        !Array.isArray(options) ||
        options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
      ) {
        throw new ProviderUnavailableError("Claude returned a malformed question request");
      }
      return {
        id: `q${questionIndex}`,
        prompt: boundedText(prompt, prompt),
        description:
          question.header === undefined ? undefined : truncatedText(question.header, "Question"),
        required: true,
        multiple: question.multiSelect === true,
        secret: false,
        allowFreeText: true,
        options: options.map((entry, optionIndex) => {
          const option = asRecord(entry);
          const label = nonEmptyString(option?.label);
          const rawProviderValue =
            option && "value" in option ? nonEmptyString(option.value) : label;
          if (!option || !label || !rawProviderValue) {
            throw new ProviderUnavailableError("Claude returned a malformed question option");
          }
          const providerValue = boundedText(
            rawProviderValue,
            rawProviderValue,
            AGENT_INTERACTION_LIMITS.maxProviderValueLength,
          );
          return {
            id: opaqueOptionId(questionIndex, optionIndex),
            label: boundedText(label, label),
            providerValue,
            description:
              option?.description === undefined
                ? undefined
                : truncatedText(option.description, "Option"),
          };
        }),
      };
    });
    const id = this.normalizedId(sessionId, providerRequestId, "question");
    const createdAt = Number.isSafeInteger(expiresAt)
      ? requestCreatedAt(expiresAt as number, Date.now())
      : this.interactionTracker.firstSeen(id);
    const expiry = Number.isSafeInteger(expiresAt)
      ? (expiresAt as number)
      : createdAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    return this.interactionRequest(sessionId, providerRequestId, "question", {
      kind: "question",
      presentation: { title: "Claude needs input", questions: mapped },
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiry,
    });
  }

  private mapClaudeApproval(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const expiresAt = request?.expiresAt;
    const rawPlan = request?.plan;
    const planTruncated = request?.planTruncated;
    if (
      !providerRequestId ||
      (expiresAt !== undefined && !Number.isSafeInteger(expiresAt)) ||
      (rawPlan !== undefined && typeof rawPlan !== "string") ||
      (planTruncated !== undefined && typeof planTruncated !== "boolean")
    ) {
      throw new ProviderUnavailableError("Claude returned a malformed plan approval");
    }
    const plan =
      typeof rawPlan === "string" && rawPlan.trim().length > 0
        ? truncatedText(rawPlan, rawPlan)
        : null;
    const planWasTruncated =
      planTruncated === true ||
      (typeof rawPlan === "string" && rawPlan.length > AGENT_INTERACTION_LIMITS.maxTextLength);
    const actionable = plan !== null && !planWasTruncated;
    const id = this.normalizedId(sessionId, providerRequestId, "plan");
    const createdAt = Number.isSafeInteger(expiresAt)
      ? requestCreatedAt(expiresAt as number, Date.now())
      : this.interactionTracker.firstSeen(id);
    const expiry = Number.isSafeInteger(expiresAt)
      ? (expiresAt as number)
      : createdAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    const mapped = this.interactionRequest(sessionId, providerRequestId, "plan", {
      kind: "plan-approval",
      presentation: {
        title: actionable
          ? "Approve Claude's plan"
          : plan
            ? "Claude's plan is too large to approve"
            : "Claude's plan is unavailable for approval",
        body:
          plan ??
          "Claude asked to leave plan mode without providing a readable plan. Approval is disabled.",
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
        confirmDisabled: !actionable,
        planAvailable: plan !== null,
      },
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiry,
    });
    const identity = this.providerInteractionIds.get(mapped.id);
    if (identity) identity.actionable = actionable;
    return mapped;
  }

  private mapCodexApproval(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.approvalId);
    const requestedAt = request?.requestedAt;
    const expiresAt = request?.expiresAt;
    if (
      !request ||
      !providerRequestId ||
      !Number.isSafeInteger(requestedAt) ||
      !Number.isSafeInteger(expiresAt)
    ) {
      throw new ProviderUnavailableError("Codex returned a malformed approval request");
    }
    const providerKind = request?.kind;
    const kind =
      providerKind === "command"
        ? "command-approval"
        : providerKind === "file-change"
          ? "file-approval"
          : providerKind === "permissions"
            ? "permission"
            : null;
    if (!kind) throw new ProviderUnavailableError("Codex returned an unknown approval kind");
    const command = nonEmptyString(request.command);
    const cwd = nonEmptyString(request.cwd);
    const reason = nonEmptyString(request.reason);
    const grantRoot = nonEmptyString(request.grantRoot);
    const networkHost = nonEmptyString(request.networkHost);
    const rawChanges = Array.isArray(request.changes) ? request.changes : [];
    const changes = rawChanges.slice(0, MAX_RENDERED_FILE_CHANGES).map((rawChange) => {
      const change = asRecord(rawChange);
      const path = nonEmptyString(change?.path);
      if (!change || !path) {
        throw new ProviderUnavailableError("Codex returned a malformed file change");
      }
      const changeKind = nonEmptyString(change.kind) ?? "update";
      return truncatedText(
        `${changeKind}: ${path}`,
        "File change",
        MAX_RENDERED_FILE_CHANGE_TEXT_LENGTH,
      );
    });
    const hiddenChangeCount = rawChanges.length - changes.length;
    const permissions = asRecord(request.permissions);
    const requestedPermissions = permissions
      ? [
          permissions.network === true ? "network" : null,
          permissions.fileSystem === true ? "file system" : null,
        ].filter((entry): entry is string => entry !== null)
      : [];
    const inferredActionable =
      kind === "command-approval"
        ? command !== null
        : kind === "file-approval"
          ? rawChanges.length > 0
          : requestedPermissions.length > 0;
    const actionable = inferredActionable && request.actionable !== false;
    const body = truncatedJoinedText([
      ...(reason ? [`Reason: ${boundedText(reason, "Reason")}`] : []),
      ...(command ? [`Command: ${boundedText(command, "Command")}`] : []),
      ...(cwd ? [`Working directory: ${boundedText(cwd, "Working directory")}`] : []),
      ...changes.map((change) => `Change: ${change}`),
      ...(hiddenChangeCount > 0 ? [`… and ${hiddenChangeCount} more files`] : []),
      ...(requestedPermissions.length > 0
        ? [`Permissions: ${requestedPermissions.join(", ")}`]
        : []),
      ...(grantRoot ? [`Grant root: ${boundedText(grantRoot, "Grant root")}`] : []),
      ...(networkHost ? [`Network host: ${boundedText(networkHost, "Network host")}`] : []),
      ...(!actionable ? ["Approval is missing actionable operation details."] : []),
    ]);
    const mapped = this.interactionRequest(sessionId, providerRequestId, "approval", {
      kind,
      presentation: {
        title:
          kind === "command-approval"
            ? "Approve command"
            : kind === "file-approval"
              ? "Approve file changes"
              : "Approve permissions",
        body: body === undefined ? undefined : boundedText(body, "Approval requested"),
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
        confirmDisabled: !actionable,
        ...(request.supportsApproveForSession === true
          ? { approveForSessionLabel: "Approve for session" }
          : {}),
      },
      createdAt: requestedAt as number,
      updatedAt: requestedAt as number,
      expiresAt: expiresAt as number,
    });
    const identity = this.providerInteractionIds.get(mapped.id);
    if (identity) identity.actionable = actionable;
    return mapped;
  }

  private mapAcpApproval(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    // Older ACP bridges exposed the same approval envelope as Codex. Keep the
    // read boundary compatible while normalizing both generations to the
    // shared interaction contract.
    if (nonEmptyString(request?.approvalId)) {
      return this.mapCodexApproval(sessionId, raw);
    }
    const providerRequestId = nonEmptyString(request?.id);
    const title = nonEmptyString(request?.title);
    const options = request?.options;
    if (
      !request ||
      !providerRequestId ||
      !title ||
      !Array.isArray(options) ||
      options.length === 0 ||
      options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
    ) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed approval`);
    }
    const id = this.normalizedId(sessionId, providerRequestId, "approval");
    const createdAt = Number.isSafeInteger(request.requestedAt)
      ? (request.requestedAt as number)
      : this.interactionTracker.firstSeen(id);
    const expiresAt = Number.isSafeInteger(request.expiresAt)
      ? (request.expiresAt as number)
      : createdAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    return this.interactionRequest(sessionId, providerRequestId, "approval", {
      kind: "permission",
      presentation: {
        title: boundedText(title, "Approval requested"),
        questions: [
          {
            id: "decision",
            prompt: "Choose how the agent should proceed",
            required: true,
            multiple: false,
            secret: false,
            allowFreeText: false,
            options: options.map((entry, optionIndex) => {
              const option = asRecord(entry);
              const optionId = nonEmptyString(option?.optionId);
              const label = nonEmptyString(option?.name);
              if (!option || !optionId || !label) {
                throw new ProviderUnavailableError(
                  `${this.agent} returned a malformed approval option`,
                );
              }
              return {
                id: opaqueOptionId(0, optionIndex),
                label: boundedText(label, label),
                providerValue: boundedText(
                  optionId,
                  optionId,
                  AGENT_INTERACTION_LIMITS.maxProviderValueLength,
                ),
              };
            }),
          },
        ],
        confirmLabel: "Continue",
        declineLabel: "Deny",
      },
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    });
  }

  private mapCodexInteraction(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.interactionId);
    const requestedAt = request?.requestedAt;
    const expiresAt = request?.expiresAt;
    const kind = request?.kind;
    if (
      !request ||
      !providerRequestId ||
      !Number.isSafeInteger(requestedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      (kind !== "question" && kind !== "mcp-form" && kind !== "mcp-url")
    ) {
      throw new ProviderUnavailableError("Codex returned a malformed interaction request");
    }
    const questions: AgentInteractionQuestion[] =
      kind === "question"
        ? this.mapCodexQuestions(request.questions)
        : kind === "mcp-form"
          ? [this.mapCodexMcpForm(request.schema)]
          : [];
    const url = kind === "mcp-url" ? nonEmptyString(request.url) : null;
    if (kind === "mcp-url" && !url) {
      throw new ProviderUnavailableError("Codex returned a malformed URL elicitation");
    }
    return this.interactionRequest(sessionId, providerRequestId, "interaction", {
      kind,
      presentation: {
        title:
          kind === "question"
            ? "Codex needs input"
            : kind === "mcp-form"
              ? "MCP server needs input"
              : "MCP authorization",
        body:
          request.message === undefined ? undefined : truncatedText(request.message, "MCP request"),
        questions,
        url: url === null ? undefined : boundedText(url, "MCP URL"),
        confirmLabel: "Continue",
        declineLabel: "Decline",
      },
      createdAt: requestedAt as number,
      updatedAt: requestedAt as number,
      expiresAt: expiresAt as number,
    });
  }

  private mapCodexMcpForm(schemaValue: unknown): AgentInteractionQuestion {
    const schema = asRecord(schemaValue) ?? {};
    const serializedSchema = JSON.stringify(schema);
    if (
      !serializedSchema ||
      new TextEncoder().encode(serializedSchema).byteLength > AGENT_INTERACTION_LIMITS.maxTextLength
    ) {
      throw new ProviderUnavailableError("Codex returned an oversized MCP form schema");
    }
    return {
      id: MCP_FORM_CONTENT_QUESTION_ID,
      prompt: "Enter a JSON object matching the MCP form schema",
      description: serializedSchema,
      required: true,
      multiple: false,
      secret: false,
      allowFreeText: true,
      options: [],
    };
  }

  private mapCodexQuestions(value: unknown): AgentInteractionQuestion[] {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
    ) {
      throw new ProviderUnavailableError("Codex returned malformed questions");
    }
    return value.map((entry, questionIndex) => {
      const question = asRecord(entry);
      const providerQuestionId = nonEmptyString(question?.id);
      const prompt = nonEmptyString(question?.question);
      const options = question?.options ?? [];
      if (
        !providerQuestionId ||
        !prompt ||
        providerQuestionId.length > AGENT_INTERACTION_LIMITS.maxIdLength ||
        !Array.isArray(options) ||
        options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
      ) {
        throw new ProviderUnavailableError("Codex returned malformed questions");
      }
      return {
        id: providerQuestionId,
        prompt: boundedText(prompt, prompt),
        description:
          question?.header === undefined ? undefined : truncatedText(question.header, "Question"),
        required: true,
        // request_user_input serializes every answer as an array, but each
        // Codex option list is mutually exclusive. Wire shape is not choice
        // semantics; normalize that distinction before the shared UI.
        multiple: false,
        secret: question?.isSecret === true,
        allowFreeText: question?.isOther === true || options.length === 0,
        options: options.map((entry, optionIndex) => {
          const option = asRecord(entry);
          const label = nonEmptyString(option?.label);
          if (!option || !label) {
            throw new ProviderUnavailableError("Codex returned a malformed question option");
          }
          return {
            id: opaqueOptionId(questionIndex, optionIndex),
            label: boundedText(label, label),
            providerValue: boundedText(
              label,
              label,
              AGENT_INTERACTION_LIMITS.maxProviderValueLength,
            ),
            description:
              option?.description === undefined
                ? undefined
                : truncatedText(option.description, "Option"),
          };
        }),
      };
    });
  }

  async listPendingInteractions(sessionId: string): Promise<AgentInteractionSnapshot> {
    const paths =
      this.agent === "claude"
        ? (["questions", "plan-approvals"] as const)
        : (["approvals", "interactions"] as const);
    const responses = await Promise.all(
      paths.map((path) =>
        bridgeFetch(
          this.connection,
          `/session/${encodeURIComponent(sessionId)}/${path}`,
          {},
          this.fetchImpl,
        ),
      ),
    );
    if (responses.every((response) => response.status === 404)) {
      return this.interactionTracker.snapshot(sessionId, []);
    }
    for (const response of responses) assertOk(response, `${this.agent} interaction snapshot`);
    const snapshotBudget = {
      remaining: AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes,
    };
    const payloads = await Promise.all(
      responses.map((response) =>
        boundedJson(response, `${this.agent} interaction snapshot`, snapshotBudget),
      ),
    );
    const first = asRecord(payloads[0]);
    const second = asRecord(payloads[1]);
    const firstRequests = first?.[this.agent === "claude" ? "questions" : "approvals"];
    const secondRequests = second?.[this.agent === "claude" ? "approvals" : "interactions"];
    if (!Array.isArray(firstRequests) || !Array.isArray(secondRequests)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed interaction snapshot`);
    }
    const requests: AgentInteractionRequest[] = [];
    let droppedRequests = 0;
    const mapRequest = (
      raw: unknown,
      mapper: (request: unknown) => AgentInteractionRequest,
    ): void => {
      if (requests.length >= AGENT_INTERACTION_LIMITS.maxPendingRequests) {
        droppedRequests += 1;
        return;
      }
      try {
        requests.push(mapper(raw));
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError)) throw error;
        droppedRequests += 1;
      }
    };
    if (this.agent === "claude") {
      for (const request of firstRequests) {
        mapRequest(request, (raw) => this.mapClaudeQuestion(sessionId, raw));
      }
      for (const request of secondRequests) {
        mapRequest(request, (raw) => this.mapClaudeApproval(sessionId, raw));
      }
    } else if (this.agent === "cursor" || this.agent === "grok") {
      for (const request of firstRequests) {
        mapRequest(request, (raw) => this.mapAcpApproval(sessionId, raw));
      }
      // ACP currently has no second interaction family. Keep reading the
      // endpoint so a future bridge can add one without losing requests, but
      // reject non-empty unknown payloads instead of pretending they vanished.
      if (secondRequests.length > 0) droppedRequests += secondRequests.length;
    } else {
      // Codex and Pi. The Pi bridge serves the same approval payload shape and
      // an always-empty second family, so it needs no branch of its own — the
      // mappers below are named for where the shape came from, not for the one
      // agent that produces it.
      for (const request of firstRequests) {
        mapRequest(request, (raw) => this.mapCodexApproval(sessionId, raw));
      }
      for (const request of secondRequests) {
        mapRequest(request, (raw) => this.mapCodexInteraction(sessionId, raw));
      }
    }
    if (droppedRequests > 0) {
      console.warn(
        `[native-agent] Dropped ${droppedRequests} unmappable ${this.agent} interaction request(s)`,
      );
      if (requests.length === 0) {
        throw new ProviderUnavailableError(
          `${this.agent} returned no mappable interaction requests`,
        );
      }
    }
    const snapshot = this.interactionTracker.snapshot(sessionId, requests);
    const currentIds = new Set(snapshot.requests.map((request) => request.id));
    for (const [interactionId, identity] of this.providerInteractionIds) {
      if (identity.sessionId === sessionId && !currentIds.has(interactionId)) {
        this.providerInteractionIds.delete(interactionId);
      }
    }
    return snapshot;
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
    this.resolvingInteractions.add(interactionId);
    try {
      let target: { path: string; method: "POST" | "DELETE"; body?: string };
      try {
        target = await this.httpResolutionTarget(
          sessionId,
          identity.providerRequestId,
          request,
          resolution,
        );
      } catch {
        return outcome("rejected", sessionId, interactionId, snapshot.revision);
      }
      let response: Response;
      try {
        response = await bridgeFetch(
          this.connection,
          target.path,
          { method: target.method, body: target.body },
          this.fetchImpl,
        );
      } catch (error) {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
        if (reconciled && !reconciled.requests.some((item) => item.id === interactionId)) {
          return outcome("applied", sessionId, interactionId, reconciled.revision);
        }
        return outcome("provider-unavailable", sessionId, interactionId, snapshot.revision);
      }
      if (response.status === 409 || response.status === 404) {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => snapshot);
        return outcome("stale", sessionId, interactionId, reconciled.revision);
      }
      if (!response.ok) {
        return outcome(
          isTransientHttpStatus(response.status) ? "provider-unavailable" : "rejected",
          sessionId,
          interactionId,
          snapshot.revision,
        );
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

  private async httpResolutionTarget(
    sessionId: string,
    providerRequestId: string,
    request: AgentInteractionRequest,
    resolution: AgentInteractionResolution,
  ): Promise<{ path: string; method: "POST" | "DELETE"; body?: string }> {
    const base = `/session/${encodeURIComponent(sessionId)}`;
    if (this.agent === "claude") {
      if (request.kind === "question") {
        if (resolution.action !== "answer") {
          return {
            path: `${base}/questions/${encodeURIComponent(providerRequestId)}`,
            method: "DELETE",
          };
        }
        const byQuestion = new Map(
          resolution.answer?.answers.map((answer) => [answer.questionId, answer]),
        );
        const answers = request.presentation.questions.map((question) => {
          const answer = byQuestion.get(question.id)!;
          const options = new Map(
            question.options.map((option) => [option.id, option.providerValue]),
          );
          return [
            ...(answer.optionIds ?? []).map((id) => options.get(id)!),
            ...(answer.freeText === undefined ? [] : [answer.freeText]),
          ];
        });
        return {
          path: `${base}/questions/${encodeURIComponent(providerRequestId)}/answer`,
          method: "POST",
          body: JSON.stringify({ answers }),
        };
      }
      return {
        path: `${base}/plan-approvals/${encodeURIComponent(providerRequestId)}/respond`,
        method: "POST",
        body: JSON.stringify({
          approved: resolution.action === "answer",
          ...(resolution.feedback ? { feedback: resolution.feedback } : {}),
        }),
      };
    }

    if (this.agent === "cursor" || this.agent === "grok") {
      if (request.kind !== "permission") {
        throw new ProviderUnavailableError("ACP returned an unsupported interaction kind");
      }
      if (request.presentation.questions.length === 0) {
        return {
          path: `${base}/approvals/${encodeURIComponent(providerRequestId)}`,
          method: "POST",
          body: JSON.stringify({
            decision: resolution.action === "answer" ? "approve" : "deny",
          }),
        };
      }
      const answer =
        resolution.action === "answer"
          ? resolution.answer?.answers.find(
              (candidate) => candidate.questionId === request.presentation.questions[0]?.id,
            )
          : undefined;
      const selectedId = answer?.optionIds?.[0];
      const providerValue =
        selectedId === undefined
          ? undefined
          : request.presentation.questions[0]?.options.find((option) => option.id === selectedId)
              ?.providerValue;
      if (resolution.action === "answer" && !providerValue) {
        throw new ProviderUnavailableError("ACP approval option is missing");
      }
      return {
        path: `${base}/approvals/${encodeURIComponent(providerRequestId)}`,
        method: "POST",
        body: JSON.stringify(providerValue ? { optionId: providerValue } : {}),
      };
    }

    if (
      request.kind === "command-approval" ||
      request.kind === "file-approval" ||
      request.kind === "permission"
    ) {
      return {
        path: `${base}/approvals/${encodeURIComponent(providerRequestId)}`,
        method: "POST",
        body: JSON.stringify({
          decision:
            resolution.action === "answer"
              ? "approve"
              : resolution.action === "approve-for-session"
                ? "approve-for-session"
                : resolution.action === "cancel"
                  ? "cancel"
                  : "deny",
        }),
      };
    }
    const answerBody: Record<string, unknown> = {
      action:
        resolution.action === "answer"
          ? "accept"
          : resolution.action === "cancel"
            ? "cancel"
            : "decline",
    };
    if (resolution.action === "answer" && request.kind === "mcp-form") {
      const rawContent = resolution.answer!.answers.find(
        (answer) => answer.questionId === MCP_FORM_CONTENT_QUESTION_ID,
      )?.freeText;
      let content: unknown;
      try {
        content = rawContent === undefined ? null : JSON.parse(rawContent);
      } catch {
        throw new ProviderUnavailableError("MCP form content must be valid JSON");
      }
      if (!asRecord(content)) {
        throw new ProviderUnavailableError("MCP form content must be a JSON object");
      }
      answerBody.content = content;
    } else if (resolution.action === "answer" && request.kind === "question") {
      answerBody.answers = Object.fromEntries(
        request.presentation.questions.map((question) => {
          const answer = resolution.answer!.answers.find(
            (candidate) => candidate.questionId === question.id,
          )!;
          const options = new Map(
            question.options.map((option) => [option.id, option.providerValue]),
          );
          return [
            question.id,
            [
              ...(answer.optionIds ?? []).map((id) => options.get(id)!),
              ...(answer.freeText === undefined ? [] : [answer.freeText]),
            ],
          ];
        }),
      );
    }
    return {
      path: `${base}/interactions/${encodeURIComponent(providerRequestId)}`,
      method: "POST",
      body: JSON.stringify(answerBody),
    };
  }
}
