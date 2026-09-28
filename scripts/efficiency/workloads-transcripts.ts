/**
 * Bridge-side transcript workloads: conditional reads (E03), trimming (E09),
 * unobserved Cursor streaming (E01) and the v1/v2 live window (E06).
 *
 * Each workload calls the real exported functions of the root it measures.
 * Where a baseline root predates an API, the case measures the path that root
 * actually served (named in its description) or reports itself unsupported.
 */
import { countingMessages, gzipBytes, jsonBytes, newTally, type VisitTally } from "./counters.js";
import {
  dataUrlImagePart,
  diffPart,
  idsDigest,
  manyPartMessage,
  rewrittenHistory,
  textMessage,
  textMessages,
  toolResultPart,
  type FixtureMessage,
} from "./fixtures.js";
import type { CaseDefinition, WorkloadContext, WorkloadDefinition } from "./harness.js";

/** Display ceilings the workloads run under; see `TRANSCRIPT_ENVIRONMENT`. */
export const CURSOR_PI_CEILING_BYTES = 256 * 1024;
/** ACP's configurable floor: it cannot be lowered to 256 KiB. */
export const ACP_CEILING_BYTES = 1024 * 1024;

/**
 * Environment the bridge config modules read at import time. `run.ts` sets
 * these before any repository module is loaded — the same testable overrides
 * the review's probes used, never raising a production cap.
 */
export const TRANSCRIPT_ENVIRONMENT: Record<string, string> = {
  CURSOR_BRIDGE_MAX_TRANSCRIPT_BYTES: String(CURSOR_PI_CEILING_BYTES),
  PI_BRIDGE_MAX_TRANSCRIPT_BYTES: String(CURSOR_PI_CEILING_BYTES),
  ACP_MAX_TRANSCRIPT_BYTES: String(ACP_CEILING_BYTES),
};

type Json = Record<string, unknown>;
type UpdateFn = (messages: readonly unknown[], options: Json) => Json;

const LIVE_LIMIT = 100;
const LIVE_TARGET_BYTES = 512 * 1024;

function readOptions(extra: Json = {}): Json {
  return {
    sessionIdentity: "synthetic-session",
    generation: 1,
    contentEpoch: 1,
    limit: LIVE_LIMIT,
    targetBytes: LIVE_TARGET_BYTES,
    complete: true,
    ...extra,
  };
}

/** Serialization visits of the second, unchanged read after a first one. */
function unchangedRead(
  tally: VisitTally,
  first: () => Json,
  second: (token: string) => Json,
): { status: string; messageVisits: number } {
  const initial = first();
  tally.messages = 0;
  const repeated = second(String(initial.token));
  return { status: String(repeated.status), messageVisits: tally.messages };
}

// --- (a) Unchanged transcript read ----------------------------------------------

