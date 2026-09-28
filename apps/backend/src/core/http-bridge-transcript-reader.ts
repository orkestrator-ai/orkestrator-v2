/**
 * The transcript reads of one HTTP bridge connection, and what that
 * connection answered about the v2 contract (`http-bridge-transcript-v2.ts`).
 * Kept out of `HttpBridgeProvider` so the provider stays a thin surface.
 */
import type {
  BridgeConnection,
  ProviderTranscriptDetail,
  ProviderTranscriptPage,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import type { HttpBridgeAgent } from "./http-bridge-catalog.js";
import {
  readHttpBridgeLegacyTranscript,
  readHttpBridgeTranscriptSnapshot,
  type LegacyTranscriptSnapshot,
} from "./http-bridge-progressive.js";
import {
  HttpBridgeTranscriptCapabilities,
  readHttpBridgeTranscriptDetail,
  readHttpBridgeTranscriptPage,
} from "./http-bridge-transcript-v2.js";

/**
 * The v2 transcript surface of one bridge connection: what it answered about
 * each feature, and the reads that depend on those answers.
 */
export class HttpBridgeTranscriptReader {
  readonly capabilities = new HttpBridgeTranscriptCapabilities();

  constructor(
    private readonly agent: HttpBridgeAgent,
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** The legacy whole-transcript read (`/messages`). */
  legacy(sessionId: string): Promise<LegacyTranscriptSnapshot> {
    return readHttpBridgeLegacyTranscript({
      agent: this.agent,
      connection: this.connection,
      fetchImpl: this.fetchImpl,
      sessionId,
    });
  }

  snapshot(
    sessionId: string,
    options: {
      limit: number;
      targetBytes: number;
      knownSourceToken?: string;
      representation?: "summary";
    },
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
    return readHttpBridgeTranscriptSnapshot({
      agent: this.agent,
      connection: this.connection,
      fetchImpl: this.fetchImpl,
      sessionId,
      options,
      readLegacy: () => this.legacy(sessionId),
      capabilities: this.capabilities,
    });
  }

  async detail(sessionId: string, locator: string): Promise<ProviderTranscriptDetail | undefined> {
    if (!this.capabilities.supports("details")) return undefined;
    const detail = await readHttpBridgeTranscriptDetail({
      agent: this.agent,
      connection: this.connection,
      fetchImpl: this.fetchImpl,
      sessionId,
      locator,
    });
    if (detail === undefined) this.capabilities.markUnsupported("details");
    return detail;
  }

  async page(
    sessionId: string,
    options: { cursor: string; limit: number; targetBytes: number },
  ): Promise<ProviderTranscriptPage | undefined> {
    if (!this.capabilities.supports("pages")) return undefined;
    const page = await readHttpBridgeTranscriptPage({
      agent: this.agent,
      connection: this.connection,
      fetchImpl: this.fetchImpl,
      sessionId,
      ...options,
    });
    if (page === undefined) this.capabilities.markUnsupported("pages");
    return page;
  }
}
