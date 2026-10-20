import { createHash } from "node:crypto";
import type {
  ChangeEvidenceAckRequest,
  ChangeEvidenceReadResponse,
} from "@orkestrator/protocol/change-evidence";
import {
  CHANGE_EVIDENCE_ACK_ROUTE,
  CHANGE_EVIDENCE_BODY_ROUTE,
  CHANGE_EVIDENCE_ROUTE,
} from "@orkestrator/protocol/node/change-tracking/evidence-routes";
import { isPlainRecord } from "@orkestrator/protocol/field-validation";
import type { BridgeConnection, ChangeEvidenceSourceLike } from "./agent-provider-contract.js";
import { boundedJson, bridgeFetch } from "./http-bridge-transport.js";

/** Largest evidence page or body answer accepted from a bridge. */
const MAX_EVIDENCE_RESPONSE_BYTES = 12 * 1024 * 1024;

/**
 * Client for a bridge's change-evidence spool (`/change-evidence*`).
 *
 * 404/405 means the bridge predates the routes: the change-tracking service
 * treats that as "unsupported" and rechecks later. Any other failure rejects,
 * which is not evidence about the bridge's capabilities. The source key binds
 * the cursor to this connection, so a restarted bridge (new connection
 * identity) starts from its own spool rather than an old cursor.
 */
export class HttpBridgeChangeEvidence {
  private readonly connectionKey: string;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.connectionKey = createHash("sha256")
      .update(`${connection.agent}\0${connection.baseUrl}\0${connection.accountId ?? ""}`)
      .digest("hex")
      .slice(0, 24);
  }

  source(environmentId: string): ChangeEvidenceSourceLike {
    return {
      sourceKey: `${environmentId}\0${this.connection.agent}\0${this.connectionKey}`,
      environmentId,
      provider: this.connection.agent,
      read: (cursor, epoch) => this.read(cursor, epoch),
      body: (id) => this.body(id),
      ack: (request) => this.ack(request),
    };
  }

  private async read(
    cursor: number,
    epoch: string | null,
  ): Promise<ChangeEvidenceReadResponse | "unsupported"> {
    const query = new URLSearchParams({ cursor: String(cursor), ...(epoch ? { epoch } : {}) });
    const response = await bridgeFetch(
      this.connection,
      `${CHANGE_EVIDENCE_ROUTE}?${query}`,
      { method: "GET" },
      this.fetchImpl,
    );
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel().catch(() => undefined);
      return "unsupported";
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${this.connection.agent} change-evidence read failed (${response.status})`);
    }
    const body = await boundedJson(response, `${this.connection.agent} change-evidence read`, {
      remaining: MAX_EVIDENCE_RESPONSE_BYTES,
    });
    if (
      !isPlainRecord(body) ||
      typeof body.runtimeEpoch !== "string" ||
      !Array.isArray(body.entries) ||
      !Number.isSafeInteger(body.nextCursor)
    ) {
      throw new Error(`${this.connection.agent} returned a malformed change-evidence page`);
    }
    // Entries are validated individually during ingestion; a malformed one
    // becomes an explicit gap rather than failing the whole page.
    return body as unknown as ChangeEvidenceReadResponse;
  }

  private async body(id: string): Promise<Uint8Array | null> {
    const response = await bridgeFetch(
      this.connection,
      `${CHANGE_EVIDENCE_BODY_ROUTE}?${new URLSearchParams({ id })}`,
      { method: "GET" },
      this.fetchImpl,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const parsed = await boundedJson(response, `${this.connection.agent} change-evidence body`, {
      remaining: MAX_EVIDENCE_RESPONSE_BYTES,
    }).catch(() => null);
    if (!isPlainRecord(parsed) || parsed.state !== "available" || typeof parsed.base64 !== "string")
      return null;
    return new Uint8Array(Buffer.from(parsed.base64, "base64"));
  }

  private async ack(request: ChangeEvidenceAckRequest): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      CHANGE_EVIDENCE_ACK_ROUTE,
      { method: "POST", body: JSON.stringify(request) },
      this.fetchImpl,
    );
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error("change-evidence-ack-unavailable");
  }
}

/** Per-environment evidence sources for one bridge connection. */
export function bridgeChangeEvidenceSource(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
): (environmentId: string) => ChangeEvidenceSourceLike {
  const client = new HttpBridgeChangeEvidence(connection, fetchImpl);
  return (environmentId) => client.source(environmentId);
}
