import { describe, expect, mock, test } from "bun:test";
import { NATIVE_SESSION_INVALIDATION_CAUSES } from "@orkestrator/protocol/native-agent-observation";
import { NATIVE_AGENT_DISCOVERY_SECTIONS } from "@orkestrator/protocol/native-agent";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { ProviderActivityObservation } from "./native-agent-provider.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import type { NativeAgentService } from "./native-agent-service.js";
import type { StorageService } from "./storage.js";
import { collaborators } from "./native-agent-service-test-collaborators.js";
import { nativeSessionInvalidationMetrics } from "./native-session-invalidation-metrics.js";

/*
 * Todo 0049 task 4: an idle Codex view read 27 times a minute live against
 * Claude's 12. Every invalidation the backend emits now names its cause; these
 * tests count them for a fake idle Codex session and check that each source
 * that can wake an idle view is tagged, and that no tag carries content.
 */

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;
const TRANSCRIPT_MARKER = "transcript-marker-8c41";
const IDENTITY = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:idle-codex-tab",
};

type Counted = { channel: "resource" | "activity"; cause: string | undefined };

function idleCodex() {
  const state = {
    contentRevision: "process-1:1.4:0",
    transcriptToken: "source-1",
    reply: `Finished ${TRANSCRIPT_MARKER}`,
    commands: [{ name: "review", description: "Review the change", source: "builtin" as const }],
    runtime: "ready",
    activity: "idle" as ProviderActivityObservation["state"],
    reorderMcpTools: false,
  };
  const transcript = () => [
    {
      id: "prompt",
      role: "user" as const,
      content: `Please do it ${TRANSCRIPT_MARKER}`,
      parts: [],
      createdAt: "2026-11-03T00:00:00.000Z",
    },
    {
      id: "reply",
      role: "assistant" as const,
      content: state.reply,
      parts: [{ type: "text", content: state.reply }],
      createdAt: "2026-11-03T00:00:01.000Z",
    },
  ];
  const stub = createProviderStub("codex", {
    transcriptSnapshot: async (_sessionId, options) =>
      options?.knownSourceToken === state.transcriptToken
        ? { unchanged: true as const, sourceToken: state.transcriptToken }
        : {
            messages: transcript(),
            complete: true,
            freshness: "current" as const,
            sourceToken: state.transcriptToken,
            representation: "summary" as const,
            historyEpoch: "process:1:0",
          },
    messages: async () => transcript(),
    sessionStateSnapshot: async () => ({ status: "idle" as const }),
    slashCommands: async () => state.commands,
  });
  const observeActivity = mock(async (): Promise<ProviderActivityObservation> => ({
    state: state.activity,
    contentRevision: state.contentRevision,
  }));
  const runtimeHealth = mock(async () => ({
    summary: { state: state.runtime },
    notices: [],
    authoritative: true,
  }));
  // Codex app-server lists an MCP server's tools as a map, in a different
  // order on each read (todo 7530): a flag the tests flip to reproduce it.
  let mcpReads = 0;
  const mcpServers = mock(async () => {
    mcpReads += 1;
    const tools = ["alpha", "mid", "zeta"];
    return [
      {
        id: "orkestrator",
        name: "orkestrator",
        status: "connected" as const,
        toolCount: tools.length,
        tools: state.reorderMcpTools && mcpReads % 2 === 0 ? [...tools].reverse() : tools,
        actions: ["reconnect" as const],
      },
    ];
  });
  Object.assign(stub.provider, { observeActivity, runtimeHealth, mcpServers });
  return { state, provider: stub.provider };
}

/** One coordinated read round of a mounted view, as the renderer issues it. */
async function readRound(service: NativeAgentService, tokens: Record<string, string | undefined>) {
  const transcript = await service.getTranscriptUpdate({
    ...IDENTITY,
    viewVersion: 1,
    liveWindow,
    ...(tokens.transcript ? { knownToken: tokens.transcript } : {}),
  });
  if (!("token" in transcript)) throw new Error("Expected an existing idle session");
  tokens.transcript = transcript.token;
  const sessionState = await service.getSessionStateUpdate({
    ...IDENTITY,
    viewVersion: 1,
    ...(tokens.state ? { knownToken: tokens.state } : {}),
  });
  if (!("token" in sessionState)) throw new Error("Expected an existing idle session");
  tokens.state = sessionState.token;
  const discovery = await service.getDiscoveryUpdate({
    ...IDENTITY,
    viewVersion: 1,
    sections: [...NATIVE_AGENT_DISCOVERY_SECTIONS],
    ...(tokens.discovery ? { knownToken: tokens.discovery } : {}),
  });
  if (!("token" in discovery)) throw new Error("Expected an existing idle session");
  tokens.discovery = discovery.token;
}

