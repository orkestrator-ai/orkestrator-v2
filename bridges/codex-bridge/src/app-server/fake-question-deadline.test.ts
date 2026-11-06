/**
 * A Default-mode question held past the bridge's five-minute deadline, through
 * a real spawned app-server child: the bridge's fake `codex` binary
 * (`FAKE_CODEX_SCRIPT=question`), which sends `item/tool/requestUserInput` the
 * way Codex 0.166.0 does (`isBlocking: false`, `autoResolutionMs: null`) and,
 * like Codex, never resolves it itself. The deadlines run on a manual clock,
 * so the held and expired cases are proven without waiting; the same scenario
 * in real elapsed time against the pinned binary is the opt-in
 * `RUN_LIVE_CODEX_QUESTION_DEADLINES=1` case in
 * `live-request-user-input.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractionDeadlineClock } from "@orkestrator/protocol/agent-interaction-deadline";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
} from "@orkestrator/protocol/agent-interactions";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig } from "../engine/types.js";
import type { InteractionRequest, InteractionResolution } from "./interactions.js";

const fakeCodex = join(import.meta.dir, "..", "testing", "fake-codex-app-server.mjs");
const WINDOW = AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
const CEILING = AGENT_INTERACTION_HOLD_CEILING_MS;
/** The same hold the live qualification uses: past the window and Codex's TUI grace. */
const HELD_FOR_MS = 10.5 * 60_000;
const START = 1_800_000_000_000;

/** Deadline timers fire only when the test advances time past them. */
function manualClock() {
  let now = START;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: InteractionDeadlineClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, callback });
      return { id: nextId, unref: () => undefined };
    },
    clearTimeout: (handle) => {
      timers.delete((handle as { id: number }).id);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = target;
  };
  return { clock, advance, now: () => now };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startQuestionTurn() {
  chmodSync(fakeCodex, 0o755);
  const root = mkdtempSync(join(tmpdir(), "ork-fake-question-"));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const time = manualClock();
  const engine = new AppServerEngine({
    codexPath: fakeCodex,
    cwd: root,
    codexHome,
    clientInfo: { name: "orkestrator", title: "Orkestrator", version: "2.4.9" },
    interactionClock: time.clock,
    supervisorOverrides: {
      pidFileEnabled: false,
      // The script is chosen per child, so no test mutates the shared process.env.
      spawnProcess: ((command: string, args: readonly string[], options: { env?: object }) =>
        spawn(command, args, {
          ...options,
          env: { ...options.env, FAKE_CODEX_SCRIPT: "question" },
        })) as typeof spawn,
    },
  });
  const questions: InteractionRequest[] = [];
  const resolutions: InteractionResolution[] = [];
  let completed = 0;
  engine.setInteractionHandlers({
    present: (request) => {
      questions.push(request);
      return true;
    },
    resolved: (_request, _answer, resolution) => {
      resolutions.push(resolution);
    },
  });
  engine.subscribe((event: EngineEvent) => {
    if (event.kind === "turn.completed") completed += 1;
  });
  cleanups.push(async () => {
    await engine.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const config: EngineTurnConfig = { mode: "build", cwd: workspace };
  await engine.start();
  const thread = await engine.startThread({ config });
  await engine.startTurn({
    handle: thread.handle,
    input: [{ type: "text", text: "Ask me which codeword to use." }],
    config,
  });
  await waitFor(() => questions.length === 1, "the question to park");

  const answersFile = join(codexHome, "question-answers.jsonl");
  return {
    engine,
    time,
    question: questions[0]!,
    questions,
    resolutions,
    turnCompleted: () => completed > 0,
    /** What app-server received for each answered request. */
    answers: () =>
      existsSync(answersFile)
        ? readFileSync(answersFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { result: unknown }).result)
        : [],
  };
}

describe("a Default-mode question from the fake app-server", () => {
  test("publishes blocking with the bounded five-minute deadline", async () => {
    const { question } = await startQuestionTurn();
    expect(question).toMatchObject({
      kind: "question",
      method: "item/tool/requestUserInput",
      isBlocking: true,
      requestedAt: START,
      // The deadline recorded for 0161 task 2: Orkestrator's own window, as
      // app-server sends no `autoResolutionMs` and never resolves it itself.
      expiresAt: START + WINDOW,
      hold: { available: true },
    });
    expect(question.autoResolutionMs).toBeUndefined();
  });

  test("a held question outlives the deadline and its answer still reaches app-server", async () => {
    const t = await startQuestionTurn();
    const heldAt = t.time.now();
    expect(t.engine.holdInteraction(t.question.interactionId, true)).toEqual({
      status: "applied",
      expiresAt: heldAt + CEILING,
      hold: { available: true, heldAt },
    });

    t.time.advance(HELD_FOR_MS);
    // Let anything the clock released reach the child and come back.
    await Bun.sleep(100);
    const parked = t.engine.getParkedInteractions();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      interactionId: t.question.interactionId,
      expiresAt: heldAt + CEILING,
      hold: { available: true, heldAt },
    });
    expect(t.time.now() - t.question.requestedAt).toBeGreaterThan(WINDOW);
    expect(t.resolutions).toEqual([]);
    expect(t.answers()).toEqual([]);
    expect(t.turnCompleted()).toBe(false);

    expect(
      t.engine.resolveInteraction(t.question.interactionId, {
        action: "accept",
        answers: { codeword: ["PROBE_BETA"] },
      }),
    ).toBe(true);
    await waitFor(t.turnCompleted, "the turn to complete after the answer");
    expect(t.resolutions).toEqual(["answered"]);
    expect(t.answers()).toEqual([{ answers: { codeword: { answers: ["PROBE_BETA"] } } }]);
    expect(t.engine.getParkedInteractions()).toEqual([]);
  });

  test("an unheld question waits out the window, then is cancelled with an empty answer", async () => {
    const t = await startQuestionTurn();
    t.time.advance(WINDOW - 1);
    await Bun.sleep(100);
    expect(t.engine.getParkedInteractions()).toHaveLength(1);
    expect(t.answers()).toEqual([]);

    t.time.advance(1);
    await waitFor(t.turnCompleted, "the turn to complete after expiry");
    expect(t.resolutions).toEqual(["timed-out"]);
    // The same empty answer Codex's own TUI sends when it auto-resolves.
    expect(t.answers()).toEqual([{ answers: {} }]);
    expect(t.engine.getParkedInteractions()).toEqual([]);
  });
});
