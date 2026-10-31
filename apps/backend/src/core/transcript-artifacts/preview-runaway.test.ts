/**
 * Runaway execution matrix, in real Chromium: unbounded memory allocation,
 * a DOM flood past the 10,000-element budget, a recursive microtask loop, an
 * endless requestAnimationFrame animation and huge canvas allocations. Each
 * job must end within its deadline, the boundary (process tree or container)
 * must be gone, capacity must be recovered (nothing running or quarantined)
 * and the next healthy job must succeed.
 *
 * Process mode runs when Chromium is available; container mode when Docker
 * and the worker image are available. Skips print the reason.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ArtifactProbeV1 } from "@orkestrator/protocol/transcript-artifacts";
import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import { resolveDesignChromiumPath } from "../design/index.js";
import type { PreviewJob, PreviewJobResult } from "./contracts.js";
import { TranscriptInteractivePreparer } from "./interactive-prepare.js";
import { isAlive, listProcesses } from "./preview-process-tree.js";
import { TranscriptPreviewRunner, type PreviewBudgets } from "./preview-runner.js";
import { PREVIEW_CONTAINER_OWNER_LABEL, previewContainerOwner } from "./preview-supervisor.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  PREVIEW_WORKER_USER,
  resolveSeccompProfile,
} from "./runtime.js";
import { previewTestScratchRoot } from "./fixtures/preview-scratch-root.js";

const CHROMIUM = resolveDesignChromiumPath();
const IMAGE = process.env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE ?? DEFAULT_PREVIEW_WORKER_IMAGE;
const imagePresent =
  spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 }).status ===
  0;
if (!CHROMIUM) console.warn("[preview-runaway.test] process mode skipped: no Chromium executable");
if (!imagePresent)
  console.warn(
    `[preview-runaway.test] container mode skipped: Docker or image ${IMAGE} unavailable`,
  );

const BUDGETS: Partial<PreviewBudgets> = {
  readinessMs: 5_000,
  workerWallMs: 15_000,
  operationDeadlineMs: 25_000,
  cleanupGraceMs: 1_000,
};
/**
 * The probe step budget for a case whose step hangs: the step deadline is the
 * same code path, only the wait for it is shorter. The healthy job that
 * follows on the same runner still has ample time per step.
 */
const HUNG_STEP_MS = 1_000;
/** Process mode's RSS watchdog limit for these tests (the container has its 1 GiB cgroup). */
const PROCESS_MEMORY_LIMIT = 768 * 1024 * 1024;
const preparer = new TranscriptInteractivePreparer({ frameAncestors: [] });
const CALCULATOR_PROBES: ArtifactProbeV1[] = [
  { op: "expect-number", target: "total", equals: 60 },
  { op: "set-number", target: "tasks", value: 8 },
  { op: "expect-number", target: "total", equals: 96 },
];

async function job(html: string, probes: ArtifactProbeV1[] = []): Promise<PreviewJob> {
  const prepared = await preparer.prepare({
    artifactId: "art_runaway0001",
    revision: 1,
    html,
    dependencyIds: [],
    assets: [],
  });
  if (!prepared.ok) throw new Error(`preparation failed: ${JSON.stringify(prepared.diagnostics)}`);
  return {
    kind: "html-interactive",
    preparedDocument: prepared.prepared.document,
    contentSecurityPolicy: prepared.prepared.contentSecurityPolicy,
    readinessNonce: prepared.prepared.readinessNonce,
    profile: DEFAULT_PREVIEW_PROFILE,
    probes,
  };
}

const page = (body: string, script: string) =>
  `<!doctype html><html><body>${body}<script>${script}</script></body></html>`;

interface RunawayCase {
  name: string;
  html: string;
  probes?: ArtifactProbeV1[];
  /** Budgets this case's runner overrides (its own runner, so other cases keep theirs). */
  budgets?: Partial<PreviewBudgets>;
  /** Expected outcome; `any` for work that is legitimate but must still end in time. */
  expect: (result: PreviewJobResult, mode: "process" | "container") => void;
}

