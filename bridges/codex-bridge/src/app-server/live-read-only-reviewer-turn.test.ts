/**
 * A whole Multi Review reviewer turn without Codex's command sandbox, on the
 * **real** pinned `codex app-server` behind the bridge's own runtime: the
 * read-only container canary of to-do 7872 (retired), task 1, outside the
 * container.
 *
 * The session carries the container execution policy, so the runtime decides
 * the turn runs without Codex's sandbox exactly as it does in an
 * environment's container (`codexReadOnlyCommandSandboxOff`), writes its
 * exec-policy rules into this test's `CODEX_HOME` and declines every approval
 * through the server-request router. The model is
 * `e2e/agent-testing/container-fake-codex-review-api.ts`, the same scripted
 * reviewer the container spec copies into the image: it reads the package,
 * lists the workspace, asks for the package's `git diff` (declined), reads
 * the sealed diff file, tries a `touch` and an `apply_patch` (both declined)
 * and submits through a loopback MCP server standing in for Orkestrator's
 * agent tools. Nothing reaches a model and no credits are spent. Gated like
 * the other live contract tests because it needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-read-only-reviewer-turn.test.ts
 *
 * What this cannot show is the container itself: Docker's seccomp profile,
 * the image's `codex` and a backend-issued submit credential. That is
 * `e2e/agent-testing/container-multi-review-codex-read-only.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { workflowResultInstruction } from "@orkestrator/protocol/workflow-results";
import {
  PATCH_PROBE_FILE,
  serveFakeCodexReviewApi,
  WRITE_PROBE_FILE,
} from "../../../../e2e/agent-testing/container-fake-codex-review-api.js";
import { AppServerRuntime } from "../app-server-runtime.js";
import { codexAppServerConfigOverrides } from "../codex-config.js";
import { CODEX_READ_ONLY_RULES_FILENAME } from "../codex-read-only-exec-rules.js";
import { CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER } from "../codex-read-only-sandbox.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import { resolveCodexBinary } from "./live-binary.js";

// See `live-contract.test.ts`: the test preload replaces `Response`, and
// `Bun.serve` only accepts its own.
const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");
const NativeResponse =
  (globalThis as typeof globalThis & { [key: symbol]: { Response?: typeof Response } | undefined })[
    NATIVE_WEB_PLATFORM_KEY
  ]?.Response ?? Response;

// The sandbox-off decision is Linux-only: elsewhere Codex's own sandbox runs.
const LIVE = process.env.RUN_LIVE_CODEX_APP_SERVER === "1" && process.platform === "linux";
const describeLive = LIVE ? describe : describe.skip;

const CLIENT_INFO = { name: "orkestrator", title: "Orkestrator", version: "2.4.9" };
const RESULT_KEY = "7872c0de-0000-4000-8000-000000000001";
const SUBMIT_TOOL = "submit_review_report";
const MCP_TOKEN = "loopback-submit-probe";

const CONTAINER_POLICY: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

type SubmitCall = { authorized: boolean; resultKey?: unknown; verdict?: unknown };

/** A Streamable HTTP MCP server offering only the reviewer's submit tool. Keeps every call. */
function startSubmitServer() {
  const calls: SubmitCall[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: string | number;
      method: string;
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
    };
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const reply = (result: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") {
      reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "orkestrator", version: "1.0.0" },
      });
    } else if (message.method === "tools/list") {
      reply({
        tools: [
          {
            name: SUBMIT_TOOL,
            description: "Submit the review report.",
            inputSchema: {
              type: "object",
              properties: { resultKey: { type: "string" }, result: { type: "object" } },
              required: ["resultKey", "result"],
            },
          },
        ],
      });
    } else if (message.method === "tools/call") {
      const args = message.params?.arguments ?? {};
      calls.push({
        authorized: request.headers.authorization === `Bearer ${MCP_TOKEN}`,
        resultKey: args.resultKey,
        verdict: (args.result as { verdict?: { ready?: unknown } } | undefined)?.verdict?.ready,
      });
      reply({ content: [{ type: "text", text: "Accepted." }] });
    } else {
      reply({});
    }
  });
  return {
    calls,
    listen: () =>
      new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        }),
      ),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "QA",
      GIT_AUTHOR_EMAIL: "qa@example.invalid",
      GIT_COMMITTER_NAME: "QA",
      GIT_COMMITTER_EMAIL: "qa@example.invalid",
    },
  }).trim();
}

/** A repository with one reviewed commit, its review package and the sealed diff beside it. */
async function reviewWorkspace(root: string) {
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  git(workspace, ["init", "-q", "-b", "main"]);
  await writeFile(join(workspace, "README.md"), "fixture\n");
  git(workspace, ["add", "README.md"]);
  git(workspace, ["commit", "-q", "-m", "base"]);
  const baseRef = git(workspace, ["rev-parse", "HEAD"]);
  git(workspace, ["checkout", "-q", "-b", "change"]);
  await writeFile(join(workspace, "change.txt"), "reviewed\n");
  git(workspace, ["add", "change.txt"]);
  git(workspace, ["commit", "-q", "-m", "change"]);
  const headRef = git(workspace, ["rev-parse", "HEAD"]);
  const diffCommand = `git diff --no-textconv --no-ext-diff ${baseRef}..${headRef}`;
  const artifacts = ".orkestrator/review-artifacts/qa";
  await mkdir(join(workspace, artifacts), { recursive: true });
  const diffPath = `${artifacts}/review-diff-qa.patch`;
  await writeFile(join(workspace, diffPath), git(workspace, diffCommand.split(" ").slice(1)));
  const packagePath = `${artifacts}/review-package-qa.json`;
  await writeFile(
    join(workspace, packagePath),
    JSON.stringify({ baseRef, headRef, diffCommand, diffArtifact: { path: diffPath } }, null, 2),
  );
  return { workspace, packagePath, headRef };
}

