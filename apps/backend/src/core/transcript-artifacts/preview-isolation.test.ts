/**
 * Isolation policy of the preview runner, without a browser: authored
 * JavaScript is refused in process mode unless explicitly allowed, process
 * workers get a scrubbed environment and a private scratch HOME/TMPDIR/cwd
 * that is removed after exit, unverified exits quarantine their slot until a
 * bounded reaper confirms the boundary is gone, and Mermaid math labels are
 * refused with a specific diagnostic.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import type { PreviewJob } from "./contracts.js";
import { MERMAID_MATH_LABELS_UNSUPPORTED, detectMermaidMathLabels } from "./mermaid-svg.js";
import {
  PROCESS_INTERACTIVE_REFUSAL,
  TranscriptPreviewRunner,
  type PreviewRunnerOptions,
} from "./preview-runner.js";
import {
  containerGone,
  processWorkerEnv,
  type ExitReport,
  type SupervisedJob,
  type SupervisedOutcome,
} from "./preview-supervisor.js";

const FAKE_WORKER = path.join(import.meta.dir, "fixtures", "fake-preview-worker.ts");

let runner: TranscriptPreviewRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

function create(options: Partial<PreviewRunnerOptions> = {}) {
  runner = new TranscriptPreviewRunner({
    isolation: "process",
    executablePath: () => "/bin/sh",
    workerCommand: () => ({ command: process.execPath, args: [FAKE_WORKER] }),
    ...options,
  });
  return runner;
}

let operation = 0;
const scope = (environmentId = `env-${operation}`) => ({
  environmentId,
  conversationKey: `c${++operation}`,
  operationId: `op_isolation${String(operation).padStart(6, "0")}`,
});

const INTERACTIVE: PreviewJob = {
  kind: "html-interactive",
  preparedDocument: "<!doctype html><p>x</p>",
  contentSecurityPolicy: "default-src 'none'; script-src 'none'; sandbox allow-scripts",
  profile: DEFAULT_PREVIEW_PROFILE,
  probes: [],
};

describe("interactive isolation policy", () => {
  test("process mode refuses authored JavaScript by default and says why", async () => {
    const target = create();
    await expect(
      target.run(INTERACTIVE, scope(), new AbortController().signal),
    ).rejects.toMatchObject({
      error: { code: "renderer_unavailable", message: PROCESS_INTERACTIVE_REFUSAL },
    });
    expect(PROCESS_INTERACTIVE_REFUSAL).toContain(
      "ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION=container",
    );
    expect(PROCESS_INTERACTIVE_REFUSAL).toContain(
      "ORKESTRATOR_ARTIFACT_PREVIEW_ALLOW_PROCESS_INTERACTIVE=1",
    );
    expect(target.status()).toMatchObject({
      available: true,
      isolation: "process",
      interactiveIsolation: "unavailable",
      interactiveReason: PROCESS_INTERACTIVE_REFUSAL,
      isolationSelection: "configured",
    });
    // Static HTML and Mermaid execute no authored code and still run in process mode.
    const mermaid = await target.run(
      { kind: "mermaid", source: "sleep:1", theme: "light" },
      scope(),
      new AbortController().signal,
    );
    expect(mermaid.ok).toBe(true);
  });

  test("the explicit opt-in lets interactive jobs reach a process worker and reports it", async () => {
    const target = create({ allowProcessInteractive: true, isolationSelection: "auto" });
    expect(target.status()).toMatchObject({
      interactiveIsolation: "process",
      isolationSelection: "auto",
    });
    // The fake worker answers with a mermaid-shaped result, so the job fails
    // on evidence, not on admission: it was not refused.
    const result = await target.run(INTERACTIVE, scope(), new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe("renderer_unavailable");
  });

  test("container mode reports container isolation for interactive jobs and its image pin", () => {
    const target = create({
      isolation: "container",
      container: {
        docker: "/nonexistent/docker",
        image: `sha256:${"a".repeat(64)}`,
        pinned: true,
        user: "pwuser",
      },
    });
    expect(target.status()).toMatchObject({
      isolation: "container",
      interactiveIsolation: "container",
      workerImage: { reference: `sha256:${"a".repeat(64)}`, pinned: true },
    });
  });
});

describe("process worker hardening", () => {
  test("the worker gets no inherited secrets and a private HOME/TMPDIR/cwd that is removed", async () => {
    const secret = `canary-env-${Math.random().toString(36).slice(2)}`;
    const fileCanary = `canary-file-${Math.random().toString(36).slice(2)}`;
    const fakeHome = mkdtempSync(path.join(tmpdir(), "ork-fake-home-"));
    writeFileSync(path.join(fakeHome, "canary.txt"), fileCanary);
    const saved = { HOME: process.env.HOME, secret: process.env.ORK_TEST_CANARY_SECRET };
    process.env.HOME = fakeHome;
    process.env.ORK_TEST_CANARY_SECRET = secret;
    const exits: Array<{ verified: boolean; scratchDir?: string | null }> = [];
    try {
      const target = create({ onWorkerExit: (report) => exits.push(report) });
      const result = await target.run(
        { kind: "mermaid", source: "env-report", theme: "light" },
        scope(),
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(fileCanary);
      expect(serialized).not.toContain(fakeHome);
      const report = JSON.parse(
        result.diagnostics.find((entry) => entry.code === "env-report")!.message,
      ) as { env: Record<string, string>; cwd: string; file: string | null };
      const allowed = Object.keys(processWorkerEnv("/x", process.env));
      // Bun may add a few runtime-internal variables of its own; nothing else is inherited.
      for (const key of Object.keys(report.env))
        expect(allowed.includes(key) || /^(BUN_|_$|PWD$|OLDPWD$|SHLVL$)/.test(key)).toBe(true);
      expect(report.env.ORK_TEST_CANARY_SECRET).toBeUndefined();
      expect(report.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      expect(report.file).toBeNull();
      const scratch = realpathSync(report.env.HOME!);
      expect(realpathSync(report.env.TMPDIR!)).toBe(scratch);
      expect(realpathSync(report.cwd)).toBe(scratch);
      expect(path.basename(scratch)).toMatch(/^ork-artifact-preview-/);

      const deadline = Date.now() + 10_000;
      while (target.stats().running > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(exits).toHaveLength(1);
      expect(exits[0]!.verified).toBe(true);
      expect(realpathSync(path.dirname(exits[0]!.scratchDir!))).toBe(
        realpathSync(path.dirname(scratch)),
      );
      expect(existsSync(exits[0]!.scratchDir!)).toBe(false);
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.secret === undefined) delete process.env.ORK_TEST_CANARY_SECRET;
      else process.env.ORK_TEST_CANARY_SECRET = saved.secret;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("an unreachable Docker daemon is not evidence that a container is gone", async () => {
    expect(await containerGone("/nonexistent/docker-cli", "ork-artifact-preview-x")).toBe(false);
  });
});

/** A supervised job double whose exit is unverified until `reapAfter` reap attempts. */
function fakeSupervise(plan: { reapAfter: number | null; reaps: { count: number } }) {
  return (): SupervisedJob => {
    const outcome: SupervisedOutcome = {
      type: "result",
      result: {
        ok: true,
        kind: "mermaid",
        browserBuild: "fake/1",
        diagnostics: [],
        blockedRequests: {},
        captures: [],
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/></g></svg>',
        diagramType: "flowchart",
        edges: 0,
      },
    };
    const exited: ExitReport = { verified: plan.reapAfter === 0, pids: [], browserPid: null };
    return {
      outcome: Promise.resolve(outcome),
      exited: Promise.resolve(exited),
      cancel: () => undefined,
      browserPid: () => null,
      workerPid: () => null,
      scratchDir: () => null,
      reap: async () => {
        plan.reaps.count++;
        return plan.reapAfter !== null && plan.reaps.count >= plan.reapAfter;
      },
    };
  };
}

