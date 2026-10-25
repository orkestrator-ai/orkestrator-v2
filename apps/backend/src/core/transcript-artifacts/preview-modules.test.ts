/**
 * Real-Chromium qualification of bundled module scripts: the d3 and Chart.js
 * module fixtures run offline under the generated CSP (a hash mismatch would
 * block the module and fail the probes). Process mode runs whenever Chromium
 * is found (the explicit opt-in that ORKESTRATOR_ARTIFACT_PREVIEW_ALLOW_PROCESS_INTERACTIVE=1
 * sets); container mode runs when Docker and the worker image are present.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ArtifactProbeV1 } from "@orkestrator/protocol/transcript-artifacts";
import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import { resolveDesignChromiumPath } from "../design/index.js";
import type { PreviewJob } from "./contracts.js";
import { TranscriptInteractivePreparer } from "./interactive-prepare.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  PREVIEW_WORKER_USER,
  resolveSeccompProfile,
} from "./runtime.js";

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM)
  console.warn(
    "[preview-modules.test] process cases skipped: no Chromium executable (set ORKESTRATOR_DESIGN_CHROMIUM_PATH)",
  );
const IMAGE = process.env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE ?? DEFAULT_PREVIEW_WORKER_IMAGE;
const imagePresent =
  spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 }).status ===
  0;
if (!imagePresent)
  console.warn(
    `[preview-modules.test] container cases skipped: Docker or image ${IMAGE} unavailable`,
  );

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");
const preparer = new TranscriptInteractivePreparer({ frameAncestors: [] });

const D3_PROBES: ArtifactProbeV1[] = [
  { op: "expect-number", target: "bar-count", equals: 5 },
  { op: "expect-number", target: "max-value", equals: 9 },
  { op: "click", target: "add-day" },
  { op: "expect-number", target: "bar-count", equals: 6 },
  { op: "expect-text", target: "max-value", equals: "12" },
];
const CHART_PROBES: ArtifactProbeV1[] = [
  { op: "expect-number", target: "bar-count", equals: 5 },
  { op: "expect-text", target: "drawn", equals: "yes" },
  { op: "expect-text", target: "auto-entry", equals: "shared" },
  { op: "click", target: "add-day" },
  { op: "expect-number", target: "bar-count", equals: 6 },
  { op: "expect-number", target: "max-value", equals: 12 },
  { op: "expect-text", target: "drawn", equals: "yes" },
];
const CASES = [
  {
    name: "d3 namespace import",
    file: "d3-module-bars.html",
    deps: ["d3@7.9.0"],
    probes: D3_PROBES,
  },
  {
    name: "Chart.js named and chart.js/auto imports",
    file: "chartjs-module.html",
    deps: ["chart.js@4.5.1"],
    probes: CHART_PROBES,
  },
];

let operation = 0;
const scope = (mode: string) => ({
  environmentId: `env-modules-${mode}`,
  conversationKey: "modules",
  operationId: `op_modules${mode}${String(++operation).padStart(5, "0")}`,
});

async function job(file: string, deps: string[], probes: ArtifactProbeV1[]): Promise<PreviewJob> {
  const prepared = await preparer.prepare({
    artifactId: "art_modules0001",
    revision: 1,
    html: fixture(file),
    dependencyIds: deps,
    assets: [],
  });
  if (!prepared.ok) throw new Error(`preparation failed: ${JSON.stringify(prepared.diagnostics)}`);
  return {
    kind: "html-interactive",
    preparedDocument: prepared.prepared.document,
    contentSecurityPolicy: prepared.prepared.contentSecurityPolicy,
    readinessNonce: prepared.prepared.readinessNonce,
    identity: { artifactId: "art_modules0001", revision: 1 },
    profile: DEFAULT_PREVIEW_PROFILE,
    probes,
  };
}

async function expectPasses(
  runner: TranscriptPreviewRunner,
  mode: string,
  entry: (typeof CASES)[number],
) {
  const result = await runner.run(
    await job(entry.file, entry.deps, entry.probes),
    scope(mode),
    new AbortController().signal,
  );
  if (!result.ok)
    console.error(
      `[preview-modules.test] ${mode} ${entry.file}`,
      JSON.stringify(result, (key, value) => (key === "png" ? "<png>" : value)).slice(0, 2_000),
    );
  expect(result.ok).toBe(true);
  if (!result.ok || result.kind !== "html-interactive") return;
  expect(result.probeResults.map((probe) => probe.status)).toEqual(
    entry.probes.map(() => "passed"),
  );
  expect(result.runtimeErrors).toBe(0);
  expect(result.blockedRequests).toEqual({});
}

describe("module scripts in Chromium (process isolation)", () => {
  let runner: TranscriptPreviewRunner | undefined;
  afterAll(async () => {
    await runner?.close();
  });
  for (const entry of CASES) {
    (CHROMIUM ? test : test.skip)(
      `${entry.name} passes its probes offline`,
      async () => {
        runner ??= new TranscriptPreviewRunner({
          isolation: "process",
          allowProcessInteractive: true,
        });
        await expectPasses(runner, "process", entry);
      },
      60_000,
    );
  }
});

describe("module scripts in the worker container", () => {
  let runner: TranscriptPreviewRunner | undefined;
  afterAll(async () => {
    await runner?.close();
  });
  for (const entry of CASES) {
    (imagePresent ? test : test.skip)(
      `${entry.name} passes its probes in the container`,
      async () => {
        runner ??= new TranscriptPreviewRunner({
          isolation: "container",
          container: {
            docker: "docker",
            image: IMAGE,
            seccompProfile: resolveSeccompProfile()!,
            user: PREVIEW_WORKER_USER,
          },
        });
        await expectPasses(runner, "container", entry);
      },
      180_000,
    );
  }
});