export async function unchangedReadWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const progressive = await context.load<{ bridgeTranscriptUpdate: UpdateFn }>(
    "packages/protocol/src/progressive-transcript.ts",
  );
  const routes = await context.loadOptional<{
    bridgeTranscriptRouteBody: (source: Json, query: (name: string) => string | undefined) => Json;
  }>("packages/protocol/src/bridge-transcript-routes.ts");
  const claudeRevision = await context.loadOptional<{
    readTranscriptVersion: (session: Json) => { epoch: number; revision: number };
    markTranscriptChanged: (session: Json) => void;
  }>("bridges/claude-bridge/src/services/transcript-revision.ts");
  const update = progressive.bridgeTranscriptUpdate;
  const cases: CaseDefinition[] = [];

  for (const count of [100, 1_000]) {
    const build = () => {
      const tally = newTally();
      return { tally, history: countingMessages(textMessages(count, 8 * 1024), tally) };
    };
    for (const revision of [undefined, 1] as const) {
      const name = revision === undefined ? "no-revision" : "revision";
      cases.push({
        id: `v1-${name}-n${count}`,
        description: `bridgeTranscriptUpdate, ${count} × 8 KiB messages, knownToken unchanged, ${name}`,
        run: async () => {
          const { tally, history } = build();
          const options = readOptions(revision === undefined ? {} : { revision });
          const started = performance.now();
          const result = unchangedRead(
            tally,
            () => update(history, options),
            (token) => update(history, { ...options, knownToken: token }),
          );
          return { counters: result, measuredMs: performance.now() - started };
        },
      });
    }

    // Claude's route: the baseline passed no revision (session.ts at e8fbf1d0);
    // HEAD reads the session's (epoch, revision) and uses the shared route body.
    const claudeQuery = (version: "1" | "2", token?: string) => (name: string) =>
      ({
        limit: String(LIVE_LIMIT),
        targetBytes: String(LIVE_TARGET_BYTES),
        knownToken: token,
        version,
      })[name];
    const claudeRead = (version: "1" | "2") => async () => {
      const { tally, history } = build();
      const started = performance.now();
      let result: { status: string; messageVisits: number };
      if (routes && claudeRevision) {
        const session: Json = { messages: history, title: "Synthetic" };
        claudeRevision.markTranscriptChanged(session);
        const source = () => {
          const current = claudeRevision.readTranscriptVersion(session);
          return {
            messages: history,
            sessionIdentity: "synthetic-session",
            generation: "g1",
            contentEpoch: `hydrated:${current.epoch}`,
            revision: current.revision,
            complete: true,
            freshness: "current",
            title: "Synthetic",
          };
        };
        result = unchangedRead(
          tally,
          () => routes.bridgeTranscriptRouteBody(source(), claudeQuery(version)),
          (token) => routes.bridgeTranscriptRouteBody(source(), claudeQuery(version, token)),
        );
      } else {
        const options = readOptions({
          generation: "g1",
          contentEpoch: "hydrated",
          freshness: "current",
          title: "Synthetic",
        });
        result = unchangedRead(
          tally,
          () => update(history, options),
          (token) => update(history, { ...options, knownToken: token }),
        );
      }
      return { counters: result, measuredMs: performance.now() - started };
    };
    cases.push({
      id: `claude-route-v1-n${count}`,
      description:
        routes && claudeRevision
          ? "Claude route equivalent: transcript revision + shared route body (v1 query)"
          : "Claude route equivalent at baseline: bridgeTranscriptUpdate without a revision",
      run: claudeRead("1"),
    });
    cases.push({
      id: `claude-route-v2-n${count}`,
      description: "Claude route equivalent, version=2 summary query",
      ...(routes && claudeRevision
        ? { run: claudeRead("2") }
        : { unsupportedReason: "v2 summary route does not exist at this revision" }),
    });
    cases.push({
      id: `rewritten-n${count}`,
      description: "revision path after a rewrite (new epoch): must answer a snapshot",
      run: async () => {
        const { tally, history } = build();
        const first = update(history, readOptions({ revision: 1 }));
        const rewritten = countingMessages(
          rewrittenHistory(history, count - 10, 12, 8 * 1024),
          tally,
        );
        tally.messages = 0;
        const started = performance.now();
        const second = update(
          rewritten,
          readOptions({ revision: 2, contentEpoch: 2, knownToken: first.token }),
        );
        const measuredMs = performance.now() - started;
        const value = second.value as { messages?: unknown[] } | undefined;
        return {
          counters: {
            status: String(second.status),
            messageVisits: tally.messages,
            messagesReturned: value?.messages?.length ?? 0,
          },
          measuredMs,
        };
      },
    });
  }

  return {
    id: "a-unchanged-read",
    title: "Unchanged transcript read: revision vs no revision",
    findings: ["E03"],
    fixture: { messageCounts: "100,1000", contentBytes: 8 * 1024, prose: "ascii" },
    method:
      "Second read with the first read's token; message visits counted by a non-enumerable toJSON (validation.md probe method).",
    cases,
  };
}

// --- (b) Trimming ---------------------------------------------------------------

interface BoundModule {
  boundTranscript: (state: Json) => boolean;
}
interface SessionModule {
  newSessionState: () => Json;
}

function trimCounters(
  tally: VisitTally,
  messages: FixtureMessage[],
): Record<string, number | string> {
  const partIds = messages.flatMap((message) =>
    message.parts.map((part) => String(part.sourcePartId ?? "")),
  );
  return {
    messageVisits: tally.messages,
    partVisits: tally.parts,
    keptMessages: messages.length,
    keptParts: partIds.length,
    retainedMessageIds: idsDigest(messages.map((message) => message.id)),
    retainedPartIds: idsDigest(partIds),
  };
}