async function until(predicate: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

describe("capacity after an unverified worker exit", () => {
  test("the slot is quarantined and counted until the reaper confirms the worker is gone", async () => {
    const reaps = { count: 0 };
    const exits: boolean[] = [];
    const target = create({
      admission: { runningGlobal: 1, runningPerEnvironment: 1 },
      reaperDelaysMs: [30, 30, 30, 30, 30],
      supervise: fakeSupervise({ reapAfter: 3, reaps }),
      onWorkerExit: (report) => exits.push(report.verified),
    });
    const first = await target.run(
      { kind: "mermaid", source: "a", theme: "light" },
      scope("env-q"),
      new AbortController().signal,
    );
    expect(first.ok).toBe(true);
    // Immediately after the unverified exit the slot is still held.
    expect(target.stats()).toMatchObject({ running: 1, quarantined: 1, unverifiedExits: 1 });
    expect(target.status()).toMatchObject({ available: false, quarantinedWorkers: 1 });
    expect(target.status().reason).toContain("could not be verified");

    // A second job waits for the slot instead of running beside the unverified worker.
    const second = target.run(
      { kind: "mermaid", source: "b", theme: "light" },
      scope("env-other"),
      new AbortController().signal,
    );
    expect(target.stats().queued).toBe(1);
    // reapAfter: 3 → the third reap confirms the first worker; the second job
    // then runs (its own exit is also unverified and needs further reaps).
    expect(await second).toMatchObject({ ok: true });
    expect(reaps.count).toBeGreaterThanOrEqual(3);
    expect(exits[0]).toBe(true);
    expect(await until(() => target.stats().running === 0)).toBe(true);
    expect(target.stats().quarantined).toBe(0);
    expect(target.status()).toMatchObject({ available: true });
    expect(target.status().quarantinedWorkers).toBeUndefined();
  });

  test("quarantined slots keep polling after the initial retry burst until Docker recovers", async () => {
    const reaps = { count: 0 };
    const exits: boolean[] = [];
    const target = create({
      admission: { runningGlobal: 1, runningPerEnvironment: 1 },
      reaperDelaysMs: [10, 10, 10],
      reaperPollMs: 120,
      supervise: fakeSupervise({ reapAfter: 4, reaps }),
      onWorkerExit: (report) => exits.push(report.verified),
    });
    await target.run(
      { kind: "mermaid", source: "a", theme: "light" },
      scope("env-g"),
      new AbortController().signal,
    );
    expect(await until(() => reaps.count === 3)).toBe(true);
    expect(exits).toEqual([]);
    expect(target.stats()).toMatchObject({ running: 1, quarantined: 1 });
    expect(target.status()).toMatchObject({ available: false, quarantinedWorkers: 1 });
    // Further work is queued (and eventually times out), never run beside it.
    const blocked = target.run(
      { kind: "mermaid", source: "b", theme: "light" },
      scope("env-h"),
      new AbortController().signal,
    );
    expect(target.stats()).toMatchObject({ queued: 1, running: 1 });
    expect((await blocked).ok).toBe(true);
    expect(await until(() => target.stats().running === 0)).toBe(true);
    expect(exits.every(Boolean)).toBe(true);
    expect(reaps.count).toBeGreaterThan(3);
  });
});

describe("Mermaid math labels", () => {
  test("detects $$…$$ outside comments", () => {
    expect(detectMermaidMathLabels('flowchart LR\n  A["$$x^2$$"] --> B')).toEqual({
      line: 2,
      column: 6,
    });
    expect(detectMermaidMathLabels('flowchart LR\n  A["$$\n  x$$"] --> B')).toEqual({
      line: 2,
      column: 6,
    });
    expect(detectMermaidMathLabels("flowchart LR\n  %% $$x$$ in a comment\n  A --> B")).toBeNull();
    expect(detectMermaidMathLabels("flowchart LR\n  A[costs $5] --> B[$$ only once]")).toBeNull();
  });

  test("the runner refuses them with math_labels_unsupported before starting a worker", async () => {
    const exits: unknown[] = [];
    const target = create({ onWorkerExit: (report) => exits.push(report) });
    const result = await target.run(
      { kind: "mermaid", source: 'flowchart LR\n  A["$$\\frac{a}{b}$$"] --> B', theme: "light" },
      scope(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "validation_failed", resource: "math-labels" });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: MERMAID_MATH_LABELS_UNSUPPORTED,
        location: "line 2:6",
      }),
    ]);
    expect(exits).toHaveLength(0);
  });
});
