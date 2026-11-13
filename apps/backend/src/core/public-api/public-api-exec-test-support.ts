import { promises as fs } from "node:fs";
import path from "node:path";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type { PublicExecOutputWindow } from "@orkestrator/protocol/public-api-resources";
import { createProject } from "../storage.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * Shared harness for the `environment.exec` suites. Success is read from the
 * recorded process result, never from output.
 */

export const KILL_GRACE_ENV = "ORKESTRATOR_TEST_EXEC_KILL_GRACE_MS";
export const HEARTBEAT_ENV = "ORKESTRATOR_TEST_EXEC_HEARTBEAT_MS";

/**
 * Shortens the worker's TERM-to-KILL grace (5s in production) and its cancel
 * poll (1s in production) for every command started until the returned
 * function runs. The worker inherits the backend's environment. A command
 * must still ignore TERM and be killed by the grace timer, and a cancel is
 * still observed by the worker's own poll.
 */
export function shortenExecWorkerTimers(): () => void {
  const previous = { grace: process.env[KILL_GRACE_ENV], heartbeat: process.env[HEARTBEAT_ENV] };
  process.env[KILL_GRACE_ENV] = "500";
  process.env[HEARTBEAT_ENV] = "100";
  return () => {
    for (const [name, value] of [
      [KILL_GRACE_ENV, previous.grace],
      [HEARTBEAT_ENV, previous.heartbeat],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export async function setupExecEnvironment(
  options: Parameters<typeof createPublicApiHarness>[0] = {},
): Promise<{ harness: PublicApiHarness; worktree: string }> {
  const harness = await createPublicApiHarness(options);
  const worktree = path.join(harness.root, "worktree");
  await fs.mkdir(path.join(worktree, "sub"), { recursive: true });
  const project = await harness.storage.addProject(
    createProject("https://example.invalid/exec.git"),
  );
  await harness.storage.addEnvironment({
    id: "env-exec",
    projectId: project.id,
    name: "exec",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: worktree,
    setupScriptsComplete: true,
    setupPhase: "ready",
  });
  return { harness, worktree };
}

export async function exec(
  harness: PublicApiHarness,
  requestId: string,
  input: Record<string, unknown>,
) {
  return harness.call("environment.exec", { environmentId: "env-exec", ...input }, { requestId });
}

/** How often tests re-read an operation; short, because each read is an in-process call. */
export const EXEC_POLL_MS = 25;

export async function waitTerminal(
  harness: PublicApiHarness,
  operationId: string,
  timeoutMs = 30_000,
): Promise<PublicReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await harness.call("run.get", { operationId });
    const receipt = response.receipt!;
    if (!["admitted", "running", "unknown"].includes(receipt.state)) return receipt;
    if (Date.now() > deadline) throw new Error(`exec did not finish: ${JSON.stringify(receipt)}`);
    await new Promise((resolve) => setTimeout(resolve, EXEC_POLL_MS));
  }
}

/** Waits (bounded, 5s) until the worker reports that its command started. */
export async function waitStarted(harness: PublicApiHarness, operationId: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000 / EXEC_POLL_MS; attempt += 1) {
    const current = await harness.call("run.get", { operationId });
    if (current.receipt?.execution?.startedAt) return;
    await new Promise((resolve) => setTimeout(resolve, EXEC_POLL_MS));
  }
}

export async function output(
  harness: PublicApiHarness,
  operationId: string,
  stream: "stdout" | "stderr",
): Promise<PublicExecOutputWindow> {
  const response = await harness.call<PublicExecOutputWindow>("run.output", {
    operationId,
    stream,
  });
  if (!response.ok) throw new Error(`run.output failed: ${response.error.message}`);
  return response.result;
}

/**
 * Owns the harnesses one test creates and removes exactly those, so tests that
 * run concurrently never clean up each other's data directories.
 */
export class ExecScope {
  private readonly harnesses: PublicApiHarness[] = [];

  async setup(
    options: Parameters<typeof createPublicApiHarness>[0] = {},
  ): Promise<{ harness: PublicApiHarness; worktree: string }> {
    const made = await setupExecEnvironment(options);
    this.harnesses.push(made.harness);
    return made;
  }

  adopt(harness: PublicApiHarness): PublicApiHarness {
    this.harnesses.push(harness);
    return harness;
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.harnesses.splice(0).map((harness) => harness.cleanup()));
  }
}