const CASES: RunawayCase[] = [
  {
    name: "unbounded memory allocation",
    html: page(
      '<p data-artifact-test="x">x</p>',
      `const keep = [];
       const grow = () => { for (let i = 0; i < 4; i++) { const a = new Uint8Array(16 * 1024 * 1024); a.fill(7); keep.push(a); } setTimeout(grow, 0); };
       grow();`,
    ),
    probes: [{ op: "wait-visible", target: "never" }],
    expect: (result, mode) => {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Process mode: the backend's RSS watchdog. Container mode: the cgroup
      // limit kills a Chromium process (renderer crash or worker death).
      if (mode === "process") expect(result.error.resource).toBe("worker-memory");
      else
        expect(["renderer-crash", "worker-memory", undefined, "readiness", "wall"]).toContain(
          result.error.resource,
        );
    },
  },
  {
    name: "DOM flood beyond 10,000 elements",
    html: page(
      '<p data-artifact-test="x">x</p>',
      `document.addEventListener("DOMContentLoaded", () => {
         setInterval(() => { for (let i = 0; i < 2000; i++) document.body.appendChild(document.createElement("i")); }, 20);
       });`,
    ),
    probes: [
      { op: "wait-visible", target: "x" },
      { op: "click", target: "x" },
      { op: "click", target: "x" },
    ],
    expect: (result) => {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ code: "validation_failed", resource: "dom-elements" });
      expect(result.diagnostics.some((entry) => entry.code === "dom_limit")).toBe(true);
    },
  },
  {
    name: "recursive microtask loop",
    html: page(
      '<button data-artifact-test="x" id="go">go</button>',
      // Starts after readiness, from the probe's click: the event loop never returns.
      `document.getElementById("go").addEventListener("click", () => { const f = () => queueMicrotask(f); f(); });`,
    ),
    probes: [
      { op: "click", target: "x" },
      { op: "expect-text", target: "x", equals: "go" },
    ],
    // The click never returns, so the job waits out the step deadline.
    budgets: { probeStepMs: HUNG_STEP_MS },
    expect: (result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("render_timeout");
    },
  },
  {
    name: "endless requestAnimationFrame animation",
    html: page(
      '<div id="box" data-artifact-test="x" style="width:40px;height:40px;background:#36c">x</div>',
      `const box = document.getElementById("box");
       const loop = (t) => { box.style.transform = "translateX(" + (t % 400) + "px)"; const end = performance.now() + 8; while (performance.now() < end) {} requestAnimationFrame(loop); };
       requestAnimationFrame(loop);`,
    ),
    probes: [
      { op: "wait-visible", target: "x" },
      { op: "expect-text", target: "x", equals: "x" },
    ],
    // Legitimate but never-ending work: the job still finishes (it need not fail).
    expect: (result) => {
      expect(typeof result.ok).toBe("boolean");
    },
  },
  {
    name: "huge canvas allocation",
    html: page(
      '<p data-artifact-test="x">x</p>',
      `document.addEventListener("DOMContentLoaded", () => {
         for (let i = 0; i < 6; i++) {
           const c = document.createElement("canvas");
           c.width = 16384; c.height = 16384;
           const ctx = c.getContext("2d");
           if (ctx) { ctx.fillStyle = "#c33"; ctx.fillRect(0, 0, c.width, c.height); try { ctx.getImageData(0, 0, c.width, c.height); } catch {} }
           document.body.appendChild(c);
         }
         const giant = document.createElement("canvas"); giant.width = 100000; giant.height = 100000;
         document.body.appendChild(giant);
       });`,
    ),
    probes: [{ op: "wait-visible", target: "x" }],
    // Chromium may refuse the allocation, crash the renderer, or be killed by
    // the memory policy; every one of those must end in time.
    expect: (result) => {
      expect(typeof result.ok).toBe("boolean");
    },
  },
];

type ExitReport = {
  operationId: string;
  verified: boolean;
  browserPid: number | null;
  workerPid: number | null;
};

