import { describe, expect, mock, test } from "bun:test";
import {
  NATIVE_AGENT_DISCOVERY_SECTIONS,
  type NativeAgentDiscoveryView,
} from "@orkestrator/protocol/native-agent";
import type { ProviderActivityObservation } from "./provider.js";
import { createProviderStub, withService } from "./service-projection-test-support.js";
import type { NativeAgentService } from "./service.js";

/*
 * #2314: in a quiet Claude tab every discovery answer was a whole body
 * (about 32 KB), two per 30 s backstop where nothing had changed. A backstop
 * read found each section just expired and was answered `stale` (a new view,
 * plus a 2 s follow-up), and the follow-up was answered `ready` again with the
 * command catalogue's `fetchedAt` moved (another new view). These tests read
 * discovery on the renderer's own schedule over quiet minutes and count what
 * each answer carried.
 */

const IDENTITY = {
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "env-env-1:quiet-claude-tab",
};

/** The renderer's schedule (`NativeDiscoveryReadSchedule`, `native-session-read-policy.ts`). */
const DISCOVERY_BACKSTOP_MS = 30_000;
const DISCOVERY_SETTLING_READ_MS = 2_000;
const DISCOVERY_UNAVAILABLE_READ_MS = 5_000;

function followUpMs(view: NativeAgentDiscoveryView): number | null {
  const availabilities = Object.values(view.sections).map((section) => section.availability);
  if (availabilities.includes("loading") || availabilities.includes("stale")) {
    return DISCOVERY_SETTLING_READ_MS;
  }
  return availabilities.includes("unavailable") ? DISCOVERY_UNAVAILABLE_READ_MS : null;
}

function quietClaude() {
  const state = {
    commands: Array.from({ length: 40 }, (_, index) => ({
      name: `command-${index}`,
      description: `A command the composer lists, number ${index}`,
      source: "builtin" as const,
    })),
    runtime: "ready",
    runtimeFails: false,
  };
  const stub = createProviderStub("claude", {
    sessionStateSnapshot: async () => ({ status: "running" as const }),
    slashCommands: async () => state.commands,
  });
  const observeActivity = mock(async (): Promise<ProviderActivityObservation> => ({
    state: "working",
    contentRevision: "process-1:1:0",
  }));
  const runtimeHealth = mock(async () => {
    if (state.runtimeFails) throw new Error("Runtime discovery failed");
    return { summary: { state: state.runtime }, notices: [], authoritative: true };
  });
  const mcpServers = mock(async () => [
    {
      id: "orkestrator",
      name: "orkestrator",
      status: "connected" as const,
      toolCount: 2,
      tools: ["alpha", "zeta"],
      actions: ["reconnect" as const],
    },
  ]);
  Object.assign(stub.provider, { observeActivity, runtimeHealth, mcpServers });
  return { state, provider: stub.provider, runtimeHealth, mcpServers };
}

/** Let background renewals (discovery, catalogue) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

type Tally = {
  snapshots: number;
  unchanged: number;
  snapshotBytes: number;
  unchangedBytes: number;
  triggers: string[];
  runtimeAvailability: string[];
};

/**
 * A mounted view reading discovery the way the renderer does: on mount, after
 * an invalidation, on a follow-up while a section is settling, and otherwise
 * on the 30 s backstop with its token. Ticks every second.
 */
async function quietWindow(
  service: NativeAgentService,
  view: { token?: string; followUpMs: number | null; lastReadAt: number; due: boolean },
  advance: (ms: number) => void,
  elapsedNow: () => number,
  durationMs: number,
  onTick: (elapsed: number) => void = () => undefined,
): Promise<Tally> {
  const tally: Tally = {
    snapshots: 0,
    unchanged: 0,
    snapshotBytes: 0,
    unchangedBytes: 0,
    triggers: [],
    runtimeAvailability: [],
  };
  const end = elapsedNow() + durationMs;
  while (elapsedNow() < end) {
    advance(1_000);
    onTick(elapsedNow());
    const since = elapsedNow() - view.lastReadAt;
    const trigger = view.due
      ? "invalidation"
      : since >= DISCOVERY_BACKSTOP_MS
        ? "backstop"
        : view.followUpMs !== null && since >= view.followUpMs
          ? "follow-up"
          : null;
    if (!trigger) continue;
    view.due = false;
    view.lastReadAt = elapsedNow();
    const answer = await service.getDiscoveryUpdate({
      ...IDENTITY,
      viewVersion: 1,
      sections: [...NATIVE_AGENT_DISCOVERY_SECTIONS],
      ...(view.token ? { knownToken: view.token } : {}),
    });
    if (!("token" in answer)) throw new Error("Expected an existing session");
    view.token = answer.token;
    if (answer.status === "snapshot") {
      tally.snapshots += 1;
      tally.snapshotBytes += Buffer.byteLength(JSON.stringify(answer));
      tally.triggers.push(trigger);
      tally.runtimeAvailability.push(answer.value.sections.runtime?.availability ?? "absent");
      view.followUpMs = followUpMs(answer.value);
    } else {
      tally.unchanged += 1;
      tally.unchangedBytes += Buffer.byteLength(JSON.stringify(answer));
    }
    await settle();
  }
  return tally;
}

