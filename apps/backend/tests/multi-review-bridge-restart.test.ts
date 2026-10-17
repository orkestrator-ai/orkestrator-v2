import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
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

const fakeCodex = path.resolve(
  import.meta.dir,
  "../../../bridges/codex-bridge/src/testing/fake-codex-app-server.mjs",
);

async function readyPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stdout.getReader();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Bridge exited before startup");
      text += new TextDecoder().decode(chunk.value);
      if (text.length > 4_096) throw new Error("Unexpected bridge startup output");
      const ready = text
        .split("\n")
        .find((line) => line.startsWith('{"port":') && line.endsWith("}"));
      if (ready) return (JSON.parse(ready) as { port: number }).port;
    }
  } finally {
    reader.releaseLock();
  }
}

test.each(["reviewer", "step"] as const)(
  "a real Codex app-server restart reaches the %s runner through HttpBridgeProvider",
  async (owner) => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-review-restart-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await chmod(fakeCodex, 0o755);
    const token = "restart-test-token";
    const child = Bun.spawn(
      [process.execPath, path.join(path.dirname(fakeCodex), "multi-review-restart-harness.ts")],
      {
        cwd: workspace,
        env: {
          ...process.env,
          NODE_ENV: "test",
          CODEX_BRIDGE_NO_SERVER: "1",
          CODEX_PATH: fakeCodex,
          CODEX_HOME: path.join(root, "codex-home"),
          CWD: workspace,
          CODEX_BRIDGE_TOKEN: token,
          FAKE_CODEX_SCRIPT: "restart",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill("SIGTERM"), 45_000);
    // Drain diagnostics while the subprocess runs so its stderr cannot stall.
    const stderr = new Response(child.stderr).text();
    const storage = new StorageService(path.join(root, "data"));
    let service: MultiReviewService | undefined;
    try {
      const port = await readyPort(child.stdout);
      const baseUrl = `http://127.0.0.1:${port}`;
      await storage.init();
      const environmentId = "env-restart-stack";
      await storage.addEnvironment({
        id: environmentId,
        projectId: "project-1",
        name: "Restart test",
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
      const requests: string[] = [];
      const provider = new HttpBridgeProvider(
        { agent: "codex", baseUrl, authToken: token },
        (async (input, init) => {
          requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
          return fetch(input, init);
        }) as typeof fetch,
      );
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
      const selection = { agent: "codex" as const, model: "default" };
      const id = "workflow-restart-stack";
      const read = async () =>
        (await storage.getMultiReviewWorkflow(id))!.snapshot as MultiReviewWorkflow;
      const record = (workflow: MultiReviewWorkflow) =>
        owner === "step" ? workflow.activeRequest! : workflow.reviewers[0]!;
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
            { ...selection, id: "reviewer-1", status: "pending", sessionKey: "reviewer-stack" },
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
      const dispatchState = (workflow: MultiReviewWorkflow) =>
        owner === "step" ? workflow.activeRequest?.state : workflow.reviewers[0]?.dispatchState;
      for (let pass = 0; pass < 5 && dispatchState(await read()) !== "sent"; pass++)
        await runner.advanceNow(id);
      const first = await read();
      expect(dispatchState(first)).toBe("sent");
      const sessionId =
        owner === "step"
          ? first.reviewSession!.providerSessionId
          : first.reviewers[0]!.providerSessionId!;
      const firstRequestId = record(first).requestId!;
      const restart = async () => {
        const response = await fetch(
          `${baseUrl}/__restart?sessionId=${encodeURIComponent(sessionId)}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(20_000),
          },
        );
        expect(response.status).toBe(200);
        await response.json();
      };
      await restart();
      expect(await readProviderStatus(provider, sessionId, firstRequestId)).toMatchObject({
        status: "error",
        interruption: "restart",
      });
      await runner.advanceNow(id);
      const queued = await read();
      const nextId = record(queued).requestId!;
      expect(nextId).not.toBe(firstRequestId);
      expect(record(queued).restartContinuationSent).toBe(true);
      expect(dispatchState(queued)).toBe("prepared");
      await runner.advanceNow(id);
      expect(dispatchState(await read())).toBe("sent");
      expect(await provider.observeSession(sessionId)).toMatchObject({ status: "running" });
      await restart();
      await runner.advanceNow(id);
      const failed = await read();
      expect(owner === "step" ? failed.phase : failed.reviewers[0]!.status).toBe("failed");
      expect(owner === "step" ? failed.error : failed.reviewers[0]!.error).toContain(
        "restarted before this turn finished",
      );
      expect(requests.filter((request) => request.endsWith("/prompt"))).toHaveLength(2);
      expect(await provider.dispatchStatus(sessionId, firstRequestId)).toBe("dispatched");
      expect(await provider.dispatchStatus(sessionId, nextId)).toBe("dispatched");
      expect(requests).toContain(`GET /session/${sessionId}/status`);
    } catch (error) {
      child.kill("SIGTERM");
      await child.exited;
      throw new Error(`${String(error)}\nBridge diagnostics:\n${(await stderr).slice(-4_000)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      await service?.shutdown();
      storage.close();
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      await stderr;
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