/** Let background renewals (discovery, catalogue, hydration) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

function byCause(counted: readonly Counted[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of counted) {
    const label = entry.cause ?? "untagged";
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

async function withIdleCodex(
  run: (context: {
    service: NativeAgentService;
    storage: StorageService;
    state: ReturnType<typeof idleCodex>["state"];
    counted: Counted[];
    changes: ResourceChange[];
    advance: (ms: number) => void;
  }) => Promise<void>,
) {
  let now = 1_000;
  const { state, provider } = idleCodex();
  const counted: Counted[] = [];
  const everything: Counted[] = [];
  const changes: ResourceChange[] = [];
  const count = (entry: Counted) => {
    counted.push(entry);
    everything.push(entry);
  };
  const invoke = async <T>(command: string): Promise<T> => {
    if (command !== "get_native_agent_model_catalog") {
      throw new Error(`Unexpected backend command: ${command}`);
    }
    return [{ platform: "codex", id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }] as T;
  };
  await withService(
    {
      prefix: "orkestrator-idle-invalidations-",
      provider: async () => provider,
      invoke,
      now: () => now,
      onActivityTransition: () => count({ channel: "activity", cause: "transition" }),
      onObservationInvalidation: (event) => count({ channel: "activity", cause: event.cause }),
    },
    async ({ service, storage }) => {
      storage.addResourceChangeListener((change) => {
        if (change.resource !== "native-agent-session") return;
        changes.push(change);
        count({ channel: "resource", cause: change.cause });
      });
      await service.ensureSession(IDENTITY);
      await run({
        service,
        storage,
        state,
        counted,
        changes,
        advance: (ms) => {
          now += ms;
        },
      });
      // Every invalidation is tagged from the vocabulary, and no tag or
      // announced change carries transcript text.
      const vocabulary: readonly string[] = NATIVE_SESSION_INVALIDATION_CAUSES;
      expect(everything.length).toBeGreaterThan(0);
      for (const entry of everything) expect(vocabulary).toContain(entry.cause ?? "untagged");
      for (const change of changes) {
        expect(change.cause).toBeDefined();
        expect(JSON.stringify(change)).not.toContain(TRANSCRIPT_MARKER);
      }
    },
  );
}

/**
 * One idle minute at the live cadence: the sweep every 2 s, the view's
 * quiet-backoff read every 15 s, and a read after every invalidation.
 * `beforeTick` may move a source first.
 */
async function idleMinute(
  service: NativeAgentService,
  counted: Counted[],
  advance: (ms: number) => void,
  tokens: Record<string, string | undefined>,
  beforeTick: (elapsed: number) => void = () => undefined,
) {
  counted.length = 0;
  let scheduledReads = 0;
  let invalidatedReads = 0;
  // Invalidations the view has already answered with a read.
  let answered = 0;
  for (let elapsed = 2_000; elapsed <= 60_000; elapsed += 2_000) {
    advance(2_000);
    beforeTick(elapsed);
    await service.reconcileAgentActivity();
    await settle();
    // Includes one a previous read's own renewal announced.
    if (counted.length > answered) {
      invalidatedReads += 1;
    } else if (elapsed % 15_000 < 2_000) {
      scheduledReads += 1;
    } else {
      continue;
    }
    answered = counted.length;
    await readRound(service, tokens);
    await settle();
  }
  return { idle: byCause(counted), scheduledReads, invalidatedReads };
}

async function warmUp(service: NativeAgentService, tokens: Record<string, string | undefined>) {
  // The tab opens, discovery fills, the first sweep observes idle.
  await readRound(service, tokens);
  await settle();
  await service.reconcileAgentActivity();
  await readRound(service, tokens);
  await settle();
}

