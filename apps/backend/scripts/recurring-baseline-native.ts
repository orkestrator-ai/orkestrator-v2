import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type {
  NativeAgentRuntimeProvider,
  ProviderActivityState,
  ProviderStatus,
} from "../src/core/agent-provider-contract.js";
import {
  NativeAgentService,
  nativeAgentSessionStorageKey,
} from "../src/core/native-agent-service.js";
import { StorageService } from "../src/core/storage.js";

/**
 * Drives the *real* native activity sweep and native prompt-queue scan
 * (recurring-processes step 07) against fake providers on a manual clock.
 *
 * Every provider read is counted at the provider boundary, split into the
 * no-touch observation route (`/activity`, OpenCode's event-fed batch) and
 * the tab-facing status read (`/session/:id/status` or the Claude session
 * resource — a liveness touch, and on Claude a transcript hydrate). Two modes
 * run the identical workload: `rollback` (`observationSharing: false`, the
 * pre-step-07 cadence) and `shared` (the default).
 *
 * Storage is a real `StorageService` in a temporary directory; its content is
 * synthetic and never reported. Only counts and latencies leave this module.
 */

export interface NativeObservationFixture {
  environments: number;
  /** Agents cycled over the environments, one session each. */
  agents: readonly BuildPipelineAgent[];
  /** Environments (from index 0) whose session is mid-turn with a queued prompt. */
  busyWithQueuedPrompt: number;
  /** Sweep and queue-scan cadence (the backend's 2 s timers). */
  tickMs: number;
  windowMs: number;
  /**
   * An idle OpenCode session is started by another client at this offset and
   * its provider event is lost (the safety-read path)...
   */
  externalStartAtMs: number;
  /** ...and again at this offset with the event delivered (the normal path). */
  externalStartWithEventAtMs: number;
  externalTurnMs: number;
}

export const DEFAULT_NATIVE_FIXTURE: NativeObservationFixture = {
  environments: 10,
  agents: ["codex", "claude", "pi", "cursor", "opencode"],
  busyWithQueuedPrompt: 2,
  tickMs: 2_000,
  windowMs: 10 * 60_000,
  externalStartAtMs: 5 * 60_000,
  externalStartWithEventAtMs: 7 * 60_000,
  externalTurnMs: 30_000,
};

export interface NativeObservationCounts {
  sweeps: number;
  queuePasses: number;
  /** No-touch observation reads (`/activity` or OpenCode batch). */
  observationReads: number;
  /** Tab-facing status reads: liveness touches (Claude: transcript hydrate). */
  statusReads: number;
  /** Provider reads per minute, both kinds. */
  providerReadsPerMinute: number;
  /** Groups served from a retained observation instead of a read. */
  retainedGroupPasses: number;
  /** External turn start with its event lost → observer transition (manual clock). */
  externalStartDiscoveryMs: number | null;
  /** External turn start with its event delivered → observer transition. */
  externalStartWithEventDiscoveryMs: number | null;
  /** External turn end → observer turn-end edge (worst of both turns). */
  externalEndDiscoveryMs: number | null;
  /** Turn-end edges observed (each would probe PRs once). */
  turnEndEdges: number;
}

export interface NativeObservationResult {
  fixture: Omit<NativeObservationFixture, "agents"> & { agents: string[] };
  modes: { rollback: NativeObservationCounts; shared: NativeObservationCounts };
}