export async function trimmingWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const cursorSession = await context.load<SessionModule>(
    "bridges/cursor-bridge/src/agent-session.ts",
  );
  const cursor = await context.load<BoundModule>("bridges/cursor-bridge/src/transcript.ts");
  const piSession = await context.load<SessionModule>("bridges/pi-bridge/src/agent-session.ts");
  const pi = await context.load<BoundModule>("bridges/pi-bridge/src/transcript.ts");
  const acp = await context.load<BoundModule>("bridges/acp-bridge/src/acp-transcript.ts");
  const window = await context.load<{
    boundTranscriptResponse: (
      messages: unknown[],
      targetBytes: number,
      options: Json,
    ) => { messages: FixtureMessage[] };
  }>("packages/protocol/src/transcript-window.ts");

  const fixtures = {
    messages: (bytes: number) => textMessages(100, bytes),
    parts: (count: number, bytes: number) => [manyPartMessage("mp", count, bytes)],
  };
  const bridgeCase = (
    id: string,
    description: string,
    newState: () => Json,
    bound: BoundModule,
    build: () => FixtureMessage[],
  ): CaseDefinition => ({
    id,
    description,
    run: async () => {
      const tally = newTally();
      const state = newState();
      state.messages = countingMessages(build(), tally, { parts: true });
      state.uncheckedTranscriptBytes = 1;
      const started = performance.now();
      bound.boundTranscript(state);
      const measuredMs = performance.now() - started;
      return {
        counters: trimCounters(tally, state.messages as FixtureMessage[]),
        measuredMs,
      };
    },
  });
  const acpState = (): Json => ({
    messages: [],
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    uncheckedTranscriptBytes: 0,
    status: "running",
  });
  const sharedCase = (id: string, build: () => FixtureMessage[]): CaseDefinition => ({
    id,
    description: "shared boundTranscriptResponse helper at the same ceiling",
    run: async () => {
      const tally = newTally();
      const messages = countingMessages(build(), tally, { parts: true });
      const started = performance.now();
      const bounded = window.boundTranscriptResponse(messages, CURSOR_PI_CEILING_BYTES, {
        envelopeReserveBytes: 0,
      });
      const measuredMs = performance.now() - started;
      return { counters: trimCounters(tally, bounded.messages), measuredMs };
    },
  });

  return {
    id: "b-trimming",
    title: "Trimming: bridge bound functions and the shared helper",
    findings: ["E09"],
    fixture: {
      messagesCase: "100 messages × 8 KiB at 256 KiB (ACP: 100 × 16 KiB at its 1 MiB floor)",
      partsCase: "1 message × 400 parts × 1 KiB at 256 KiB (ACP: 480 × 4 KiB at 1 MiB)",
    },
    method:
      "One bound pass over a fresh over-budget state; message and part visits counted by non-enumerable toJSON; retained ids digested for parity.",
    cases: [
      bridgeCase(
        "cursor-messages",
        "Cursor boundTranscript",
        cursorSession.newSessionState,
        cursor,
        () => fixtures.messages(8 * 1024),
      ),
      bridgeCase("pi-messages", "Pi boundTranscript", piSession.newSessionState, pi, () =>
        fixtures.messages(8 * 1024),
      ),
      bridgeCase("acp-messages", "ACP boundTranscript", acpState, acp, () =>
        fixtures.messages(16 * 1024),
      ),
      sharedCase("shared-messages", () => fixtures.messages(8 * 1024)),
      bridgeCase(
        "cursor-parts",
        "Cursor boundTranscript, one many-part message",
        cursorSession.newSessionState,
        cursor,
        () => fixtures.parts(400, 1024),
      ),
      bridgeCase(
        "pi-parts",
        "Pi boundTranscript, one many-part message",
        piSession.newSessionState,
        pi,
        () => fixtures.parts(400, 1024),
      ),
      bridgeCase("acp-parts", "ACP boundTranscript, one many-part message", acpState, acp, () =>
        fixtures.parts(480, 4 * 1024),
      ),
      sharedCase("shared-parts", () => fixtures.parts(400, 1024)),
    ],
  };
}

// --- (c) Background Cursor stream ------------------------------------------------

