/**
 * The provider-replay scenario catalogue, and the runner each bridge calls
 * from its own test group.
 *
 * Only the catalogue and the runner live here. Every bridge owns an adapter
 * (`bridges/<name>/src/conformance-provider-replay.test.ts`) that feeds a
 * fixture's frames to its production ingestion function and reports what the
 * bridge then shows; its fixtures sit beside it in
 * `bridges/<name>/src/testing/provider-replay/`. Nothing here knows any
 * provider's wire shape.
 *
 * Each fixture is replayed and its checkpoints compared with the committed
 * `<fixture>.expected.json`. A scenario also asserts the property it exists
 * for (a pending approval that a denial clears, a revised row outside the live
 * tail, …), so a regenerated expectation cannot quietly drop it.
 *
 * Regenerate expectations after an intended change with
 * `ORKESTRATOR_PROVIDER_REPLAY_UPDATE=1` and review the diff: a changed
 * expectation on a provider bump is the signal this suite exists to raise.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_REPLAY_CAPABILITIES } from "./capabilities.js";
import {
  parseProviderReplayFixture,
  type ProviderReplayActionStep,
  type ProviderReplayBridge,
  type ProviderReplayFixture,
  type ProviderReplayFrameStep,
} from "./fixture.js";
import { observe, type ReplayObservation, type ReplayObservationInput } from "./observation.js";

export const PROVIDER_REPLAY_UPDATE_ENV = "ORKESTRATOR_PROVIDER_REPLAY_UPDATE";

interface ReplayScenario {
  id: string;
  title: string;
  /** The property the scenario exists to pin, checked on every fixture of it. */
  check(observations: ReplayObservation[]): void;
}

function final(observations: ReplayObservation[]): ReplayObservation {
  return observations.at(-1)!;
}

function idle(observation: ReplayObservation): boolean {
  return observation.activity === "idle";
}

export const PROVIDER_REPLAY_SCENARIOS = [
  {
    id: "basic-turn",
    title: "a complete turn assembles its rows and settles idle",
    check(observations) {
      const last = final(observations);
      expect(last.rows.some((row) => row.role === "assistant")).toBe(true);
      expect(last.pending).toEqual([]);
      expect(idle(last)).toBe(true);
    },
  },
  {
    id: "approval-denial",
    title: "a parked approval is pending, the denial clears it, and the turn settles",
    check(observations) {
      expect(observations.some((observation) => observation.pending.length > 0)).toBe(true);
      const last = final(observations);
      expect(last.pending).toEqual([]);
      expect(idle(last)).toBe(true);
    },
  },
  {
    id: "interruption",
    title: "an interrupted turn keeps what streamed and settles idle",
    check(observations) {
      const last = final(observations);
      expect(last.rows.some((row) => row.role === "assistant")).toBe(true);
      expect(last.pending).toEqual([]);
      expect(idle(last)).toBe(true);
    },
  },
  {
    id: "late-background-output",
    title: "output arriving after the turn's result lands on the row that owns it",
    check(observations) {
      // The fixture observes `after-result` once the turn's result is in;
      // what arrives later must still change what the bridge shows.
      const afterResult = observations.find((observation) => observation.label === "after-result");
      expect(afterResult).toBeDefined();
      expect(final(observations).rows).not.toEqual(afterResult!.rows);
      expect(idle(final(observations))).toBe(true);
    },
  },
  {
    id: "resume",
    title: "a session restored by a successor process shows the same conversation",
    check(observations) {
      const last = final(observations);
      expect(last.rows.length).toBeGreaterThan(0);
      expect(idle(last)).toBe(true);
    },
  },
  {
    id: "session-rekey",
    title: "a provider that answers under a new session id keeps one bridge session",
    check(observations) {
      const last = final(observations);
      expect(last.extra).toBeDefined();
      expect(last.rows.some((row) => row.role === "assistant")).toBe(true);
    },
  },
  {
    id: "malformed-events",
    title: "unknown and malformed frames degrade to nothing rendered, never a failed turn",
    check(observations) {
      const last = final(observations);
      expect(last.rows.some((row) => row.role === "assistant")).toBe(true);
      expect(idle(last)).toBe(true);
    },
  },
  {
    id: "outside-tail-update",
    title: "an update to a row outside the live tail reaches readers as a revised row",
    check(observations) {
      expect(
        observations.some((observation) => observation.liveTail.revisedOutsideTail.length > 0),
      ).toBe(true);
    },
  },
] as const satisfies readonly ReplayScenario[];

export type ProviderReplayScenarioId = (typeof PROVIDER_REPLAY_SCENARIOS)[number]["id"];

