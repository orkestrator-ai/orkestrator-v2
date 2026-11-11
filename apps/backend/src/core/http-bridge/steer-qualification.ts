import { randomUUID } from "node:crypto";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { BridgeConnection } from "../agent-provider-contract.js";
import { asRecord } from "../agent-provider-runtime.js";
import type { HttpBridgeAgent } from "./catalog.js";
import { boundedJson, bridgeFetch } from "./transport.js";

const log = createLogger("native-agent");

/**
 * How long a positive qualification is trusted without asking again. A bridge
 * restart changes the connection's port and token, which drops the answer at
 * once; this bound is for a bridge that loses steer support in place.
 */
export const STEER_QUALIFICATION_POSITIVE_TTL_MS = 60_000;
/** Sessions whose positive answer is kept; the oldest is dropped beyond this. */
export const STEER_QUALIFICATION_CACHE_MAX_SESSIONS = 256;

/**
 * Qualification and failure logging for one bridge connection.
 *
 * `readProgressiveSessionState` asks on every state poll, and the answer only
 * changes when the bridge does (to-do 6680 task 5). A positive answer is
 * cached per session for the connection's current bridge generation (its base
 * URL and token, read on every call because a workflow provider adopts a
 * refreshed connection in place) and for at most
 * {@link STEER_QUALIFICATION_POSITIVE_TTL_MS}. A refusal is never cached: the
 * next call probes again, so a bridge that gains steer is seen at once and a
 * failing one keeps being reported.
 */
export class HttpBridgeSteerQualification {
  /** Opaque so one connection's recovery cannot clear another's fault. */
  private readonly logScope: string;
  private readonly qualified = new Map<string, { generation: string; until: number }>();

  constructor(
    private readonly agent: HttpBridgeAgent,
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.logScope = `${agent}:${randomUUID()}`;
  }

  /** Drop a cached positive, for a session the bridge no longer knows. */
  forget(sessionId: string): void {
    this.qualified.delete(sessionId);
  }

  async supported(sessionId: string): Promise<boolean> {
    const generation = `${this.connection.baseUrl}\0${this.connection.authToken}`;
    const cached = this.qualified.get(sessionId);
    if (cached && cached.generation === generation && this.now() < cached.until) return true;
    this.qualified.delete(sessionId);
    const answer = await this.probe(sessionId);
    if (answer) {
      this.qualified.set(sessionId, {
        generation,
        until: this.now() + STEER_QUALIFICATION_POSITIVE_TTL_MS,
      });
      while (this.qualified.size > STEER_QUALIFICATION_CACHE_MAX_SESSIONS) {
        const oldest = this.qualified.keys().next().value;
        if (oldest === undefined) break;
        this.qualified.delete(oldest);
      }
    }
    return answer;
  }

  private async probe(sessionId: string): Promise<boolean> {
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
