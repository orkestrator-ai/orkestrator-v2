/**
 * `POST /session/:id/compact` on an HTTP bridge, with optional instructions.
 *
 * Instructions travel as `{ "instructions": "…" }` and only when there are
 * some, so a plain compaction sends exactly what it always did. A bridge that
 * honours them answers `instructions: "applied"`; one that predates them
 * ignores the body and still compacts. That answer is the only way to tell the
 * two apart, and it arrives after the compaction ran, so a missing marker is
 * reported as `instructionsIgnored` on an applied outcome — never as a
 * failure, which would invite a second compaction.
 */
import {
  nativeAgentCapabilities,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import { createLogger } from "@orkestrator/protocol/logger";
import { PromptRejectedError, type BridgeConnection } from "../agent-provider-contract.js";
import type { HttpBridgeAgent } from "./catalog.js";
import { assertOkWithErrorDetail, boundedJson, bridgeFetch } from "./transport.js";
import { asRecord } from "../agent-provider-runtime.js";
import { compatibilityPathUsage } from "../compatibility-path-usage.js";

const log = createLogger("native-agent");

/** The compact answer is a few fields; anything larger is not one. */
const COMPACT_ANSWER_MAX_BYTES = 16 * 1024;

export async function compactBridgeSession(input: {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
  instructions?: string;
}): Promise<NativeAgentSessionActionOutcome> {
  const instructions = input.instructions?.trim() || undefined;
  if (instructions && nativeAgentCapabilities(input.agent).actions?.compactInstructions !== true) {
    // The backend refuses this before it gets here; never send text a
    // provider would silently drop.
    throw new PromptRejectedError(`${input.agent} cannot take compaction instructions`);
  }
  const response = await bridgeFetch(
    input.connection,
    `/session/${encodeURIComponent(input.sessionId)}/compact`,
    {
      method: "POST",
      ...(instructions ? { body: JSON.stringify({ instructions }) } : {}),
    },
    input.fetchImpl,
  );
  // A compaction someone stopped (Pi answers 409 `cancelled: true`) is shown
  // in the bridge's own words: it did not run, and saying it "failed" with a
  // status code would read as something to report rather than retry.
  const stopped =
    response.status === 409 &&
    asRecord(
      await boundedJson(response.clone(), `${input.agent} session compaction`, {
        remaining: COMPACT_ANSWER_MAX_BYTES,
      }).catch(() => undefined),
    )?.cancelled === true;
  await assertOkWithErrorDetail(response, `${input.agent} session compaction`, {
    detailAlone: stopped,
  });
  if (!instructions) {
    await response.body?.cancel().catch(() => undefined);
    return { outcome: "applied" };
  }
  let applied = false;
  try {
    const answer = asRecord(
      await boundedJson(response, `${input.agent} session compaction`, {
        remaining: COMPACT_ANSWER_MAX_BYTES,
      }),
    );
    applied = answer?.instructions === "applied";
  } catch {
    // An unreadable answer confirms nothing; the compaction itself succeeded.
  }
  if (applied) return { outcome: "applied" };
  compatibilityPathUsage.record("compact.instructions-ignored");
  log.warn("compact.instructions-ignored", { agent: input.agent });
  return { outcome: "applied", instructionsIgnored: true };
}