async function withQuietClaude(
  run: (context: {
    service: NativeAgentService;
    state: ReturnType<typeof quietClaude>["state"];
    reads: { runtime: () => number; mcp: () => number };
    window: (durationMs: number, onTick?: (elapsed: number) => void) => Promise<Tally>;
    announcements: string[];
  }) => Promise<void>,
) {
  let now = 1_000;
  const { state, provider, runtimeHealth, mcpServers } = quietClaude();
  const announcements: string[] = [];
  const view = { followUpMs: null as number | null, lastReadAt: 0, due: true } as {
    token?: string;
    followUpMs: number | null;
    lastReadAt: number;
    due: boolean;
  };
  const invoke = async <T>(command: string): Promise<T> => {
    if (command !== "get_native_agent_model_catalog") {
      throw new Error(`Unexpected backend command: ${command}`);
    }
    return [{ platform: "claude", id: "claude-haiku-5-5", label: "Haiku 5.5" }] as T;
  };
  await withService(
    {
      prefix: "orkestrator-quiet-discovery-",
      provider: async () => provider,
      invoke,
      now: () => now,
    },
    async ({ service, storage }) => {
      storage.addResourceChangeListener((change) => {
        if (change.resource !== "native-agent-session") return;
        announcements.push(change.cause ?? "untagged");
        // Any invalidation of the session makes the view read discovery.
        view.due = true;
      });
      await service.ensureSession(IDENTITY);
      const advance = (ms: number) => {
        now += ms;
      };
      // Mount: discovery fills; let the first jobs and their announcements settle.
      await quietWindow(service, view, advance, () => now, 10_000);
      announcements.length = 0;
      await run({
        service,
        state,
        reads: {
          runtime: () => runtimeHealth.mock.calls.length,
          mcp: () => mcpServers.mock.calls.length,
        },
        announcements,
        window: (durationMs, onTick) =>
          quietWindow(service, view, advance, () => now, durationMs, onTick),
      });
    },
  );
}

describe("discovery reads during a quiet turn (#2314)", () => {
  test("a quiet view's renewals answer unchanged instead of re-sending the whole view", async () => {
    await withQuietClaude(async ({ window, announcements, reads }) => {
      const before = { runtime: reads.runtime(), mcp: reads.mcp() };
      // Four backstops elapse in two quiet minutes; each renews every
      // section, and none of them changed. Before the fix the same window
      // sent nine whole views (87,354 B here) and no `unchanged` answer.
      const tally = await window(120_000);
      expect(tally).toMatchObject({ snapshots: 0, unchanged: 4, snapshotBytes: 0, triggers: [] });
      // About 335 B each: the token and the identity, no section.
      expect(tally.unchangedBytes).toBeLessThan(4 * 400);
      expect(announcements).toEqual([]);
      // The two sections the per-provider job limit refused at each backstop
      // were still renewed every time, by the jobs ahead of them finishing.
      expect(reads.runtime() - before.runtime).toBe(4);
      expect(reads.mcp() - before.mcp).toBe(4);
    });
  }, 30_000);

  test("a section whose value changes at renewal is still announced and sent once", async () => {
    await withQuietClaude(async ({ window, state, announcements }) => {
      const tally = await window(60_000, (elapsed) => {
        if (elapsed === 25_000) state.runtime = "detached";
      });
      expect(announcements).toEqual(["discovery-renewal"]);
      expect(tally.snapshots).toBe(1);
      expect(tally.triggers).toEqual(["invalidation"]);
    });
  }, 30_000);
  test("a rejected retained-value renewal announces stale and follows up until recovery", async () => {
    await withQuietClaude(async ({ window, state, announcements, service }) => {
      const tally = await window(60_000, (elapsed) => {
        if (elapsed === 25_000) state.runtimeFails = true;
        if (elapsed === 45_000) state.runtimeFails = false;
      });
      // One failure wakeup delivers stale. Repeated failures stay quiet; the
      // renderer-style 2 s follow-up delivers ready when the same value recovers.
      expect(announcements).toEqual(["discovery-renewal"]);
      expect(tally.snapshots).toBe(2);
      expect(tally.triggers).toEqual(["invalidation", "follow-up"]);
      expect(tally.runtimeAvailability).toEqual(["stale", "ready"]);
      const update = await service.getDiscoveryUpdate({
        ...IDENTITY,
        viewVersion: 1,
        sections: ["runtime"],
      });
      if (update.status !== "snapshot") throw new Error("Expected runtime snapshot");
      expect(update.value.sections.runtime?.availability).toBe("ready");
    });
  }, 30_000);
});
