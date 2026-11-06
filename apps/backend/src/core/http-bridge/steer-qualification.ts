import { randomUUID } from "node:crypto";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { BridgeConnection } from "../agent-provider-contract.js";
import { asRecord } from "../agent-provider-runtime.js";
import type { HttpBridgeAgent } from "./catalog.js";
import { boundedJson, bridgeFetch } from "./transport.js";

const log = createLogger("native-agent");

/** Uncached qualification and failure logging for one bridge connection. */
export class HttpBridgeSteerQualification {
  /** Opaque so one connection's recovery cannot clear another's fault. */
  private readonly logScope: string;

  constructor(
    private readonly agent: HttpBridgeAgent,
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.logScope = `${agent}:${randomUUID()}`;
  }

  async supported(sessionId: string): Promise<boolean> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/steer/dispatch` +
        `?requestId=${encodeURIComponent("orkestrator-steer-qualification")}`,
      {},
      this.fetchImpl,
    ).catch((error: unknown) => {
      // `message: false` because a fetch error can quote the session's URL.
      log.throttled("warn", "steer.qualification-failed", {
        scope: this.logScope,
        error,
        fields: () => ({
          agent: this.agent,
          error: formatLogError(error, { message: false, stack: false }),
        }),
      });
      return null;
    });
    if (!response) return false;
    if (!response.ok) {
      this.noteRefused(`http-${response.status}`, response.status);
      return false;
    }
    const body = asRecord(
      await boundedJson(response, `${this.agent} steer qualification`).catch(() => null),
    );
    if (body?.dispatch !== "unknown" && body?.dispatch !== "dispatched") {
      this.noteRefused("unexpected-answer", response.status);
      return false;
    }
    log.recovered("steer.qualification-failed", this.logScope);
    return true;
  }

  private noteRefused(kind: string, status: number): void {
    log.throttled("warn", "steer.qualification-failed", {
      scope: this.logScope,
      kind,
      fields: () => ({ agent: this.agent, status }),
    });
  }
}
