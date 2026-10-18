import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpBridgeProvider } from "../src/core/http-bridge-provider.js";
import { MultiReviewService } from "../src/core/multi-review-service.js";
import { StorageService } from "../src/core/storage.js";
import { readProviderStatus } from "../src/core/agent-provider-contract.js";
import { captureReviewWorktreeSnapshot } from "../src/core/review-fanout.js";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";

const testingDir = path.resolve(import.meta.dir, "../../../bridges/claude-bridge/src/testing");
const fakeClaude = path.join(testingDir, "fake-hanging-turn-cli.ts");
const harness = path.join(testingDir, "multi-review-restart-harness.ts");

async function readyPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stdout.getReader();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Bridge exited before startup");
      text += new TextDecoder().decode(chunk.value);
      if (text.length > 16_384) throw new Error("Unexpected bridge startup output");
      const ready = text
        .split("\n")
        .find((line) => line.startsWith('{"port":') && line.endsWith("}"));
      if (ready) return (JSON.parse(ready) as { port: number }).port;
    }
  } finally {
    reader.releaseLock();
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Wait until the bridge has handed the turn to its CLI: the rollout holds
 * `turns` prompts and the session's preferences file holds a turn-in-flight
 * mark. A real restart lands long after both; killing the bridge before them
 * tests a prompt that never reached Claude, which is a different contract.
 */
async function waitForTurnUnderWay(home: string, turns: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (true) {
    const rollouts = (await filesUnder(path.join(home, ".claude", "projects"))).filter((file) =>
      file.endsWith(".jsonl"),
    );
    const prompts = (
      await Promise.all(rollouts.map((file) => readFile(file, "utf8").catch(() => "")))
    ).reduce((count, text) => count + text.split("\n").filter(Boolean).length, 0);
    const preferences = (
      await filesUnder(path.join(home, ".claude", "orkestrator", "session-preferences"))
    ).filter((file) => file.endsWith(".json"));
    const marked = (
      await Promise.all(preferences.map((file) => readFile(file, "utf8").catch(() => "")))
    ).some((text) => text.includes('"turnInFlight"'));
    if (prompts >= turns && marked) return;
    if (Date.now() > deadline) throw new Error(`Turn ${turns} never reached the CLI`);
    await Bun.sleep(20);
  }
}

// A real Claude bridge process is killed while the reviewer's (or step's)
// turn runs, and a new one is started on the same Claude home, which is what
// quitting and reopening the app does. The new bridge has only the rollout and
// the session's preferences file to go on.
test.each([
  { owner: "reviewer", death: "bridge" },
  { owner: "step", death: "bridge" },
  { owner: "reviewer", death: "cli" },
  { owner: "step", death: "cli" },
] as const)(
  "a killed Claude $death reaches the $owner runner as a restart interruption",
  async ({ owner, death }) => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-claude-review-restart-"));
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    await mkdir(workspace);
    await mkdir(home);
    await chmod(fakeClaude, 0o755);
    const token = "claude-restart-test-token";
    const stderrs: Promise<string>[] = [];
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const startBridge = async (): Promise<HttpBridgeProvider> => {
      child = Bun.spawn([process.execPath, harness], {
        cwd: workspace,
        env: {
          ...process.env,
          NODE_ENV: "test",
          HOME: home,
          CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
          CLAUDE_BRIDGE_NO_SERVER: "1",
          CLAUDE_BRIDGE_TOKEN: token,
          CLAUDE_CLI_PATH: fakeClaude,
          CWD: workspace,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Drain diagnostics while the subprocess runs so its stderr cannot stall.
      stderrs.push(new Response(child.stderr as ReadableStream).text());
      const port = await readyPort(child.stdout as ReadableStream<Uint8Array>);
      return new HttpBridgeProvider(
        { agent: "claude", baseUrl: `http://127.0.0.1:${port}`, authToken: token },
        (async (input, init) => {
          requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
          return fetch(input, init);
        }) as typeof fetch,
      );
    };
    const requests: string[] = [];
    // The app quitting: no shutdown path runs, the turn simply stops.
    const killBridge = async () => {
      child!.kill("SIGKILL");
      await child!.exited;
    };
    const timeout = setTimeout(() => child?.kill("SIGKILL"), 50_000);
    const storage = new StorageService(path.join(root, "data"));
    let service: MultiReviewService | undefined;
    try {
      let provider = await startBridge();
      await storage.init();
      const environmentId = "env-claude-restart";
      await storage.addEnvironment({
        id: environmentId,
        projectId: "project-1",
        name: "Claude restart test",
        branch: "change",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date().toISOString(),
        networkAccessMode: "full",
        order: 0,
        environmentType: "local",
        worktreePath: workspace,
        setupScriptsComplete: true,
      });
      const invoke = async <T>(command: string): Promise<T> => {
        if (command !== "get_environment_uncommitted_paths")
          throw new Error(`Unexpected command: ${command}`);
        return { head: "1".repeat(40), paths: [], fingerprint: "a".repeat(64) } as T;
      };
      const runner = new MultiReviewService(storage, invoke, {
        autoAdvance: false,
        provider: async () => provider,
      });
      service = runner;
      const selection = { agent: "claude" as const, model: "default" };
      const id = "workflow-claude-restart";
      const read = async () =>
        (await storage.getMultiReviewWorkflow(id))!.snapshot as MultiReviewWorkflow;
      const record = (workflow: MultiReviewWorkflow) =>
        owner === "step" ? workflow.activeRequest! : workflow.reviewers[0]!;
      const dispatchState = (workflow: MultiReviewWorkflow) =>
        owner === "step" ? workflow.activeRequest?.state : workflow.reviewers[0]?.dispatchState;
      const timestamp = new Date().toISOString();
      await storage.createMultiReviewWorkflowIfNoActive(
        id,
        environmentId,
        MULTI_REVIEW_WORKFLOW_VERSION,
        {
          version: MULTI_REVIEW_WORKFLOW_VERSION,
          controller: "backend",
          id,
          environmentId,
          projectId: "project-1",
          targetBranch: "main",
          phase: owner === "step" ? "preparing" : "reviewing",
          reviewers: [
            { ...selection, id: "reviewer-1", status: "pending", sessionKey: "reviewer-claude" },
          ],
          reviewModel: selection,
          fixModel: selection,
          reviewWorktreeSnapshot: await captureReviewWorktreeSnapshot(
            invoke,
            environmentId,
            "Multi Review",
          ),
          createdAt: timestamp,
          updatedAt: timestamp,
          backendRevision: 0,
        } satisfies MultiReviewWorkflow,
      );
      for (let pass = 0; pass < 5 && dispatchState(await read()) !== "sent"; pass++)
        await runner.advanceNow(id);
      const first = await read();
      expect(dispatchState(first)).toBe("sent");
      const sessionId =
        owner === "step"
          ? first.reviewSession!.providerSessionId
          : first.reviewers[0]!.providerSessionId!;
      const firstRequestId = record(first).requestId!;
      expect(await provider.observeSession(sessionId)).toMatchObject({ status: "running" });

      const advanceUntil = async (done: (workflow: MultiReviewWorkflow) => boolean) => {
        for (let pass = 0; pass < 4 && !done(await read()); pass++) await runner.advanceNow(id);
        expect(done(await read())).toBe(true);
      };
      const restart = async () => {
        if (death === "bridge") {
          await killBridge();
          provider = await startBridge();
        } else {
          // Kill only the CLI this fixture recorded after accepting the turn;
          // the bridge and its HTTP connection remain alive throughout.
          const pid = Number(await readFile(path.join(home, "claude-test-turn.pid"), "utf8"));
          process.kill(pid, "SIGKILL");
          const deadline = Date.now() + 15_000;
          while ((await readProviderStatus(provider, sessionId)).status !== "error") {
            if (Date.now() > deadline) throw new Error("CLI death was not observed");
            await Bun.sleep(20);
          }
        }
      };
      await waitForTurnUnderWay(home, 1);
      await restart();
      expect(await readProviderStatus(provider, sessionId, firstRequestId)).toMatchObject({
        status: "error",
        interruption: "restart",
      });
      // The runner still holds the dead bridge's connection: its first read
      // is unreachable, which keeps the record and drops the connection, and
      // the next pass reads the new bridge.
      await advanceUntil((workflow) => record(workflow).restartContinuationSent === true);
      const queued = await read();
      const nextId = record(queued).requestId!;
      expect(nextId).not.toBe(firstRequestId);
      expect(record(queued).restartContinuationSent).toBe(true);
      expect(dispatchState(queued)).toBe("prepared");
      await runner.advanceNow(id);
      expect(dispatchState(await read())).toBe("sent");
      // The continuation runs in the same session, resumed from its rollout.
      expect(await provider.observeSession(sessionId)).toMatchObject({ status: "running" });
      await waitForTurnUnderWay(home, 2);

      // The continuation is spent, so a second restart fails closed.
      await restart();
      await advanceUntil((workflow) =>
        owner === "step" ? workflow.phase === "failed" : workflow.reviewers[0]!.status === "failed",
      );
      const failed = await read();
      expect(owner === "step" ? failed.phase : failed.reviewers[0]!.status).toBe("failed");
      expect(owner === "step" ? failed.error : failed.reviewers[0]!.error).toContain(
        death === "bridge"
          ? "restarted before this turn finished"
          : "stopped (SIGKILL) before this turn finished",
      );
      expect(requests.filter((request) => request.endsWith("/prompt"))).toHaveLength(2);
      // The Claude snapshot route carries the interruption, not `/status`.
      expect(requests).toContain(`GET /session/${sessionId}`);
    } catch (error) {
      child?.kill("SIGKILL");
      await child?.exited;
      const diagnostics = (await Promise.all(stderrs)).join("\n---\n").slice(-6_000);
      throw new Error(`${String(error)}\nBridge diagnostics:\n${diagnostics}`, { cause: error });
    } finally {
      clearTimeout(timeout);
      await service?.shutdown();
      storage.close();
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await child?.exited;
      await Promise.all(stderrs);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