/** The reviewer prompt's two parts the script follows, in the backend's own words. */
function reviewerPrompt(packagePath: string): string {
  return [
    `Read the review package from \`${packagePath}\` in the environment workspace before beginning the review. Do not modify, replace, or regenerate it.`,
    workflowResultInstruction("review-report", RESULT_KEY, { provisionalFindings: false }),
  ].join("\n\n");
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describeLive("live read-only reviewer turn without Codex's command sandbox", () => {
  test("reads run, writes and patches are declined, and the review is submitted", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ork-read-only-reviewer-")));
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    // Never a real key: the only server it can reach is the loopback fake.
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
      { mode: 0o600 },
    );
    const { workspace, packagePath, headRef } = await reviewWorkspace(root);
    const steps: Array<{ step: string; answered: Array<{ step: string; error: boolean }> }> = [];
    const model = serveFakeCodexReviewApi({
      ResponseType: NativeResponse,
      log: (line) => steps.push(JSON.parse(line)),
    });
    const submit = startSubmitServer();
    const mcpPort = await submit.listen();
    // The rollout reader resolves these from the environment: keep it off the
    // developer's own Codex home.
    const previous = { home: process.env.CODEX_HOME, cwd: process.env.CWD };
    process.env.CODEX_HOME = codexHome;
    process.env.CWD = workspace;
    const engine = new AppServerEngine({
      codexPath: await resolveCodexBinary(),
      cwd: workspace,
      codexHome,
      clientInfo: CLIENT_INFO,
      configOverrides: {
        ...codexAppServerConfigOverrides({}),
        openai_base_url: JSON.stringify(`http://127.0.0.1:${model.port}/v1`),
      },
      supervisorOverrides: { pidFileEnabled: false },
    });
    const runtime = new AppServerRuntime({
      engine,
      codexHome,
      cwd: workspace,
      emit: () => undefined,
      loadCachedModels: async () => ({ models: [], source: "fallback" }),
      coalesceIntervalMs: 0,
      sweepIntervalMs: 0,
      skillColdSettleMs: 0,
    });
    try {
      await runtime.start();
      const { sessionId } = runtime.createSession({ mode: "build", policy: CONTAINER_POLICY });
      const outcome = await runtime.prompt(sessionId, {
        prompt: reviewerPrompt(packagePath),
        requestId: "review-7872",
        attachments: [],
        readOnly: true,
        agentMcp: { url: `http://127.0.0.1:${mcpPort}/mcp`, token: MCP_TOKEN },
        workflowResultTool: SUBMIT_TOOL,
      });
      expect(outcome).toMatchObject({ ok: true });
      // The runtime's own decision, from the container policy.
      expect(runtime.getStatus(sessionId, false)?.readOnlyCommandSandbox).toEqual({
        state: "off",
        reason: CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER,
      });

      const finished = await waitFor(
        () => steps.find((record) => record.step === "text"),
        120_000,
        "the reviewer turn to finish",
      );
      await waitFor(
        () => (runtime.getStatus(sessionId, false)?.status === "idle" ? true : undefined),
        30_000,
        "the session to go idle",
      );
      const answered = Object.fromEntries(
        finished.answered.map((entry) => [entry.step, entry.error]),
      );
      // Reads ran through the bridge's rules; Git's diff, the write and the
      // patch were declined; the diff file stood in for the diff.
      expect(answered).toEqual({
        package: false,
        list: false,
        git: true,
        "diff-file": false,
        "write-probe": true,
        patch: true,
        submit: false,
      });
      // The submit tool ran without an approval, with the turn's credential.
      expect(submit.calls).toEqual([{ authorized: true, resultKey: RESULT_KEY, verdict: "yes" }]);
      expect(existsSync(join(workspace, WRITE_PROBE_FILE))).toBe(false);
      expect(existsSync(join(workspace, PATCH_PROBE_FILE))).toBe(false);
      // Only the package and its diff, which the test wrote, are new.
      expect(
        git(workspace, ["status", "--porcelain", "--untracked-files=all"]).split("\n"),
      ).toEqual([
        "?? .orkestrator/review-artifacts/qa/review-diff-qa.patch",
        "?? .orkestrator/review-artifacts/qa/review-package-qa.json",
      ]);
      expect(git(workspace, ["rev-parse", "HEAD"])).toBe(headRef);
      expect(
        await readFile(join(codexHome, "rules", CODEX_READ_ONLY_RULES_FILENAME), "utf8"),
      ).toContain('decision = "allow"');
      expect(runtime.getStatus(sessionId, false)?.status).toBe("idle");
    } finally {
      await runtime.stop();
      await engine.stop();
      model.stop(true);
      await submit.close();
      if (previous.home === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.home;
      if (previous.cwd === undefined) delete process.env.CWD;
      else process.env.CWD = previous.cwd;
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);
});