/** One replay of one fixture, private to that fixture's test. */
export interface ProviderReplaySession {
  /** Hand one provider frame to the bridge's production ingestion path. */
  frame(step: ProviderReplayFrameStep): Promise<void>;
  /** Perform an action. Throw on one this bridge does not implement. */
  action(step: ProviderReplayActionStep): Promise<void>;
  /** What the bridge shows right now; called for `observe` and at the end. */
  snapshot(): Promise<ReplayObservationInput>;
  stop(): Promise<void>;
}

export interface ProviderReplayAdapter {
  bridge: ProviderReplayBridge;
  /** Directory holding this bridge's `*.jsonl` fixtures and expectations. */
  fixtureDir: string;
  start(fixture: ProviderReplayFixture): Promise<ProviderReplaySession>;
}

export function providerReplayFixtureNames(fixtureDir: string): string[] {
  if (!existsSync(fixtureDir)) return [];
  return readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

export function readProviderReplayFixture(fixtureDir: string, name: string): ProviderReplayFixture {
  return parseProviderReplayFixture(name, readFileSync(join(fixtureDir, name), "utf8"));
}

/** Replays one fixture and returns its checkpoints, the last one labelled `end`. */
export async function replayProviderFixture(
  adapter: ProviderReplayAdapter,
  fixture: ProviderReplayFixture,
): Promise<ReplayObservation[]> {
  const session = await adapter.start(fixture);
  const observations: ReplayObservation[] = [];
  try {
    for (const step of fixture.steps) {
      if (step.kind === "frame") {
        await session.frame(step);
        continue;
      }
      if (step.action === "observe") {
        const label = typeof step.args.label === "string" ? step.args.label : `line-${step.line}`;
        observations.push(observe(label, await session.snapshot()));
        continue;
      }
      try {
        await session.action(step);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${fixture.name}:${step.line}: action ${step.action} failed: ${message}`);
      }
    }
    observations.push(observe("end", await session.snapshot()));
  } finally {
    await session.stop();
  }
  return observations;
}

function expectationPath(fixtureDir: string, name: string): string {
  return join(fixtureDir, name.replace(/\.jsonl$/, ".expected.json"));
}

export function runProviderReplaySuite(
  adapter: ProviderReplayAdapter,
  options: { timeoutMs?: number } = {},
): void {
  const row = PROVIDER_REPLAY_CAPABILITIES[adapter.bridge];
  const names = providerReplayFixtureNames(adapter.fixtureDir);
  const fixtures = names.map((name) => readProviderReplayFixture(adapter.fixtureDir, name));

  describe(`provider replay: ${adapter.bridge}`, () => {
    for (const scenario of PROVIDER_REPLAY_SCENARIOS as readonly ReplayScenario[]) {
      const capability = row[scenario.id as ProviderReplayScenarioId];
      const ofScenario = fixtures.filter((fixture) => fixture.header.scenario === scenario.id);
      if (!capability.supported) {
        test.skip(`${scenario.id} [not applicable: ${capability.reason}]`, () => undefined);
        test(`${scenario.id} has no fixture while unsupported`, () => {
          expect(ofScenario.map((fixture) => fixture.name)).toEqual([]);
        });
        continue;
      }
      test(`${scenario.id} has at least one fixture`, () => {
        expect(ofScenario.length).toBeGreaterThan(0);
      });
      for (const fixture of ofScenario) {
        test(
          `${scenario.id}: ${fixture.name} (${fixture.header.source}, ${fixture.header.provider}@${fixture.header.providerVersion})`,
          async () => {
            expect(fixture.header.bridge).toBe(adapter.bridge);
            const observations = await replayProviderFixture(adapter, fixture);
            const path = expectationPath(adapter.fixtureDir, fixture.name);
            if (process.env[PROVIDER_REPLAY_UPDATE_ENV] === "1") {
              writeFileSync(path, `${JSON.stringify(observations, null, 2)}\n`);
            }
            scenario.check(observations);
            if (process.env[PROVIDER_REPLAY_UPDATE_ENV] === "1") return;
            if (!existsSync(path)) {
              throw new Error(
                `${fixture.name} has no expectation; run with ${PROVIDER_REPLAY_UPDATE_ENV}=1 and review it`,
              );
            }
            // Compare parsed values so the failure diff names the changed field.
            expect(observations).toEqual(JSON.parse(readFileSync(path, "utf8")));
          },
          options.timeoutMs,
        );
      }
    }

    test("every fixture names a known scenario", () => {
      const known = new Set<string>(PROVIDER_REPLAY_SCENARIOS.map((scenario) => scenario.id));
      expect(fixtures.filter((fixture) => !known.has(fixture.header.scenario))).toEqual([]);
    });

    test("every expectation has its fixture", () => {
      const orphaned = existsSync(adapter.fixtureDir)
        ? readdirSync(adapter.fixtureDir)
            .filter((name) => name.endsWith(".expected.json"))
            .filter((name) => !names.includes(name.replace(/\.expected\.json$/, ".jsonl")))
        : [];
      expect(orphaned).toEqual([]);
    });
  });
}