function runawaySuite(mode: "process" | "container", enabled: boolean) {
  const modeTest = enabled ? test : test.skip;
  describe(`runaway execution (${mode} isolation)`, () => {
    const exits: ExitReport[] = [];
    const owner = previewContainerOwner(path.join(tmpdir(), `ork-runaway-${process.pid}-${mode}`));
    /** One runner per budget override, reused by every case that shares it. */
    const runners = new Map<string, TranscriptPreviewRunner>();
    let operation = 0;
    const scope = () => ({
      environmentId: `env-runaway-${mode}`,
      conversationKey: `c${++operation}`,
      operationId: `op_runaway${mode}${String(operation).padStart(4, "0")}`,
    });
    const make = (overrides: Partial<PreviewBudgets> = {}) => {
      const key = JSON.stringify(overrides);
      const existing = runners.get(key);
      if (existing) return existing;
      const budgets = { ...BUDGETS, ...overrides };
      const created =
        mode === "process"
          ? new TranscriptPreviewRunner({
              isolation: "process",
              scratchRoot: previewTestScratchRoot(),
              allowProcessInteractive: true,
              budgets,
              memoryLimitBytes: PROCESS_MEMORY_LIMIT,
              onWorkerExit: (report) => exits.push(report),
            })
          : new TranscriptPreviewRunner({
              isolation: "container",
              container: {
                docker: "docker",
                image: IMAGE,
                seccompProfile: resolveSeccompProfile()!,
                user: PREVIEW_WORKER_USER,
                owner,
              },
              budgets,
              onWorkerExit: (report) => exits.push(report),
            });
      runners.set(key, created);
      return created;
    };
    afterAll(async () => {
      await Promise.all([...runners.values()].map((created) => created.close()));
      if (mode === "container" && enabled)
        spawnSync("docker", ["rm", "-f", ...listOwned(owner)], { stdio: "ignore" });
    });

    const listOwned = (value: string) =>
      spawnSync(
        "docker",
        ["ps", "-aq", "--filter", `label=${PREVIEW_CONTAINER_OWNER_LABEL}=${value}`],
        {
          encoding: "utf8",
        },
      )
        .stdout.split(/\s+/)
        .filter(Boolean);

    async function assertRecovered(target: TranscriptPreviewRunner, operationId: string) {
      const deadline = Date.now() + 20_000;
      while (target.stats().running > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(target.stats()).toMatchObject({ running: 0, queued: 0, quarantined: 0 });
      const exit = exits.find((entry) => entry.operationId === operationId);
      expect(exit?.verified).toBe(true);
      if (mode === "process") {
        const processes = await listProcesses();
        if (exit?.browserPid) expect(isAlive(exit.browserPid, processes)).toBe(false);
        if (exit?.workerPid) expect(isAlive(exit.workerPid, processes)).toBe(false);
      } else {
        expect(listOwned(owner)).toEqual([]);
      }
    }

    for (const runaway of CASES) {
      modeTest(
        `${runaway.name}: ends within the deadline, the boundary is gone, the next job succeeds`,
        async () => {
          const target = make(runaway.budgets);
          const runawayScope = scope();
          const started = Date.now();
          const result = await target.run(
            await job(runaway.html, runaway.probes),
            runawayScope,
            new AbortController().signal,
          );
          const elapsed = Date.now() - started;
          console.warn(
            `[preview-runaway.test] ${mode} / ${runaway.name}: ${
              result.ok
                ? "ok"
                : `${result.error.code}${result.error.resource ? `/${result.error.resource}` : ""}`
            } in ${elapsed} ms`,
          );
          expect(elapsed).toBeLessThan(BUDGETS.operationDeadlineMs! + 1_000);
          runaway.expect(result, mode);
          await assertRecovered(target, runawayScope.operationId);

          const healthyScope = scope();
          const healthy = await target.run(
            await job(
              readFileSync(path.join(import.meta.dir, "fixtures", "calculator.html"), "utf8"),
              CALCULATOR_PROBES,
            ),
            healthyScope,
            new AbortController().signal,
          );
          if (!healthy.ok) console.error("[preview-runaway.test] healthy job:", healthy.error);
          expect(healthy.ok).toBe(true);
          await assertRecovered(target, healthyScope.operationId);
        },
        120_000,
      );
    }
  });
}

runawaySuite("process", Boolean(CHROMIUM));
runawaySuite("container", imagePresent);
