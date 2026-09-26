import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { asRecord, assertSdkResponse } from "./agent-provider-runtime.js";
import { boundedOwnedOpenCodeCollection } from "./opencode-snapshots.js";
import type { OpenCodeWorkflowResultBroker } from "./opencode-workflow-result-broker.js";

/**
 * Ordinary tab close of one OpenCode session (`OpenCodeProvider.closeSession`,
 * reached from tab teardown through the native agent service). Non-destructive: OpenCode's
 * `DELETE /session/:id` removes the session and all of its data, so it is
 * never called here; the conversation stays listed for deliberate resume.
 *
 * 1. Abort the owned turn through the provider's abort path, which settles
 *    workflow-turn ownership. A 404 is the server's answer for a session it no
 *    longer has, so the close is already done (same as tab teardown).
 * 2. Restore temporary reviewer permissions even when no workflow turn was
 *    left unsettled.
 * 3. Reject every permission and question still pending for this session.
 *    Neither the pinned SDK (1.18.32: abort returns a boolean) nor the server
 *    docs promise that abort withdraws them, so close fails closed: a request
 *    answered after the close would be answering for a tab that is gone. A
 *    read or rejection failure rejects the close so the durable intent stays;
 *    a 404 on a rejection means it was answered or withdrawn meanwhile.
 *
 * The caller forgets its own registration afterwards.
 */
export async function closeOpenCodeSessionRetaining(
  client: OpencodeClient,
  directory: string | undefined,
  sessionId: string,
  steps: {
    broker: Pick<OpenCodeWorkflowResultBroker, "abort">;
    endTurn: () => void;
    restoreReviewer: () => Promise<unknown>;
    requestOptions: () => { signal: AbortSignal };
  },
): Promise<void> {
  const aborted = await steps.broker.abort(sessionId, steps.endTurn, steps.restoreReviewer, {
    missingIsGone: true,
  });
  if (aborted === "missing") return;
  await steps.restoreReviewer();
  try {
    const closing = new Set([sessionId]);
    const [permissions, questions] = await Promise.all([
      client.permission.list({ directory }, steps.requestOptions()),
      client.question.list({ directory }, steps.requestOptions()),
    ]);
    assertSdkResponse(permissions, "OpenCode pending permission read");
    assertSdkResponse(questions, "OpenCode pending question read");
    const pendingIds = (value: unknown, operation: string): string[] =>
      boundedOwnedOpenCodeCollection(value, closing, operation).flatMap((entry) => {
        const id = asRecord(entry)?.id;
        return typeof id === "string" ? [id] : [];
      });
    for (const requestId of pendingIds(permissions.data, "OpenCode pending permission read")) {
      const response = await client.permission.reply(
        { requestID: requestId, directory, reply: "reject" },
        steps.requestOptions(),
      );
      if (response.response?.status !== 404) {
        assertSdkResponse(response, "OpenCode permission rejection on close");
      }
    }
    for (const requestId of pendingIds(questions.data, "OpenCode pending question read")) {
      const response = await client.question.reject(
        { requestID: requestId, directory },
        steps.requestOptions(),
      );
      if (response.response?.status !== 404) {
        assertSdkResponse(response, "OpenCode question rejection on close");
      }
    }
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError("OpenCode pending requests could not be rejected", {
      cause: error,
    });
  }
}
