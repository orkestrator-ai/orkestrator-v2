import type { NativeAgentResumeEntry } from "@orkestrator/protocol/native-agent";
import { ProviderUnavailableError, type BridgeConnection } from "./agent-provider-contract.js";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import type { HttpBridgeAgent } from "./http-bridge-catalog.js";
import { assertOkWithErrorDetail, boundedJson, bridgeFetch } from "./http-bridge-transport.js";

/**
 * A bridge's resumable sessions (`GET /session/list`), bounded and validated
 * entry by entry: a malformed entry is dropped, a malformed list fails.
 * Archived conversations come back only when asked for.
 */
export async function readBridgeResumableSessions(
  agent: HttpBridgeAgent,
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  options: { includeArchived?: boolean } = {},
): Promise<NativeAgentResumeEntry[]> {
  const response = await bridgeFetch(
    connection,
    options.includeArchived ? "/session/list?includeArchived=1" : "/session/list",
    {},
    fetchImpl,
  );
  // The ACP bridge answers 410 with the reason the agent cannot list its own
  // history. Dropping that body would reduce a specific, actionable message
  // to a bare status code in front of the user.
  await assertOkWithErrorDetail(response, `${agent} resumable session list`);
  const payload = asRecord(
    await boundedJson(response, `${agent} resumable session list`, {
      remaining: 2 * 1024 * 1024,
    }),
  );
  if (!payload || !Array.isArray(payload.sessions)) {
    throw new ProviderUnavailableError(`${agent} returned a malformed session list`);
  }
  let liveCount = 0;
  let archivedCount = 0;
  return payload.sessions.flatMap((candidate) => {
    const session = asRecord(candidate);
    const id = nonEmptyString(session?.id);
    if (!id) return [];
    // Independent quotas keep archived conversations discoverable when the
    // live list fills its cap. The decoded body is already byte bounded.
    if (session?.archived === true) {
      if (archivedCount++ >= 512) return [];
    } else if (liveCount++ >= 512) return [];
    const createdAt = nonEmptyString(session?.createdAt);
    const updatedAt = nonEmptyString(session?.updatedAt) ?? nonEmptyString(session?.lastActivity);
    const status =
      session?.status === "running" || session?.status === "error" || session?.status === "idle"
        ? session.status
        : undefined;
    const messageCount = Number.isSafeInteger(session?.messageCount)
      ? (session!.messageCount as number)
      : undefined;
    const providerDetail = nonEmptyString(session?.detail);
    const parentId = nonEmptyString(session?.parentId);
    const branchLabel = nonEmptyString(session?.branchLabel);
    return [
      {
        sessionId: id,
        ...(typeof session?.title === "string" ? { title: session.title } : {}),
        ...(createdAt && Number.isFinite(Date.parse(createdAt)) ? { createdAt } : {}),
        ...(updatedAt && Number.isFinite(Date.parse(updatedAt)) ? { updatedAt } : {}),
        ...(status ? { status } : {}),
        ...(messageCount !== undefined
          ? { detail: `${messageCount} message${messageCount === 1 ? "" : "s"}` }
          : providerDetail
            ? { detail: providerDetail.slice(0, 256) }
            : {}),
        ...(parentId ? { parentId: parentId.slice(0, 512) } : {}),
        ...(branchLabel ? { branchLabel: branchLabel.slice(0, 256) } : {}),
        ...(session?.archived === true ? { archived: true } : {}),
      },
    ];
  });
}
