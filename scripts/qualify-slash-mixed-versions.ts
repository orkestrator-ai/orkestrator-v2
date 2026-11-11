#!/usr/bin/env bun
/**
 * 0015 task 1: slash commands across the support-window floor and this
 * checkout, credential-free.
 *
 *   bun scripts/qualify-slash-mixed-versions.ts [options]
 *
 *   --tag <tag>        the floor release to pair with (default v2.21.0)
 *   --only <pairing>   run one pairing: `floor-backend` or `floor-renderer`
 *   --report <file>    write the evidence as JSON
 *   --keep             keep the temporary root (for iterating on the harness)
 *
 * The floor is built from its tag: `git archive` into a private temporary
 * directory and `bun install --frozen-lockfile --ignore-scripts`. Pi is the
 * provider because its bridge runs its SDK in process: a loopback
 * chat-completions fake stands in for the model (a placeholder key, no login,
 * no billed turn), and a user prompt template carrying a random nonce is the
 * command under test. Every backend gets its own temporary data directory,
 * worktree directory and HOME, binds loopback only, and runs with every
 * inherited `ORKESTRATOR_*` and `PI_*` variable removed. The gateway token is
 * read from the data directory and never printed.
 *
 * Pairings:
 *
 * - `floor-backend`: the floor's backend (`apps/backend/src/main.ts` from the
 *   tag) launching this checkout's built Pi bridge. The floor's resource
 *   root is its own `bridges` directory, whose `pi-bridge` holds this
 *   checkout's `dist` and `package.json`.
 * - `floor-renderer`: this checkout's backend and Pi bridge, driven with the
 *   floor renderer's registry calls, and every progressive (sync-v1) read is
 *   checked with the floor renderer's own validators, imported from the tag.
 *   A validator that refuses a response is the floor renderer's "Invalid
 *   native agent ... update response".
 *
 * Both are driven with the floor renderer's calls (`dispatch_native_agent_intent`
 * with a command intent, `refresh_native_agent_commands`,
 * `get_native_agent_discovery_update`), because the floor's CLI has no
 * catalogue verbs. Each pairing passes when: the catalogue reads `ready` and
 * lists the template with an id and a binding revision; a selected command
 * reaches the model expanded (the nonce, not the slash text); an unknown
 * command and a stale binding are refused and reach no model; a literal
 * submission reaches the model as the slash text; and every progressive read
 * passes the floor validators.
 *
 * Exits 0 when every assertion held, 1 when one did not, 2 on setup errors.
 */
import { LEGACY_ENABLED_AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dir, "..");

class SetupError extends Error {}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const tag = option("--tag", "v2.21.0");
const only = option("--only", "");
const reportPath = option("--report", "");
const keep = process.argv.includes("--keep");
const scratch = mkdtempSync(path.join(os.tmpdir(), "ork-slash-mixed-"));
const FLOOR = path.join(scratch, "floor");
const FIXTURE = path.join(scratch, "fixture");
const NONCE = randomBytes(12).toString("hex");
const TEMPLATE = "ork-mv-template";
const MODEL = "ork-fake/fake-model";

const evidence: Array<Record<string, unknown>> = [];
const failures: string[] = [];
function note(step: string, detail: Record<string, unknown> = {}) {
  evidence.push({ step, ...detail });
  console.log(JSON.stringify({ step, ...detail }));
}
function check(condition: boolean, message: string) {
  if (!condition) failures.push(message);
}

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0)
    throw new SetupError(`${command} ${args[0]}: ${(result.stderr ?? "").trim().slice(-2_000)}`);
  return result.stdout;
}

// --- The model fake -------------------------------------------------------

/** What each model request carried: only the classification, never the text. */
const modelRequests: Array<{ nonce: boolean; slash: boolean }> = [];

function lastUserText(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages;
  const user = Array.isArray(messages) ? messages.findLast((m) => m?.role === "user") : undefined;
  const content = user?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part?.text === "string" ? (part.text as string) : ""))
      .join("");
  return "";
}

