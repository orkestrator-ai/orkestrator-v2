/**
 * End-to-end proof that the bridge's HTTP surface works over a real spawned
 * `codex app-server` process.
 *
 * Everything else in this suite tests components with in-memory doubles. This
 * spawns an actual child, which is the only way to cover the supervisor's spawn
 * arguments, JSONL framing over real OS pipes, the initialize handshake, and the
 * route wiring all lining up.
 */
import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeCodex = join(import.meta.dir, "testing", "fake-codex-app-server.mjs");
const harness = join(import.meta.dir, "testing", "http-flag-harness.ts");

interface StepResult {
  step: string;
  status: number;
  body: Record<string, unknown>;
}

interface HarnessOutput {
  engine?: string;
  results?: StepResult[];
  error?: string;
}

let workspace = "";
let codexHome = "";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ork-flag-ws-"));
  codexHome = mkdtempSync(join(tmpdir(), "ork-flag-home-"));
  chmodSync(fakeCodex, 0o755);
});

afterEach(() => {
  for (const dir of [workspace, codexHome]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function run(env: Record<string, string>): Promise<HarnessOutput> {
  const proc = Bun.spawn(["bun", harness], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_BRIDGE_NO_SERVER: "1",
      CODEX_PATH: fakeCodex,
      CODEX_HOME: codexHome,
      CWD: workspace,
      FAKE_CODEX_SCRIPT: "auto-complete",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) {
    throw new Error(`harness produced no output (exit ${code}):\n${stderr.slice(0, 3_000)}`);
  }
  return JSON.parse(line) as HarnessOutput;
}

function step(output: HarnessOutput, name: string): StepResult {
  const found = output.results?.find((entry) => entry.step === name);
  if (!found) throw new Error(`missing step ${name}: ${JSON.stringify(output).slice(0, 800)}`);
  return found;
}

describe("app-server engine over HTTP", () => {

  test("serves the whole session lifecycle through the real routes", async () => {
    const output = await run({});
    expect(output.error).toBeUndefined();
    expect(output.engine).toBe("app-server");

    // Health reflects the live child, including the version it reported.
    const health = step(output, "health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: "ok",
      engine: "app-server",
      appServer: { state: "ready", generation: 1, codexVersion: "0.145.0" },
    });
    expect((health.body.appServer as Record<string, unknown>).pid).toBeGreaterThan(0);

    // Models come from model/list, with the server's ordering preserved.
    const models = step(output, "models");
    expect(models.body).toMatchObject({ source: "app-server" });
    const modelList = models.body.models as Array<Record<string, unknown>>;
    expect(modelList[0]).toMatchObject({ id: "fake-model" });
    expect(modelList[0]!.reasoningEfforts).toEqual(["low", "medium", "high"]);

    expect(step(output, "create").status).toBe(201);

    // 202 with the identifiers the frontend needs to reconcile a reconnect.
    const prompt = step(output, "prompt");
    expect(prompt.status).toBe(202);
    expect(prompt.body).toMatchObject({
      status: "processing",
      requestId: "req-http-1",
      threadId: "fake-thread-1",
      turnId: "fake-turn-1",
    });

    // The streamed delta was replaced by the authoritative item.
    const messages = step(output, "messages").body.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.content).toBe("done");

    const status = step(output, "status");
    expect(status.body).toMatchObject({ status: "idle", phase: "idle", engineGeneration: 1 });

    expect(step(output, "config-update").body).toMatchObject({
      status: "updated",
      durable: true,
    });
    expect(step(output, "config-read").body).toMatchObject({
      model: "fake-model",
      modelReasoningEffort: "high",
      mode: "plan",
      fastMode: true,
      durable: true,
    });

    // Re-sending the same request id must not start a second turn.
    expect(step(output, "duplicate-prompt").body).toMatchObject({
      status: "already-processed",
      duplicate: true,
    });

    expect(step(output, "delete").body).toMatchObject({ status: "deleted" });
  }, 60_000);


  test("a version-mismatched binary still starts, and health reports what it found", async () => {
    // The bridge does not pin the binary version at runtime — the generated
    // protocol check does that at build time — so a mismatch must degrade
    // visibly rather than crash the bridge and leave the backend with nothing.
    const output = await run({ FAKE_CODEX_VERSION: "0.99.0" });

    expect(output.engine).toBe("app-server");
    expect(step(output, "health").body).toMatchObject({
      appServer: { state: "ready", codexVersion: "0.99.0" },
    });
  }, 60_000);

  test("reports a bounded, actionable error when the handshake never completes", async () => {
    const output = await run({ FAKE_CODEX_SCRIPT: "no-initialize" });

    expect(output.results).toBeUndefined();
    expect(output.error).toMatch(
      /app-server did not become ready within 5 seconds \(last state: (starting|recovering)\)/,
    );
  }, 60_000);
});
