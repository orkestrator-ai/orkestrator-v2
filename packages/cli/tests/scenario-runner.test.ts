import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunManifest } from "../scenarios/harness.js";
import { runOne, runScenarios } from "../scripts/run-scenarios.js";
import { scenarioOptions, scenarioRuntime } from "./support/scenario-runner.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("measures readiness separately from the scenario and writes it to result output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-readiness-manifest-"));
  directories.push(root);
  const manifest = new RunManifest(path.join(root, "manifest.json"));
  const runtime = scenarioRuntime();
  const exit = await runScenarios(
    [
      {
        name: "measured",
        description: "fixture",
        async run() {
          runtime.advance(500);
        },
      },
    ],
    scenarioOptions,
    manifest,
    "measured-run",
    runtime.dependencies,
  );
  expect(exit).toBe(0);
  const output = JSON.parse(await readFile(manifest.file!, "utf8"));
  expect(output.results).toEqual([
    {
      name: "measured",
      passed: true,
      backendReadyMs: 125,
      durationMs: 625,
      cleanupErrors: [],
    },
  ]);
  expect(runtime.stopped).toEqual(runtime.roots);
  expect(runtime.removed).toEqual(runtime.roots);
});

test("readiness stays null in result output if backend startup fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-unready-manifest-"));
  directories.push(root);
  const manifest = new RunManifest(path.join(root, "manifest.json"));
  const runtime = scenarioRuntime();
  runtime.dependencies.startIsolatedBackend = async () => {
    runtime.advance(60_000);
    throw new Error("backend never ready");
  };
  let ran = false;
  expect(
    await runScenarios(
      [
        {
          name: "unready",
          description: "fixture",
          async run() {
            ran = true;
          },
        },
      ],
      scenarioOptions,
      manifest,
      "unready-run",
      runtime.dependencies,
    ),
  ).toBe(1);
  const output = JSON.parse(await readFile(manifest.file!, "utf8"));
  expect(output.results[0]).toEqual({
    name: "unready",
    passed: false,
    backendReadyMs: null,
    durationMs: 60_000,
    cleanupErrors: [],
  });
  expect(ran).toBe(false);
  expect(runtime.removed).toEqual(runtime.roots);
});

test("keep-on-failure preserves the root when only cleanup failed", async () => {
  const runtime = scenarioRuntime();
  const result = await runOne(
    {
      name: "cleanup-failure",
      description: "fixture",
      async run(context) {
        directories.push(context.root);
        context.cleanup.push({
          label: "owned resource",
          async run() {
            throw new Error("refused");
          },
        });
      },
    },
    { ...scenarioOptions, keepOnFailure: true },
    new RunManifest(null),
    runtime.dependencies,
  );
  expect(result.passed).toBe(false);
  expect(result.cleanupErrors).toEqual(["owned resource: refused"]);
  expect(runtime.removed).toEqual([]);
  expect(runtime.stopped).toEqual(runtime.roots);
});
