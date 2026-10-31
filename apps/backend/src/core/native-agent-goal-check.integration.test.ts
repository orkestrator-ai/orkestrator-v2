import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { goalCheckOperationId, runGoalCheck } from "./native-agent-goal-check.js";
import {
  control,
  execDirectory,
  workspaceRoot,
  stopEnvironmentExecWorkers,
} from "./public-api/exec-control.js";
import { createPublicApiHarness, type PublicApiHarness } from "./public-api/test-support.js";
import { createEnvironment } from "./storage.js";

const harnesses: PublicApiHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await stopEnvironmentExecWorkers("goal-env", h.context);
    await h.cleanup();
  }
});
async function fixture() {
  const h = await createPublicApiHarness();
  harnesses.push(h);
  const environment = createEnvironment("p", { name: "goal", environmentType: "local" });
  Object.assign(environment, { id: "goal-env", status: "running", worktreePath: h.root });
  await h.storage.addEnvironment(environment);
  return { h, environment };
}
async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await fs.stat(file).catch(() => null)) return;
    if (Date.now() > deadline) throw new Error("Worker did not start");
    await Bun.sleep(20);
  }
}

test("a completed check returns its output and removes its directory", async () => {
  const { h, environment } = await fixture();
  const run = await runGoalCheck(environment, h.context, {
    goalId: "finished",
    iteration: 1,
    command: "printf verified",
    timeoutMs: 5_000,
  });
  expect(run).toMatchObject({ kind: "finished", exitCode: 0, outputTail: "verified" });
  expect(await fs.readdir(path.join(h.dataDir, "exec-runs"))).toEqual([]);
}, 15_000);

test("backend cancellation stops polling and drains the worker promptly", async () => {
  const { h, environment } = await fixture();
  const controller = new AbortController();
  const run = runGoalCheck(environment, h.context, {
    goalId: "shutdown",
    iteration: 1,
    command: "touch started; sleep 120",
    timeoutMs: 120_000,
    signal: controller.signal,
  });
  await waitForFile(path.join(h.root, "started"));
  const stoppedAt = Date.now();
  controller.abort();
  expect(await run).toEqual({ kind: "stopped" });
  expect(Date.now() - stoppedAt).toBeLessThan(10_000);
  expect(await fs.readdir(path.join(h.dataDir, "exec-runs"))).toEqual([]);
}, 20_000);

test("recovery adopts an already-running check without launching its shell again", async () => {
  const { h, environment } = await fixture();
  const operationId = goalCheckOperationId("recovered", 2);
  const directory = execDirectory(environment, operationId, h.context);
  await control(environment, h.context, {
    action: "start",
    operationId,
    environmentId: environment.id,
    directory,
    root: workspaceRoot(environment),
    cwd: workspaceRoot(environment),
    argv: [
      "bash",
      "-lc",
      "echo run >> launches; touch started; while [ ! -f release ]; do sleep 0.05; done; printf recovered",
    ],
    env: {},
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
  });
  await waitForFile(path.join(h.root, "started"));
  const recovering = runGoalCheck(environment, h.context, {
    goalId: "recovered",
    iteration: 2,
    command: "echo duplicate >> launches",
    timeoutMs: 10_000,
  });
  await fs.writeFile(path.join(h.root, "release"), "go");
  expect(await recovering).toMatchObject({
    kind: "finished",
    exitCode: 0,
    outputTail: "recovered",
  });
  expect(await fs.readFile(path.join(h.root, "launches"), "utf8")).toBe("run\n");
  expect(await fs.readdir(path.join(h.dataDir, "exec-runs"))).toEqual([]);
}, 20_000);