describe("idle Codex session invalidations (todo 0049 task 4)", () => {
  test("a stable idle Codex view is told to read again by nothing over a simulated minute", async () => {
    await withIdleCodex(async ({ service, counted, advance }) => {
      const tokens: Record<string, string | undefined> = {};
      await warmUp(service, tokens);
      // Opening a tab is announced, and every announcement says why.
      expect(byCause(counted)).toEqual({
        "record-created": 1,
        "record-title": 1,
        "model-catalog-load": 1,
        "command-catalog": 1,
        "discovery-renewal": NATIVE_AGENT_DISCOVERY_SECTIONS.length,
        transition: 1,
      });

      // Discovery expires twice in the minute and the view's own reads renew
      // it, unchanged: no announcement. The view reads only on its schedule.
      expect(await idleMinute(service, counted, advance, tokens)).toEqual({
        idle: {},
        scheduledReads: 4,
        invalidatedReads: 0,
      });
    });
  }, 30_000);

  test("an MCP tool list read in a new order each time announces nothing (todo 7530)", async () => {
    await withIdleCodex(async ({ service, state, counted, advance }) => {
      state.reorderMcpTools = true;
      const tokens: Record<string, string | undefined> = {};
      await warmUp(service, tokens);
      // Live, six of these in 300 s each reset the idle view's backoff.
      expect(await idleMinute(service, counted, advance, tokens)).toEqual({
        idle: {},
        scheduledReads: 4,
        invalidatedReads: 0,
      });
      const discovery = await service.getDiscoveryUpdate({
        ...IDENTITY,
        viewVersion: 1,
        sections: ["mcp"],
      });
      if (!("value" in discovery)) throw new Error("Expected a discovery value");
      expect(discovery.value?.sections.mcp?.value).toMatchObject([
        { id: "orkestrator", tools: ["alpha", "mid", "zeta"] },
      ]);
    });
  }, 30_000);

  test("each source that moves an idle Codex view is counted under its own cause", async () => {
    await withIdleCodex(async ({ service, state, counted, advance }) => {
      const tokens: Record<string, string | undefined> = {};
      await warmUp(service, tokens);
      // Todo 7530: the announcement also names its section and changed path.
      const metricsWereEnabled = nativeSessionInvalidationMetrics.enabled;
      nativeSessionInvalidationMetrics.setEnabled(true);
      nativeSessionInvalidationMetrics.reset();
      const result = await idleMinute(service, counted, advance, tokens, (elapsed) => {
        // A late command change or async question on the idle thread.
        if (elapsed === 10_000) state.contentRevision = "process-1:1.5:0";
        if (elapsed === 20_000) state.contentRevision = "process-1:1.5:1";
        // The runtime section's value changes before its next renewal.
        if (elapsed === 24_000) state.runtime = "detached";
      });
      expect(result.idle).toEqual({ "content-revision": 2, "discovery-renewal": 1 });
      expect(result.invalidatedReads).toBe(3);
      expect(nativeSessionInvalidationMetrics.snapshot().discoveryRenewals).toEqual({
        codex: { runtime: { count: 1, changed: { "summary.state": 1 } } },
      });
      nativeSessionInvalidationMetrics.reset();
      nativeSessionInvalidationMetrics.setEnabled(metricsWereEnabled);
    });
  }, 30_000);

  test("observer announcements outside the sweep name their own causes", async () => {
    await withIdleCodex(async ({ service, storage, state, counted }) => {
      const tokens: Record<string, string | undefined> = {};
      await warmUp(service, tokens);
      const session = (await storage.listNativeAgentSessions()).find(
        (candidate) => candidate.logicalSessionKey === IDENTITY.logicalSessionKey,
      );
      if (!session) throw new Error("expected the idle Codex session");

      counted.length = 0;
      // A goal change: the backend-owned view moved without a transition.
      collaborators(service).launches.announceSessionContent(session);
      expect(byCause(counted)).toEqual({ "session-content": 1 });

      // A turn running when its runtime stops is settled to idle.
      state.activity = "working";
      await service.reconcileAgentActivity();
      counted.length = 0;
      await service.environmentRuntimeStopped(IDENTITY.environmentId);
      await settle();
      expect(byCause(counted)).toMatchObject({ "runtime-stopped": 1 });
    });
  });
});