function startModelFake() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models"))
        return Response.json({ object: "list", data: [{ id: "fake-model", object: "model" }] });
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 });
      const body = (await request.json().catch(() => ({}))) as { stream?: boolean };
      const text = lastUserText(body).trimStart();
      modelRequests.push({ nonce: text.includes(NONCE), slash: text.startsWith(`/${TEMPLATE}`) });
      const base = { id: `chatcmpl-${randomUUID()}`, created: 0, model: "fake-model" };
      const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
      if (!body.stream)
        return Response.json({
          ...base,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage,
        });
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...extra })}\n\n`;
      const frames = [
        chunk([{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }]),
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage }),
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
}

// --- Setup ----------------------------------------------------------------

async function prepareFloor() {
  await mkdir(FLOOR, { recursive: true, mode: 0o700 });
  const archive = spawnSync("git", ["archive", tag], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new SetupError(`git archive ${tag} failed`);
  const untar = spawnSync("tar", ["-x", "-C", FLOOR], { input: archive.stdout });
  if (untar.status !== 0) throw new SetupError("extracting the floor archive failed");
  run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], FLOOR);
  // The floor resolves its Pi bridge from `<resource root>/pi-bridge`;
  // `floor-backend` puts this checkout's built bridge there.
  const current = path.join(ROOT, "bridges", "pi-bridge");
  if (!existsSync(path.join(current, "dist", "index.js")))
    throw new SetupError("bridges/pi-bridge is not built; run `mise run build:pi-bridge`");
  const floorBridge = path.join(FLOOR, "bridges", "pi-bridge");
  await rm(floorBridge, { recursive: true, force: true });
  await mkdir(floorBridge);
  await symlink(path.join(current, "dist"), path.join(floorBridge, "dist"));
  await copyFile(path.join(current, "package.json"), path.join(floorBridge, "package.json"));
}

async function prepareFixture() {
  const origin = path.join(FIXTURE, "origin.git");
  const project = path.join(FIXTURE, "project");
  await mkdir(project, { recursive: true, mode: 0o700 });
  run("git", ["init", "--bare", origin]);
  run("git", ["init", "-b", "main"], project);
  run("git", ["config", "user.name", "Slash Mixed Fixture"], project);
  run("git", ["config", "user.email", "fixture@invalid.local"], project);
  await writeFile(path.join(project, "README.md"), "# slash mixed versions\n");
  run("git", ["add", "."], project);
  run("git", ["commit", "-m", "init"], project);
  run("git", ["remote", "add", "origin", origin], project);
  run("git", ["push", "-u", "origin", "main"], project);
  return { origin, project };
}

async function prepareHome(home: string, modelPort: number) {
  const agentDir = path.join(home, ".pi", "agent");
  await mkdir(path.join(agentDir, "prompts"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        "ork-fake": {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: "openai-completions",
          apiKey: "placeholder",
          models: [{ id: "fake-model", name: "Fake model", contextWindow: 32_000, maxTokens: 512 }],
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ defaultProvider: "ork-fake", defaultModel: "fake-model" })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(agentDir, "prompts", `${TEMPLATE}.md`),
    `---\ndescription: Mixed-version qualification template\n---\nReply with ok. Marker ${NONCE}.\n`,
    { mode: 0o600 },
  );
  return agentDir;
}

// --- One backend ----------------------------------------------------------

interface Backend {
  child: ChildProcess;
  port: number;
  dataDir: string;
  output: string[];
}

async function invoke<T>(backend: Backend, command: string, args: object = {}): Promise<T> {
  const token = JSON.parse(await readFile(path.join(backend.dataDir, "gateway-auth.json"), "utf8"))
    .token as string;
  const response = await fetch(`http://127.0.0.1:${backend.port}/__orkestrator/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => ({}))) as { result?: T; error?: unknown };
  if (!response.ok) {
    throw new Error(
      `${command}: HTTP ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}`,
    );
  }
  return body.result as T;
}