async function runMode(
  fixture: NativeObservationFixture,
  sharing: boolean,
): Promise<NativeObservationCounts> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-native-baseline-"));
  let clock = 1_000_000;
  const now = () => clock;
  const activity = new Map<string, ProviderActivityState>();
  let observationReads = 0;
  let statusReads = 0;
  const providers = new Map<string, NativeAgentRuntimeProvider>();

  const providerFor = (agent: BuildPipelineAgent): NativeAgentRuntimeProvider => {
    const state = (sessionId: string) => activity.get(sessionId) ?? "idle";
    const status = async (sessionId: string): Promise<ProviderStatus> => {
      statusReads += 1;
      const current = state(sessionId);
      return current === "working" ? "running" : current === "waiting" ? "blocked" : "idle";
    };
    return {
      agent,
      registerSession: () => undefined,
      createSession: async () => "unused",
      send: async () => undefined,
      status,
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
      ...(agent === "opencode"
        ? {
            activityBatch: async (sessionIds: readonly string[]) => {
              observationReads += 1;
              return new Map(sessionIds.map((id) => [id, state(id)]));
            },
            // A connected event stream: the only qualified idle wakeup.
            observationStreamLive: () => true,
          }
        : {
            observeActivity: async (sessionId: string) => {
              observationReads += 1;
              return { state: state(sessionId) };
            },
          }),
    } as unknown as NativeAgentRuntimeProvider;
  };

  const storage = new StorageService(dataDir);
  await storage.init();
  let turnEndEdges = 0;
  const startsObserved: number[] = [];
  const endsObserved: number[] = [];
  const externalSession = "provider-external";
  let retainedGroupPasses = 0;

  const service = new NativeAgentService(
    storage,
    async () => {
      throw new Error("no backend commands in the native baseline");
    },
    {
      provider: async (input) => {
        const key = `${input.environmentId}\0${input.agent}`;
        let provider = providers.get(key);
        if (!provider) {
          provider = providerFor(input.agent);
          providers.set(key, provider);
        }
        return provider;
      },
      now,
      observationSharing: sharing,
      onActivityTransition: (event) => {
        if (event.providerSessionId === externalSession) {
          if (event.state === "working") startsObserved.push(clock);
          if (event.previousState === "working" && event.state === "idle") endsObserved.push(clock);
        }
        if (
          event.state === "idle" &&
          (event.previousState === "working" || event.previousState === "waiting")
        ) {
          turnEndEdges += 1;
        }
      },
    },
  );
  const internals = service as unknown as {
    drainPromptQueues(): Promise<void>;
    observations: { status(): { backedOffGroups: number } };
  };

  try {
    let externalEnvironment: number | null = null;
    for (let index = 0; index < fixture.environments; index += 1) {
      const environmentId = `env-${index}`;
      const agent = fixture.agents[index % fixture.agents.length]!;
      await storage.addEnvironment({
        id: environmentId,
        projectId: "project-1",
        name: "Environment",
        branch: "main",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted",
        order: index,
        environmentType: "local",
        worktreePath: `/fixture/${environmentId}`,
        setupScriptsComplete: true,
      } as Parameters<StorageService["addEnvironment"]>[0]);
      const busy = index < fixture.busyWithQueuedPrompt;
      const external = !busy && agent === "opencode" && externalEnvironment === null;
      if (external) externalEnvironment = index;
      const providerSessionId = external ? externalSession : `provider-${index}`;
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey(environmentId, agent, "tab-1"),
        environmentId,
        agent,
        logicalSessionKey: "tab-1",
        providerSessionId,
      });
      activity.set(providerSessionId, busy ? "working" : "idle");
      if (busy) {
        await storage.savePromptQueue(`${agent}\0tab-1`, environmentId, [
          { id: `queued-${index}`, text: "synthetic queued prompt" },
        ]);
      }
    }

    const ticks = Math.floor(fixture.windowMs / fixture.tickMs);
    // Each turn starts between two sweeps, as a real one would.
    const origin = clock;
    const turns = [
      { startAt: origin + fixture.externalStartAtMs + 500, eventDelivered: false },
      { startAt: origin + fixture.externalStartWithEventAtMs + 500, eventDelivered: true },
    ].map((turn) => ({ ...turn, endAt: turn.startAt + fixture.externalTurnMs, woken: false }));
    let sweeps = 0;
    let queuePasses = 0;
    for (let tick = 0; tick < ticks; tick += 1) {
      const running = turns.find((turn) => clock >= turn.startAt && clock < turn.endAt);
      activity.set(externalSession, running ? "working" : "idle");
      if (running?.eventDelivered && !running.woken && externalEnvironment !== null) {
        // What OpenCode's event stream does through `onObservationHint`.
        running.woken = true;
        service.wakeObservation(`env-${externalEnvironment}`, "provider-event", "opencode");
      }
      await service.reconcileAgentActivity();
      sweeps += 1;
      retainedGroupPasses += internals.observations.status().backedOffGroups;
      await internals.drainPromptQueues();
      queuePasses += 1;
      // Let the OpenCode first-idle transcript check settle between ticks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock += fixture.tickMs;
    }
    const minutes = fixture.windowMs / 60_000;
    return {
      sweeps,
      queuePasses,
      observationReads,
      statusReads,
      providerReadsPerMinute: Math.round(((observationReads + statusReads) / minutes) * 100) / 100,
      retainedGroupPasses,
      externalStartDiscoveryMs:
        startsObserved[0] === undefined ? null : startsObserved[0] - turns[0]!.startAt,
      externalStartWithEventDiscoveryMs:
        startsObserved[1] === undefined ? null : startsObserved[1] - turns[1]!.startAt,
      externalEndDiscoveryMs:
        endsObserved.length < 2
          ? null
          : Math.max(endsObserved[0]! - turns[0]!.endAt, endsObserved[1]! - turns[1]!.endAt),
      turnEndEdges,
    };
  } finally {
    await service.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function runNativeObservationBaseline(
  fixture: NativeObservationFixture = DEFAULT_NATIVE_FIXTURE,
): Promise<NativeObservationResult> {
  const rollback = await runMode(fixture, false);
  const shared = await runMode(fixture, true);
  return { fixture: { ...fixture, agents: [...fixture.agents] }, modes: { rollback, shared } };
}
