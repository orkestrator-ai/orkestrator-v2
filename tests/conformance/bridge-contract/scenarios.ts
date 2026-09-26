/**
 * Shared bridge HTTP-contract conformance scenarios (plan step 11, A and B).
 *
 * Only the contract lives here: scenario definitions, the transcript-cursor
 * table and a runner that selects scenarios from each bridge's row in
 * `capabilities.ts`. Every managed bridge owns an adapter
 * (`bridges/<name>/src/conformance-bridge-contract.test.ts`) that drives its
 * real HTTP router with its own engine-boundary fakes and private state. The
 * provider engines stay separate; nothing here knows how any of them work.
 *
 * Each scenario gets a fresh handle from the adapter and stops it in
 * `finally`, so no scenario depends on another's sessions or state files.
 * Assertions compare small, content-free JSON bodies only.
 */
import { describe, expect, test } from "bun:test";
import { BRIDGE_CONTRACT_CAPABILITIES } from "./capabilities.js";

export const BRIDGE_IDS = ["cursor", "pi", "claude", "codex", "acp"] as const;
export type BridgeId = (typeof BRIDGE_IDS)[number];

export interface ContractResponse {
  status: number;
  /** Parsed JSON body, or `undefined` when the response was not JSON. */
  body: unknown;
}

/** Occupancy of one bounded recovery structure, as runtime-health reports it. */
export interface BoundedOccupancy {
  entries: number;
  limitEntries: number;
  bytes: number;
  limitBytes: number;
  saturated: boolean;
}

/**
 * One running bridge instance, private to a single scenario.
 *
 * The optional members are capability hooks: a scenario that needs one lists
 * it in `requires`, and a bridge whose row marks that scenario supported must
 * provide it — the runner fails the scenario rather than skipping it when a
 * supported scenario's hook is missing.
 */
export interface BridgeContractHandle {
  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ContractResponse>;
  /** Create a session through the bridge's real create route. */
  createSession(options?: { clientSessionKey?: string }): Promise<string>;
  /** A prompt body this bridge accepts, carrying `requestId`. */
  promptBody(requestId: string): Record<string, unknown>;
  /**
   * Make every close of `sessionId` unable to confirm (a failed publication or
   * teardown at the engine/storage boundary) until the returned restore runs.
   */
  failCloses?(sessionId: string): Promise<() => Promise<void>>;
  /**
   * Register a session whose absolute indexes 0–1 were evicted and whose
   * retained tail is `m2`, `m3`, `m4` (`content: "message <n>"`, role user).
   */
  seedRetainedTail?(): Promise<string>;
  /**
   * Replace this bridge's in-memory registry with what a successor process
   * would load from the published state — no drain, no graceful shutdown.
   */
  restartFromPublishedState?(): Promise<void>;
  /** Drive the bridge's bounded recovery structure to its limit. */
  saturateBoundedState?(sessionId: string): Promise<void>;
  /** Pick the bounded-structure occupancy records out of a runtime-health body. */
  boundedOccupancy?(runtimeHealth: unknown): BoundedOccupancy[];
  stop(): Promise<void>;
}

export interface BridgeContractAdapter {
  bridge: BridgeId;
  start(): Promise<BridgeContractHandle>;
}

type Hook = Exclude<
  keyof BridgeContractHandle,
  "request" | "createSession" | "promptBody" | "stop"
>;

interface ContractScenario {
  id: string;
  title: string;
  requires: readonly Hook[];
  run(bridge: BridgeContractHandle): Promise<void>;
}

const encode = encodeURIComponent;
let uniqueCounter = 0;

