import {
  NATIVE_AGENT_BRANCH_LIST_LIMITS,
  type NativeAgentSessionActionOutcome,
  type NativeAgentSessionBranch,
  type NativeAgentSessionBranchList,
} from "@orkestrator/protocol/native-agent";
import { ProviderUnavailableError, type BridgeConnection } from "../agent-provider-contract.js";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";
import {
  assertOkWithErrorDetail,
  boundedJson,
  bridgeFetch,
  throwBridgeResponseError,
} from "./transport.js";

/**
 * A Pi session's other branches (`GET /session/:id/branches`), bounded and
 * validated entry by entry: a malformed branch is dropped, a malformed list
 * fails. The entry ids are what `switch-branch` sends back.
 */
export async function readBridgeSessionBranches(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  sessionId: string,
): Promise<NativeAgentSessionBranchList> {
  const response = await bridgeFetch(
    connection,
    `/session/${encodeURIComponent(sessionId)}/branches`,
    {},
    fetchImpl,
  );
  await assertOkWithErrorDetail(response, "Pi branch list");
  const payload = asRecord(
    await boundedJson(response, "Pi branch list", { remaining: 256 * 1024 }),
  );
  if (!payload || !Array.isArray(payload.branches)) {
    throw new ProviderUnavailableError("Pi returned a malformed branch list");
  }
  const limits = NATIVE_AGENT_BRANCH_LIST_LIMITS;
  const branches = payload.branches.flatMap((candidate): NativeAgentSessionBranch[] => {
    const branch = asRecord(candidate);
    const entryId = nonEmptyString(branch?.entryId);
    if (!entryId || entryId.length > limits.entryIdChars) return [];
    const prompt = typeof branch?.prompt === "string" ? branch.prompt : "";
    const entries = Number.isSafeInteger(branch?.entries) ? (branch!.entries as number) : 0;
    return [
      {
        entryId,
        prompt: prompt.length > limits.promptChars ? prompt.slice(0, limits.promptChars) : prompt,
        entries: Math.max(0, entries),
        updatedAt: nonEmptyString(branch?.updatedAt) ?? "",
      },
    ];
  });
  const activeEntryId = nonEmptyString(payload.activeEntryId);
  return {
    activeEntryId:
      activeEntryId && activeEntryId.length <= limits.entryIdChars ? activeEntryId : null,
    branches: branches.slice(0, limits.branches),
    truncated: payload.truncated === true || branches.length > limits.branches,
  };
}

/** The switch answer is a few fields; anything larger is not one. */
const SWITCH_ANSWER_MAX_BYTES = 16 * 1024;

/**
 * Switch a Pi session to another branch (`POST /session/:id/branches/:entryId`).
 *
 * `summarize` asks Pi to summarize the branch being left first, which is a
 * model call, so the body is sent only then: an ordinary switch is the same
 * bodyless request as before and never costs one. A summarized switch gets
 * the `branch-summary` budget, longer than the bridge's cancellation deadline,
 * to give Pi time to settle. A switch someone
 * stopped (409 `cancelled: true`) is reported in the bridge's own words: the
 * conversation stayed where it was, which reads as "retry", not "report".
 */
export async function switchBridgeSessionBranch(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  sessionId: string,
  entryId: string,
  summarize: boolean,
): Promise<NativeAgentSessionActionOutcome> {
  const response = await bridgeFetch(
    connection,
    `/session/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}`,
    { method: "POST", ...(summarize ? { body: JSON.stringify({ summarize: true }) } : {}) },
    fetchImpl,
    summarize ? "branch-summary" : "default",
  );
  const operation = "Pi branch switch";
  const parsed = boundedJson(response, operation, { remaining: SWITCH_ANSWER_MAX_BYTES });
  const payload = asRecord(await (response.ok ? parsed : parsed.catch(() => undefined)));
  if (!response.ok) {
    if (response.status === 422 && payload?.kind === "branch-summary-failed") {
      // Older bridges could return raw provider diagnostics in this field.
      throw new Error(
        payload.reason === "prompt-leaf"
          ? "This branch ends on a prompt with no reply, so a summary cannot follow it. Switch without a summary."
          : "Pi could not summarize the branch being left. The conversation stayed on its branch. You can retry or switch without a summary.",
      );
    }
    throwBridgeResponseError(
      response.status,
      operation,
      payload,
      response.status === 409 && payload?.cancelled === true,
    );
  }
  // A bridge that predates summaries ignores the body and answers without
  // `summarized`: the switch happened, the summary did not.
  return summarize
    ? { outcome: "applied", summarized: payload?.summarized === true }
    : { outcome: "applied" };
}
