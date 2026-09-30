import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { NativeAgentNotice } from "@orkestrator/protocol/native-agent";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import type { BridgeConnection } from "./agent-provider-contract.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { asRecord, assertSdkResponse } from "./agent-provider-runtime.js";
import { openCodeMessagesWithActionFailures } from "./opencode-action-failures.js";
import { openCodeMessageIdScope } from "./opencode-provider-helpers.js";
import { OpenCodeReviewSessionPermissions } from "./opencode-review-session-permissions.js";
import { OpenCodeSessionLifecycle } from "./opencode-session-lifecycle.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";
import { OpenCodeWorkflowResultBroker } from "./opencode-workflow-result-broker.js";

/** Coordinates action-retry aborts with the same lock used by prompt dispatch. */
export class OpenCodeActionRetryCoordinator {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly failures = new Set<string>();
  private readonly completed = new Set<string>();

  constructor(
    private readonly connection: BridgeConnection,
    private readonly client: OpencodeClient,
    private readonly messageIds: OpenCodeMessageIdCoordinator,
    private readonly streamState: OpenCodeStreamState,
    private readonly lifecycle: OpenCodeSessionLifecycle,
    private readonly workflowResults: OpenCodeWorkflowResultBroker,
    private readonly reviewPermissions: OpenCodeReviewSessionPermissions,
    private readonly requestOptions: () => { signal: AbortSignal },
    private readonly changed: (sessionId: string) => void,
  ) {}

  observeStatus(sessionId: string, status: "running" | "idle" | "missing"): void {
    if (status !== "running" || !this.streamState.turnFailure(sessionId)) {
      this.failures.delete(sessionId);
      this.completed.delete(sessionId);
    }
  }

  requestAbort(sessionId: string): void {
    if (this.tasks.has(sessionId) || this.completed.has(sessionId)) return;
    const scope = openCodeMessageIdScope(this.connection, sessionId);
    // Reserve the dispatch lock before returning to the SSE loop. A send that
    // follows this event cannot start until the old turn's abort has settled.
    const task = this.messageIds
      .runExclusive(scope, async () => {
        const failure = this.streamState.turnFailure(sessionId);
        if (!failure || !this.lifecycle.ownedSessions.has(sessionId)) return;
        try {
          await this.workflowResults.recordActionFailure(sessionId, failure.message);
          await this.workflowResults.abort(
            sessionId,
            () => this.streamState.endTurn(sessionId),
            () => this.reviewPermissions.restoreIfNeeded(sessionId),
            { alreadyLocked: true },
          );
          this.failures.delete(sessionId);
          this.completed.add(sessionId);
        } catch (error) {
          this.failures.add(sessionId);
          console.warn(
            "[opencode-provider] Automatic retry abort failed:",
            error instanceof Error ? error.name : "unknown error",
          );
          // The abort response alone does not prove whether OpenCode stopped.
          await this.lifecycle.readSessionLifecycle([sessionId], true, true).catch(() => undefined);
        }
      })
      .catch((error) => {
        this.failures.add(sessionId);
        console.warn(
          "[opencode-provider] Automatic retry abort could not be scheduled:",
          error instanceof Error ? error.name : "unknown error",
        );
      })
      .finally(() => {
        if (this.tasks.get(sessionId) === task) this.tasks.delete(sessionId);
        this.changed(sessionId);
      });
    this.tasks.set(sessionId, task);
  }

  async guardSend(sessionId: string): Promise<void> {
    if (!this.failures.has(sessionId)) return;
    const lifecycle = await this.lifecycle.readSessionLifecycle([sessionId], false);
    if (lifecycle.get(sessionId) === "running") {
      throw new ProviderUnavailableError("OpenCode is still retrying; the abort did not complete");
    }
    this.failures.delete(sessionId);
  }

  beginTurn(sessionId: string): void {
    this.completed.delete(sessionId);
  }

  reconciled(sessionId: string): void {
    this.failures.delete(sessionId);
  }

  isPending(sessionId: string): boolean {
    return this.tasks.has(sessionId);
  }

  isUnsettled(sessionId: string): boolean {
    return this.tasks.has(sessionId) || this.failures.has(sessionId);
  }

  notices(sessionId: string): NativeAgentNotice[] {
    const notices = this.streamState.notices(sessionId);
    const pending = this.tasks.has(sessionId);
    const failed = this.failures.has(sessionId);
    if (!pending && !failed) return notices;
    const failure = this.streamState.turnFailure(sessionId);
    return [
      ...notices.filter((notice) => notice !== failure),
      {
        kind: "advisory",
        severity: "warning",
        message: failed
          ? "OpenCode could not stop the retry. Waiting for another abort attempt."
          : "OpenCode is stopping the retry.",
      },
    ];
  }

  async messagesWithFailures(sessionId: string, messages: unknown[]): Promise<unknown[]> {
    const hasAbortedMessage = messages.some(
      (message) =>
        asRecord(asRecord(asRecord(message)?.info)?.error)?.name === "MessageAbortedError",
    );
    if (!hasAbortedMessage) return messages;
    const response = await this.client.session.get(
      { sessionID: sessionId, directory: this.connection.directory },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode action failure metadata read");
    return openCodeMessagesWithActionFailures(asRecord(response.data) ?? {}, messages);
  }

  forget(sessionId: string): void {
    this.failures.delete(sessionId);
    this.completed.delete(sessionId);
  }
}
