import { applyLogDetail } from "./log-policy.js";
import { logDetailEnablesBridgeDiagnostics, parseBridgeLogPolicy } from "../log-policy.js";
import { setLiveBridgeDiagnostics } from "./bridge-diagnostics.js";

/** Far above any valid policy: 256 areas of 64 characters is about 20 KiB. */
export const MAX_BRIDGE_LOG_POLICY_BYTES = 64 * 1024;

export type BridgeLogPolicyAnswer =
  | { status: 200; body: { applied: true; seq: number; diagnostics: boolean } }
  | { status: 200; body: { applied: false; stale: true; seq: number } }
  | { status: 400; body: { error: string } };

let appliedSeq = -1;

/**
 * What `POST /debug/log-policy` does on every bridge. Only the logger's levels and
 * the diagnostics switch change: it reads no session, touches no liveness, hydrates
 * nothing and re-attaches nothing, and answers without waiting on any of them, so
 * it works while a turn is stuck.
 *
 * A retried request is applied again and answered the same. An older one is
 * refused in band: the sender re-sends past the sequence it is told about.
 */
export function applyBridgeLogPolicy(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): BridgeLogPolicyAnswer {
  const policy = parseBridgeLogPolicy(value);
  if (!policy) return { status: 400, body: { error: "Invalid log policy" } };
  if (policy.seq < appliedSeq) {
    return { status: 200, body: { applied: false, stale: true, seq: appliedSeq } };
  }
  appliedSeq = policy.seq;
  const effective = applyLogDetail(policy, env);
  const diagnostics = logDetailEnablesBridgeDiagnostics(effective);
  setLiveBridgeDiagnostics(diagnostics);
  return { status: 200, body: { applied: true, seq: policy.seq, diagnostics } };
}

/** Back to the environment's startup default; for tests. */
export function resetBridgeLogPolicyForTests(): void {
  appliedSeq = -1;
  setLiveBridgeDiagnostics(undefined);
}

/** A web `Request`'s JSON body within the bound, or null for anything else. */
export async function readBridgeLogPolicyBody(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BRIDGE_LOG_POLICY_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
