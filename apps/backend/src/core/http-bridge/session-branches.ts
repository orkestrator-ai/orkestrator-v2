import {
  NATIVE_AGENT_BRANCH_LIST_LIMITS,
  type NativeAgentSessionBranch,
  type NativeAgentSessionBranchList,
} from "@orkestrator/protocol/native-agent";
import { ProviderUnavailableError, type BridgeConnection } from "../agent-provider-contract.js";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";
import { assertOkWithErrorDetail, boundedJson, bridgeFetch } from "./transport.js";

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