async function startBackend(
  appRoot: string,
  root: string,
  agentDir: string,
  home: string,
): Promise<Backend> {
  const dataDir = path.join(root, "data");
  const worktreeDir = path.join(root, "worktrees");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(worktreeDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(dataDir, "agent-platforms.json"),
    `${JSON.stringify({ enabled: [...new Set([...LEGACY_ENABLED_AGENT_PLATFORMS, "pi"])] })}\n`,
    { mode: 0o600 },
  );
  const port = 36_000 + Math.floor(Math.random() * 2_000);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("ORKESTRATOR_") && !key.startsWith("PI_"),
      ),
    ),
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
  };
  const child = spawn(
    "bun",
    [
      path.join(appRoot, "apps", "backend", "src", "main.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--allow-non-tailscale-bind",
      "--data-dir",
      dataDir,
      "--worktree-dir",
      worktreeDir,
      "--app-root",
      appRoot,
      // Explicit, because a shell started by a packaged app inherits
      // NODE_ENV=production, which skips the `<app root>/bridges` lookup.
      "--resource-root",
      path.join(appRoot, "bridges"),
      "--control-port",
      String(port + 1),
    ],
    { cwd: path.join(appRoot, "apps", "backend"), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: string[] = [];
  const keepOutput = (chunk: unknown) => {
    output.push(String(chunk));
    if (output.length > 4_000) output.shift();
  };
  child.stdout!.on("data", keepOutput);
  child.stderr!.on("data", keepOutput);
  const backend = { child, port, dataDir, output };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new SetupError(`backend at ${appRoot} exited ${child.exitCode}`);
    try {
      await invoke<string>(backend, "get_app_version");
      return backend;
    } catch {
      await Bun.sleep(500);
    }
  }
  child.kill("SIGKILL");
  throw new SetupError(`backend at ${appRoot} did not start`);
}

async function stopBackend(backend: Backend) {
  const { child } = backend;
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(20_000).then(() => child.kill("SIGKILL"))]);
}

// --- The floor renderer's view of a backend --------------------------------

interface FloorValidators {
  isNativeAgentProjectionUpdate(value: unknown): boolean;
  isNativeAgentTranscriptUpdate(value: unknown): boolean;
  isNativeAgentSessionStateUpdate(value: unknown): boolean;
  isNativeAgentDiscoveryUpdate(value: unknown): boolean;
}

type Outcome =
  | { outcome: "accepted"; requestId: string }
  | { outcome: "rejected"; error: string }
  | { outcome: "unknown"; requestId: string; error?: string };

interface CommandRow {
  name?: string;
  id?: string;
  bindingRevision?: string;
}