export async function cursorStreamWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const session = await context.load<SessionModule>("bridges/cursor-bridge/src/agent-session.ts");
  const translate = await context.load<{
    applyInteractionUpdate: (state: Json, update: Json) => void;
  }>("bridges/cursor-bridge/src/translate.ts");
  const transcript = await context.load<{ boundTranscriptForRead: (state: Json) => void }>(
    "bridges/cursor-bridge/src/transcript.ts",
  );
  const blocks = 600;
  return {
    id: "c-cursor-stream",
    title: "Background Cursor stream with no reader",
    findings: ["E01"],
    fixture: { reasoningBlocks: blocks, blockBytes: 1024, ceilingBytes: CURSOR_PI_CEILING_BYTES },
    method:
      "Real translator (applyInteractionUpdate) with no read route; parts sampled every update, bytes every 50 updates; then one read-side bound.",
    cases: [
      {
        id: "unobserved-600x1KiB",
        description: "600 thinking-delta/thinking-completed pairs, then boundTranscriptForRead",
        repetitions: 3,
        run: async () => {
          const state = session.newSessionState();
          state.status = "running";
          const newestParts = () =>
            ((state.messages as FixtureMessage[]).at(-1)?.parts.length ?? 0) as number;
          let peakParts = 0;
          let peakBytes = 0;
          const started = performance.now();
          for (let index = 0; index < blocks; index += 1) {
            translate.applyInteractionUpdate(state, {
              type: "thinking-delta",
              text: "x".repeat(1024),
            });
            translate.applyInteractionUpdate(state, { type: "thinking-completed" });
            peakParts = Math.max(peakParts, newestParts());
            if (index % 50 === 49) peakBytes = Math.max(peakBytes, jsonBytes(state.messages));
          }
          const measuredMs = performance.now() - started;
          const streamParts = newestParts();
          const streamBytes = jsonBytes(state.messages);
          transcript.boundTranscriptForRead(state);
          return {
            counters: {
              retainedPartsNoReader: streamParts,
              retainedBytesNoReader: streamBytes,
              peakPartsNoReader: peakParts,
              peakSampledBytesNoReader: Math.max(peakBytes, streamBytes),
              droppedParts: Number(state.droppedParts ?? 0),
              retainedPartsAfterReadBound: newestParts(),
              retainedBytesAfterReadBound: jsonBytes(state.messages),
            },
            measuredMs,
          };
        },
      },
    ],
  };
}

// --- (e) v1 vs v2 bridge window ------------------------------------------------

/** 100 messages with large tool results, diffs, inline images and prose. */
export function heavyArtifactHistory(): FixtureMessage[] {
  return Array.from({ length: 100 }, (_, index) => {
    const message = textMessage(index, 2 * 1024, {
      kind: index % 2 === 0 ? "ascii" : "multibyte",
      role: "assistant",
    });
    if (index % 10 === 5) message.parts = [toolResultPart(`t${index}`, 64 * 1024)];
    else if (index === 33 || index === 77)
      message.parts = [dataUrlImagePart(`i${index}`, 192 * 1024)];
    else if (index % 30 === 12) message.parts = [diffPart(`d${index}`, 600)];
    return message;
  });
}

export async function bridgeWindowWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const progressive = await context.load<{ bridgeTranscriptUpdate: UpdateFn }>(
    "packages/protocol/src/progressive-transcript.ts",
  );
  const summary = await context.loadOptional<{ bridgeTranscriptSummaryUpdate: UpdateFn }>(
    "packages/protocol/src/bridge-transcript-summary.ts",
  );
  const windowCounters = (response: Json) => {
    const value = (response.value ?? {}) as {
      messages?: Array<{ parts?: Array<{ detail?: { bytes?: number } }> }>;
      messageWindow?: { omittedMessages?: number; omittedParts?: number; truncated?: boolean };
    };
    const messages = value.messages ?? [];
    const details = messages.flatMap((message) =>
      (message.parts ?? []).filter((part) => part.detail !== undefined),
    );
    return {
      decodedBytes: jsonBytes(response),
      gzipBytes: gzipBytes(response),
      messagesRetained: messages.length,
      omittedMessages: value.messageWindow?.omittedMessages ?? 0,
      omittedParts: value.messageWindow?.omittedParts ?? 0,
      detailReferences: details.length,
      deferredDetailBytes: details.reduce((total, part) => total + (part.detail?.bytes ?? 0), 0),
    };
  };
  const read = (update: UpdateFn, extra: Json) => async () => {
    const history = heavyArtifactHistory();
    const started = performance.now();
    const response = update(history, readOptions({ revision: 1, ...extra }));
    const measuredMs = performance.now() - started;
    return { counters: windowCounters(response), measuredMs };
  };
  return {
    id: "e-bridge-window",
    title: "Bridge live window: v1 raw vs v2 summary",
    findings: ["E06"],
    fixture: {
      messages: 100,
      proseBytes: 2 * 1024,
      toolResults: "10 × 64 KiB",
      images: "2 × 192 KiB data URL",
      diffs: "3 × 600 changed lines",
      window: "100 messages / 512 KiB",
    },
    method:
      "One snapshot read; decoded bytes = UTF-8 JSON of the envelope, gzip at level 6 as a transport indicator.",
    cases: [
      {
        id: "v1-window",
        description: "bridgeTranscriptUpdate (v1 raw)",
        run: read(progressive.bridgeTranscriptUpdate, {}),
      },
      {
        id: "v2-summary-window",
        description: "bridgeTranscriptSummaryUpdate (v2 summary, pages)",
        ...(summary
          ? { run: read(summary.bridgeTranscriptSummaryUpdate, { pages: true }) }
          : { unsupportedReason: "v2 summaries do not exist at this revision" }),
      },
    ],
  };
}