/** A fresh id that no bridge has ever seen. */
export function unseenId(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${uniqueCounter}`;
}

const CLOSED = { closed: true, retained: true };
const MISSING = { closed: true, missing: true };

async function close(bridge: BridgeContractHandle, id: string): Promise<ContractResponse> {
  return bridge.request("POST", `/session/${encode(id)}/close`);
}

async function activity(bridge: BridgeContractHandle, id: string): Promise<unknown> {
  const response = await bridge.request("GET", `/session/${encode(id)}/activity`);
  expect(response.status).toBe(200);
  return (response.body as { activity?: unknown } | undefined)?.activity;
}

// ---------------------------------------------------------------------------
// Transcript cursor grammar
// ---------------------------------------------------------------------------

export interface TranscriptWindow {
  ids: string[];
  baseIndex: number;
  totalMessages: number;
  messageWindow: { truncated: boolean; omittedMessages?: number };
}

const RETAINED: TranscriptWindow = {
  ids: ["m2", "m3", "m4"],
  baseIndex: 2,
  totalMessages: 5,
  messageWindow: { truncated: true, omittedMessages: 2 },
};
const EMPTY_AT_END: TranscriptWindow = {
  ids: [],
  baseIndex: 5,
  totalMessages: 5,
  messageWindow: { truncated: true, omittedMessages: 5 },
};

/**
 * `GET /session/:id/messages?fromIndex=` over the seeded tail (indexes 0–1
 * evicted, 2–4 retained). `undefined` omits the query entirely.
 *
 * The grammar itself is unit-tested once, in the protocol package
 * (`parseTranscriptFromIndex`); this table proves each numeric-cursor route is
 * wired to it and selects the same observable window. Every malformed entry
 * used to be consumed by at least one bridge: `parseInt` took numeric prefixes
 * and truncated fractions, `Number` accepted exponent, hex, leading zeros and
 * surrounding whitespace. All of them now fall back to the retained tail.
 */
export const TRANSCRIPT_CURSOR_CASES: ReadonlyArray<{
  label: string;
  fromIndex: string | undefined;
  expected: TranscriptWindow;
}> = [
  { label: "missing cursor", fromIndex: undefined, expected: RETAINED },
  ...[
    "",
    "12junk",
    "3.5",
    "3.0",
    "-1",
    "+3",
    "1e3",
    "0x3",
    "03",
    " 3",
    "3\n",
    "Infinity",
    "9007199254740993",
    "9".repeat(64),
  ].map((fromIndex) => ({
    label: `malformed ${JSON.stringify(fromIndex.length > 16 ? `${fromIndex.slice(0, 8)}…` : fromIndex)}`,
    fromIndex,
    expected: RETAINED,
  })),
  { label: "valid at the eviction base", fromIndex: "2", expected: RETAINED },
  {
    label: "valid inside the tail",
    fromIndex: "3",
    expected: {
      ids: ["m3", "m4"],
      baseIndex: 3,
      totalMessages: 5,
      messageWindow: { truncated: true, omittedMessages: 3 },
    },
  },
  {
    label: "valid at the last message",
    fromIndex: "4",
    expected: {
      ids: ["m4"],
      baseIndex: 4,
      totalMessages: 5,
      messageWindow: { truncated: true, omittedMessages: 4 },
    },
  },
  { label: "valid before the eviction base (0)", fromIndex: "0", expected: RETAINED },
  { label: "valid before the eviction base (1)", fromIndex: "1", expected: RETAINED },
  { label: "valid at the end", fromIndex: "5", expected: EMPTY_AT_END },
  { label: "valid past the end", fromIndex: "99", expected: EMPTY_AT_END },
  {
    label: "largest safe integer",
    fromIndex: String(Number.MAX_SAFE_INTEGER),
    expected: EMPTY_AT_END,
  },
];

async function readWindow(
  bridge: BridgeContractHandle,
  sessionId: string,
  fromIndex: string | undefined,
): Promise<TranscriptWindow> {
  const query = fromIndex === undefined ? "" : `?fromIndex=${encode(fromIndex)}`;
  const response = await bridge.request("GET", `/session/${encode(sessionId)}/messages${query}`);
  expect(response.status).toBe(200);
  const body = response.body as {
    messages: Array<{ id: string }>;
    baseIndex: number;
    totalMessages: number;
    messageWindow: TranscriptWindow["messageWindow"];
  };
  return {
    ids: body.messages.map((message) => message.id),
    baseIndex: body.baseIndex,
    totalMessages: body.totalMessages,
    messageWindow: body.messageWindow,
  };
}

/** A runtime-health body larger than this is not bounded recovery state. */
const MAX_RUNTIME_HEALTH_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const CONTRACT_SCENARIOS = [
  {
    id: "unknown-session-in-band",
    title: "an unknown session is answered in band, never 404",
    requires: [],
    async run(bridge) {
      const id = unseenId("never-existed");
      // 404/405 on these routes may only ever mean "this bridge predates the
      // route"; the backend must be able to tell that from "this one is gone".
      expect(await bridge.request("GET", `/session/${encode(id)}/activity`)).toEqual({
        status: 200,
        body: { activity: "missing" },
      });
      expect(await close(bridge, id)).toEqual({ status: 200, body: MISSING });
    },
  },
  {
    id: "close-retains-then-missing",
    title: "close answers retained, and a repeated close answers missing in band",
    requires: [],
    async run(bridge) {
      const id = await bridge.createSession();
      expect(await activity(bridge, id)).not.toBe("missing");
      expect(await close(bridge, id)).toEqual({ status: 200, body: CLOSED });
      // A lost response retries into an in-band confirmation, never a 404.
      expect(await close(bridge, id)).toEqual({ status: 200, body: MISSING });
    },
  },
  {
    id: "close-pending-fences-prompt",
    title: "an unconfirmed close is pending, stays registered and refuses new prompts",
    requires: ["failCloses"],
    async run(bridge) {
      const id = await bridge.createSession();
      const restore = await bridge.failCloses!(id);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const pending = await close(bridge, id);
          expect(pending.status).toBe(503);
          expect(pending.body).toMatchObject({ closed: false, pending: true });
          expect(typeof (pending.body as { error?: unknown }).error).toBe("string");
        }
        // Still registered, so the backend's durable intent has a target and a
        // retry is never told `missing` for a close that did not happen.
        expect(await activity(bridge, id)).not.toBe("missing");
        const prompt = await bridge.request(
          "POST",
          `/session/${encode(id)}/prompt`,
          bridge.promptBody(unseenId("after-pending-close")),
        );
        expect(prompt.status).toBe(409);
      } finally {
        await restore();
      }
      expect(await close(bridge, id)).toEqual({ status: 200, body: CLOSED });
      expect(await close(bridge, id)).toEqual({ status: 200, body: MISSING });
    },
  },
  {
    id: "cancel-idle-in-band",
    title: "cancel and abort on an idle session both answer 200 {cancelled:false}",
    requires: [],
    async run(bridge) {
      const id = await bridge.createSession();
      const cancel = await bridge.request("POST", `/session/${encode(id)}/cancel`);
      const abort = await bridge.request("POST", `/session/${encode(id)}/abort`);
      expect(cancel).toEqual({ status: 200, body: { cancelled: false } });
      expect(abort).toEqual(cancel);
      expect(await activity(bridge, id)).toBe("idle");
    },
  },
  {
    id: "abort-idle-acknowledged",
    title: "abort on an idle session is acknowledged and leaves the session usable",
    requires: [],
    async run(bridge) {
      const id = await bridge.createSession();
      const abort = await bridge.request("POST", `/session/${encode(id)}/abort`);
      expect(abort.status).toBeGreaterThanOrEqual(200);
      expect(abort.status).toBeLessThan(300);
      expect(await activity(bridge, id)).toBe("idle");
      expect(await close(bridge, id)).toEqual({ status: 200, body: CLOSED });
    },
  },
  {
    id: "transcript-cursor-grammar",
    title: "messages?fromIndex= selects the shared window for every cursor in the table",
    requires: ["seedRetainedTail"],
    async run(bridge) {
      const id = await bridge.seedRetainedTail!();
      const observed: Array<{ label: string; window: TranscriptWindow }> = [];
      for (const entry of TRANSCRIPT_CURSOR_CASES) {
        observed.push({
          label: entry.label,
          window: await readWindow(bridge, id, entry.fromIndex),
        });
      }
      // One comparison over the whole table: a failure names every case that
      // diverged, labelled, rather than only the first.
      expect(observed).toEqual(
        TRANSCRIPT_CURSOR_CASES.map((entry) => ({ label: entry.label, window: entry.expected })),
      );
    },
  },
  {
    id: "create-ack-recoverable",
    title: "an acknowledged create survives a restart from the published state",
    requires: ["restartFromPublishedState"],
    async run(bridge) {
      const clientSessionKey = unseenId("conformance-tab");
      const id = await bridge.createSession({ clientSessionKey });
      // The backend stores the id the moment it sees 201. A successor that
      // reads only what was published — no drain — must still know it.
      await bridge.restartFromPublishedState!();
      expect(await activity(bridge, id)).not.toBe("missing");
      expect(await bridge.createSession({ clientSessionKey })).toBe(id);
    },
  },
  {
    id: "dispatch-probe-unknown",
    title: "an unknown prompt request id on a known session probes as unknown",
    requires: [],
    async run(bridge) {
      const id = await bridge.createSession();
      const requestId = unseenId("never-sent");
      // Never `dispatched` (it was not) and never `absent`: this process cannot
      // prove a request id it has no record of was not taken by a predecessor.
      expect(
        await bridge.request(
          "GET",
          `/session/${encode(id)}/dispatch?requestId=${encode(requestId)}`,
        ),
      ).toEqual({ status: 200, body: { dispatch: "unknown" } });
    },
  },
  {
    id: "steer-dispatch-probe-unknown",
    title: "an unknown steer request id on a known session probes as unknown",
    requires: [],
    async run(bridge) {
      const id = await bridge.createSession();
      const requestId = unseenId("never-steered");
      expect(
        await bridge.request(
          "GET",
          `/session/${encode(id)}/steer/dispatch?requestId=${encode(requestId)}`,
        ),
      ).toEqual({ status: 200, body: { dispatch: "unknown" } });
    },
  },
  {
    id: "bounded-recovery-summary",
    title: "runtime-health reports bounded recovery state within its limits at saturation",
    requires: ["saturateBoundedState", "boundedOccupancy"],
    async run(bridge) {
      const id = await bridge.createSession();
      await bridge.saturateBoundedState!(id);
      const health = await bridge.request("GET", `/session/${encode(id)}/runtime-health`);
      expect(health.status).toBe(200);
      expect(JSON.stringify(health.body).length).toBeLessThanOrEqual(MAX_RUNTIME_HEALTH_BYTES);
      const occupancy = bridge.boundedOccupancy!(health.body);
      expect(occupancy.length).toBeGreaterThan(0);
      for (const record of occupancy) {
        expect(record.entries).toBeLessThanOrEqual(record.limitEntries);
        expect(record.bytes).toBeLessThanOrEqual(record.limitBytes);
      }
      expect(occupancy.some((record) => record.saturated)).toBe(true);
    },
  },
] as const satisfies readonly ContractScenario[];

export type ScenarioId = (typeof CONTRACT_SCENARIOS)[number]["id"];

/**
 * Register the shared contract for one bridge.
 *
 * Supported scenarios run against a fresh handle each; unsupported ones are
 * registered as skipped tests whose name carries the reason, so the matrix is
 * visible in every run rather than silently absent.
 */
export function runBridgeContractSuite(
  adapter: BridgeContractAdapter,
  options: { timeoutMs?: number } = {},
): void {
  const row = BRIDGE_CONTRACT_CAPABILITIES[adapter.bridge];
  describe(`bridge HTTP contract: ${adapter.bridge}`, () => {
    for (const scenario of CONTRACT_SCENARIOS as readonly ContractScenario[]) {
      const capability = row[scenario.id as ScenarioId];
      const name = `${scenario.id}: ${scenario.title}`;
      if (!capability.supported) {
        test.skip(`${name} [not applicable: ${capability.reason}]`, () => undefined);
        continue;
      }
      test(
        name,
        async () => {
          const bridge = await adapter.start();
          try {
            const missing = scenario.requires.filter((hook) => typeof bridge[hook] !== "function");
            if (missing.length > 0) {
              throw new Error(
                `${adapter.bridge} marks ${scenario.id} supported but its adapter lacks: ${missing.join(", ")}`,
              );
            }
            await scenario.run(bridge);
          } finally {
            await bridge.stop();
          }
        },
        options.timeoutMs,
      );
    }
  });
}