async function runPairing(
  pairing: "floor-backend" | "floor-renderer",
  validators: FloorValidators,
  modelPort: number,
  fixture: { origin: string; project: string },
) {
  const root = path.join(scratch, pairing);
  const home = path.join(root, "home");
  const agentDir = await prepareHome(home, modelPort);
  const appRoot = pairing === "floor-backend" ? FLOOR : ROOT;
  const backend = await startBackend(appRoot, root, agentDir, home);
  const at = (step: string, detail: Record<string, unknown> = {}) =>
    note(`${pairing}: ${step}`, detail);
  try {
    at("backend up", { version: await invoke<string>(backend, "get_app_version") });
    const { id: projectId } = await invoke<{ id: string }>(backend, "add_project", {
      gitUrl: fixture.origin,
      localPath: fixture.project,
    });
    const { id: environmentId } = await invoke<{ id: string }>(backend, "create_environment", {
      projectId,
      name: `slash-${pairing}`,
      environmentType: "local",
      networkAccessMode: "restricted",
    });
    await invoke(backend, "start_environment", { environmentId });
    await invoke(backend, "update_environment_agent_settings", {
      environmentId,
      agentSettings: { executionPolicy: { projectResources: true } },
    });
    const session = { environmentId, agent: "pi", logicalSessionKey: `tab-${randomUUID()}` };

    const stateRead = async () => {
      const update = await invoke<{ status?: string; value?: { turn?: { phase?: string } } }>(
        backend,
        "get_native_agent_session_state_update",
        { ...session, viewVersion: 1, forceSnapshot: true },
      );
      check(
        validators.isNativeAgentSessionStateUpdate(update),
        `${pairing}: the floor renderer refuses a session-state update`,
      );
      return update.value?.turn?.phase;
    };
    const settle = async (requestsBefore: number, expectModel: boolean) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const phase = await stateRead().catch(() => undefined);
        const reached = modelRequests.length > requestsBefore;
        if ((reached || !expectModel) && (phase === "idle" || phase === "error")) return phase;
        await Bun.sleep(500);
      }
      return "timeout";
    };
    const dispatch = async (prompt: string, command: Record<string, unknown>) => {
      const before = modelRequests.length;
      let outcome: Outcome | { outcome: "refused-by-error"; error: string };
      try {
        outcome = await invoke<Outcome>(backend, "dispatch_native_agent_intent", {
          ...session,
          prompt,
          requestId: randomUUID(),
          model: MODEL,
          modelSource: "explicit",
          command,
        });
      } catch (error) {
        outcome = { outcome: "refused-by-error", error: String(error).slice(0, 300) };
      }
      const accepted = outcome.outcome === "accepted" || outcome.outcome === "unknown";
      const phase = accepted ? await settle(before, true) : (await Bun.sleep(2_000), "not-run");
      const error = "error" in outcome ? outcome.error?.slice(0, 300) : undefined;
      return { outcome: outcome.outcome, error, phase, reached: modelRequests.slice(before) };
    };

    // A first turn creates the session the catalogue belongs to.
    const first = await dispatch("Reply with ok.", { kind: "literal" });
    at("first turn", {
      outcome: first.outcome,
      error: first.error,
      phase: first.phase,
      reached: first.reached.length,
    });
    check(first.reached.length > 0, `${pairing}: the first turn never reached the model`);

    const refresh = await invoke<{ outcome?: string }>(
      backend,
      "refresh_native_agent_commands",
      session,
    );
    // The floor renderer polls discovery; a `loading` section settles later.
    type Discovery = {
      status?: string;
      value?: {
        sections?: {
          commands?: { availability?: string; revision?: number; value?: CommandRow[] };
        };
      };
    };
    let discovery: Discovery = {};
    let reads = 0;
    const discoveryDeadline = Date.now() + 60_000;
    do {
      if (reads > 0) await Bun.sleep(1_000);
      reads += 1;
      discovery = await invoke<Discovery>(backend, "get_native_agent_discovery_update", {
        ...session,
        viewVersion: 1,
        sections: ["commands"],
        forceSnapshot: true,
      });
      check(
        validators.isNativeAgentDiscoveryUpdate(discovery),
        `${pairing}: the floor renderer refuses the discovery update`,
      );
    } while (
      discovery.value?.sections?.commands?.availability === "loading" &&
      Date.now() < discoveryDeadline
    );
    const commands = discovery.value?.sections?.commands;
    const row = commands?.value?.find((candidate) => candidate.name?.includes(TEMPLATE));
    at("catalogue", {
      refresh: refresh?.outcome,
      reads,
      availability: commands?.availability,
      revision: commands?.revision,
      rows: commands?.value?.length ?? 0,
      templateId: row?.id,
      hasBindingRevision: Boolean(row?.bindingRevision),
    });
    check(commands?.availability === "ready", `${pairing}: the catalogue is not ready`);
    check(Boolean(row?.id), `${pairing}: the template is not listed with an id`);

    if (row?.id) {
      const selected = await dispatch(`/${TEMPLATE}`, {
        kind: "selected",
        commandId: row.id,
        ...(row.bindingRevision ? { bindingRevision: row.bindingRevision } : {}),
      });
      at("selected command", {
        outcome: selected.outcome,
        phase: selected.phase,
        expanded: selected.reached.some((request) => request.nonce),
        slashText: selected.reached.some((request) => request.slash),
      });
      check(
        selected.reached.some((request) => request.nonce && !request.slash),
        `${pairing}: the selected template did not reach the model expanded`,
      );

      const stale = await dispatch(`/${TEMPLATE}`, {
        kind: "selected",
        commandId: row.id,
        bindingRevision: "stale-binding-revision",
      });
      at("stale binding", { outcome: stale.outcome, reached: stale.reached.length });
      check(
        stale.outcome !== "accepted" && stale.reached.length === 0,
        `${pairing}: a stale binding was not refused`,
      );
    }

    const unknown = await dispatch("/ork-mv-missing", {
      kind: "selected",
      commandId: "pi:template:ork-mv-missing",
    });
    at("unknown command", { outcome: unknown.outcome, reached: unknown.reached.length });
    check(
      unknown.outcome !== "accepted" && unknown.reached.length === 0,
      `${pairing}: an unknown command was not refused`,
    );

    const literal = await dispatch(`/${TEMPLATE}`, { kind: "literal" });
    at("literal", {
      outcome: literal.outcome,
      phase: literal.phase,
      slashText: literal.reached.some((request) => request.slash),
      expanded: literal.reached.some((request) => request.nonce),
    });
    check(
      literal.reached.some((request) => request.slash && !request.nonce),
      `${pairing}: a literal submission did not reach the model as the slash text`,
    );

    // The floor renderer's sync-v1 polling reads.
    const projection = await invoke(backend, "get_native_agent_projection_update", {
      ...session,
      syncVersion: 1,
      // The floor renderer's DEFAULT_NATIVE_AGENT_LIVE_WINDOW.
      liveWindow: { messages: 100, targetBytes: 512 * 1024 },
      forceSnapshot: true,
    });
    const transcript = await invoke(backend, "get_native_agent_transcript_update", {
      ...session,
      viewVersion: 1,
      liveWindow: { messages: 100, targetBytes: 512 * 1024 },
      forceSnapshot: true,
    });
    const projectionValid = validators.isNativeAgentProjectionUpdate(projection);
    const transcriptValid = validators.isNativeAgentTranscriptUpdate(transcript);
    at("progressive reads", { projectionValid, transcriptValid });
    check(projectionValid, `${pairing}: Invalid native agent projection update response`);
    check(transcriptValid, `${pairing}: Invalid native agent transcript update response`);
    const projectionErrors = backend.output.join("").includes("Invalid native agent projection");
    check(!projectionErrors, `${pairing}: the backend logged an invalid projection`);
  } finally {
    await stopBackend(backend);
  }
}

async function main() {
  if (only && only !== "floor-backend" && only !== "floor-renderer")
    throw new SetupError(`unknown --only ${only}`);
  note("setup", { tag, nonceLength: NONCE.length });
  await prepareFloor();
  const fixture = await prepareFixture();
  const validators = (await import(
    path.join(FLOOR, "packages", "protocol", "src", "native-agent.ts")
  )) as FloorValidators;
  const fake = startModelFake();
  try {
    for (const pairing of ["floor-backend", "floor-renderer"] as const) {
      if (only && only !== pairing) continue;
      await runPairing(pairing, validators, fake.port!, fixture);
    }
  } finally {
    await fake.stop(true);
  }
}

let exitCode = 0;
try {
  await main();
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  failures.push(String(error instanceof Error ? error.message : error).slice(0, 2_000));
  exitCode = error instanceof SetupError ? 2 : 1;
} finally {
  const report = { tag, passed: exitCode === 0, failures, evidence };
  if (reportPath)
    await writeFile(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  console.log(JSON.stringify({ passed: exitCode === 0, failures }));
  if (keep) console.log(JSON.stringify({ kept: scratch }));
  else await rm(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
