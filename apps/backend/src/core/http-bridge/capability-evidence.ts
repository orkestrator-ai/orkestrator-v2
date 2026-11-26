/**
 * Agent Capabilities runtime proof (`capabilities/runtime-proof.ts`): reads a
 * bridge session's no-touch `/session/:id/capability-evidence` route. The
 * Claude and Pi bridges serve it; a 404 or 405 from any bridge means the
 * bridge predates the route or its provider has no such report
 * (`unsupported`), never that the session is gone. A failed read is `none`.
 */
import {
  parseCapabilitySessionEvidence,
  type CapabilitySessionEvidenceRead,
} from "@orkestrator/protocol/capability-evidence";

import type { BridgeConnection } from "../agent-provider-contract.js";
import { boundedJson, bridgeFetch } from "./transport.js";

export async function readBridgeCapabilityEvidence(options: {
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  agent: string;
  sessionId: string;
  signal?: AbortSignal | undefined;
}): Promise<CapabilitySessionEvidenceRead> {
  try {
    const response = await bridgeFetch(
      options.connection,
      `/session/${encodeURIComponent(options.sessionId)}/capability-evidence`,
      options.signal ? { signal: options.signal } : {},
      options.fetchImpl,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return response.status === 404 || response.status === 405
        ? { state: "unsupported" }
        : { state: "none" };
    }
    const body = await boundedJson(response, `${options.agent} capability evidence read`, {
      remaining: 256 * 1024,
    });
    return parseCapabilitySessionEvidence(body);
  } catch {
    return { state: "none" };
  }
}
