#!/usr/bin/env bun
/**
 * Agent Capabilities: a leaf launch resolved across two backends (to-do 8314
 * task 10; docs/architecture/agent-capabilities-management.md, "Launching a
 * session" and "Session-private delivery").
 *
 * Two isolated backends of this checkout run as separate OS processes on this
 * machine (`two-node/harness.ts`: each with its own data directory, HOME,
 * loopback port and constructed environment, `agent-test` runtime, no
 * credentials). One is the command node, the other is enrolled as its leaf.
 * Nothing on this machine outside the run's temporary directory is read or
 * written, and no production port is bound.
 *
 * The leaf runs a real native Pi session: the leaf backend starts the real Pi
 * bridge (`bridges/pi-bridge/dist/index.js`, built from this checkout first),
 * which drives the real Pi SDK. Only the model is fake: the leaf's isolated
 * `~/.pi/agent/models.json` names an OpenAI-compatible provider served by
 * this script on loopback, which answers every request without a network
 * call and records the system prompt it was given. No provider is billed.
 *
 * Checks: the command node enrols the leaf; a required skill selected for one
 * session of the leaf (a session-scoped setup on the command node) is
 * resolved by the command node when the leaf launches that session, sent to
 * the leaf and staged there; the leaf's Pi session loads it through its own
 * skill paths (the fake model is told about it, at the staged path), nothing
 * is written into the leaf's shared Pi homes, and another Pi session on the
 * leaf does not see it; Test on the command node, which asks the leaf for the
 * session's own report, grades it `load-confirmed`.
 *
 *   bun scripts/qa-capabilities-leaf-launch.ts [--report <file>] [--keep] [--skip-build]
 *
 * Exits 0 when checks and cleanup pass, 1 for a failed check or cleanup,
 * 2 on a setup error, and 128 + signal number on interruption. Only the
 * processes it started are signalled, through their handles.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PeerNode,
  ROOT,
  SetupError,
  bindFixtureListener,
  fixtureGitEnvironment,
  makeNode,
  runSetup,
  until,
} from "./two-node/harness.ts";
import { runCapabilityQualification } from "./two-node/capability-qualification.ts";

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

const args = process.argv.slice(2);
const reportIndex = args.indexOf("--report");
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
const keep = args.includes("--keep");
const skipBuild = args.includes("--skip-build");

const checks: Check[] = [];
function check(name: string, passed: boolean, detail?: string) {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const facts: Record<string, unknown> = { keep };
const nodes: PeerNode[] = [];
let root: string | null = null;
let model: FakeModel | null = null;

const SESSION_KEY = "leaf-pi-session-1";
const OTHER_SESSION_KEY = "leaf-pi-session-2";
const SKILL = "ork-leaf-launch";
const MODEL_ID = "fake/fake-1";

/** One request the fake model answered: which prompt, and its system text. */
interface ModelRequest {
  prompt: string;
  system: string;
}

interface FakeModel {
  origin: string;
  requests: ModelRequest[];
  stop(): void;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * An OpenAI-compatible chat completions endpoint on loopback: every request is
 * answered `Answer to: <last user message>`, streamed when asked. Nothing
 * leaves this machine.
 */
function startFakeModel(): FakeModel {
  const requests: ModelRequest[] = [];
  const options = {
    hostname: "127.0.0.1",
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "fake-1", object: "model" }] });
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as {
        stream?: boolean;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const messages = body.messages ?? [];
      const system = messages
        .filter((message) => message.role === "system" || message.role === "developer")
        .map((message) => text(message.content))
        .join("\n");
      const prompt = text(messages.filter((message) => message.role === "user").at(-1)?.content);
      requests.push({ prompt, system });
      const answer = `Answer to: ${prompt.slice(0, 200)}`;
      const base = { id: "fake-completion", created: 0, model: "fake-1" };
      if (!body.stream) {
        return Response.json({
          ...base,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      const stream =
        chunk({
          ...base,
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: answer }, finish_reason: null },
          ],
        }) +
        chunk({
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) +
        "data: [DONE]\n\n";
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  };
  const server = bindFixtureListener((port) => Bun.serve({ ...options, port }));
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** A public action on `node`; the success envelope's result, or a thrown refusal. */
async function publicAction<T>(
  node: PeerNode,
  action: string,
  input: Record<string, unknown>,
  requestId?: string,
): Promise<T> {
  const envelope = await node.invoke<{ ok: boolean; result?: T; error?: unknown }>(
    "public_action",
    {
      schemaVersion: 1,
      action,
      actionVersion: 1,
      input,
      ...(requestId ? { request: { requestId } } : {}),
    },
  );
  if (!envelope?.ok) {
    throw new Error(`${action}: ${JSON.stringify(envelope?.error ?? envelope).slice(0, 400)}`);
  }
  return envelope.result as T;
}

/** The first string property named `key` anywhere in `value`. */
function findString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key] as string;
  for (const entry of Object.values(record)) {
    const found = findString(entry, key);
    if (found) return found;
  }
  return undefined;
}

async function filesUnder(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  return (await readdir(directory, { recursive: true })).map(String);
}

async function qualify(signal: AbortSignal): Promise<boolean> {
  root = await mkdtemp(path.join(os.tmpdir(), "ork-capabilities-leaf-launch-"));
  facts.root = root;
  const gitEnv = fixtureGitEnvironment(root);
  facts.commit = runSetup("git", ["rev-parse", "--verify", "HEAD^{commit}"], ROOT, gitEnv).trim();
  if (!skipBuild) {
    // The leaf backend starts the Pi bridge from this checkout's build.
    console.log("Building the Pi bridge from this checkout.");
    runSetup(process.execPath, ["run", "build"], path.join(ROOT, "bridges", "pi-bridge"));
  }
  model = startFakeModel();

  const command = await makeNode({ name: "Command", role: "command", root, signal });
  const leaf = await makeNode({ name: "Leaf", role: "leaf", root, signal });
  nodes.push(command, leaf);

  // The leaf's Pi reads only its isolated HOME: a fake provider, no login.
  const leafHome = path.join(leaf.dir, "home");
  const piAgent = path.join(leafHome, ".pi", "agent");
  await mkdir(piAgent, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(piAgent, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `${model.origin}/v1`,
          api: "openai-completions",
          apiKey: "fake-model-no-provider-requests",
          models: [{ id: "fake-1", name: "Fake 1" }],
        },
      },
    }),
  );
  await writeFile(
    path.join(piAgent, "settings.json"),
    JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1" }),
  );

  // The capability inventory counts Pi as present only when a `pi` binary is
  // in the managed toolchain (an agent-test backend never looks on PATH). The
  // native session itself runs on the Pi bridge's SDK and never runs it, so
  // the leaf's toolchain holds a stub that only answers `--version`.
  const toolchainBin = path.join(leaf.dir, "data", "toolchains", "bin");
  await mkdir(toolchainBin, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(toolchainBin, "pi"),
    '#!/bin/sh\n[ "$1" = "--version" ] && { echo "1.5.2"; exit 0; }\necho "stub pi: not runnable" >&2\nexit 1\n',
    { mode: 0o755 },
  );

  await Promise.all([command.start(), leaf.start()]);
  facts.versions = { command: command.version, leaf: leaf.version };

  const attached = await command.invoke<{ nodeId: string; connection: { state: string } }>(
    "add_node",
    {
      routes: [{ id: "loopback", kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
      displayName: "Leaf",
    },
  );
  check("the command node enrols the leaf", attached.connection.state === "connected");
  const leafId = attached.nodeId;
  await until(
    "the leaf to be in leaf mode",
    () => leaf.invoke<{ mode: string }>("get_node_status"),
    (status) => status.mode === "leaf",
    60_000,
    signal,
  );

  // A local project and environment on the leaf.
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  const git = (...gitArgs: string[]) =>
    runSetup(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Leaf Launch",
        "-c",
        "user.email=leaf-launch@example.invalid",
        ...gitArgs,
      ],
      repo,
      gitEnv,
    );
  git("init", "-q", "-b", "main");
  await writeFile(path.join(repo, "README.md"), "# Leaf launch fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "Initial commit");
  // A project needs an origin; a bare repository in the run directory.
  const origin = path.join(root, "origin.git");
  git("init", "-q", "--bare", origin);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  const project = await publicAction<unknown>(
    leaf,
    "project.add",
    { path: repo },
    "leaf-launch:project",
  );
  const projectId = findString(project, "projectId") ?? findString(project, "id");
  if (!projectId) throw new SetupError(`No project id in ${JSON.stringify(project)}`);
  const created = await publicAction<unknown>(
    leaf,
    "environment.create",
    { projectId, type: "local", name: "leaf-launch" },
    "leaf-launch:environment",
  );
  const environmentId = findString(created, "environmentId") ?? findString(created, "id");
  if (!environmentId) throw new SetupError(`No environment id in ${JSON.stringify(created)}`);
  await publicAction(leaf, "environment.start", { environmentId }, "leaf-launch:start");
  await until(
    "the leaf environment to be running",
    () => publicAction<unknown>(leaf, "environment.get", { environmentId }),
    (value) => /"(running|ready)"/.test(JSON.stringify(value)),
    180_000,
    signal,
  );
  facts.leafEnvironment = "local";

  // The command node selects a required skill for one session of the leaf.
  const marker = `Leaf launch marker ${randomBytes(4).toString("hex")}.`;
  const skillContent = `---\nname: ${SKILL}\ndescription: ${SKILL} skill\n---\n${marker}\n`;
  const inspection = await command.invoke<{
    inspectionId: string;
    packageId: string;
    components: Array<{ id: string }>;
  }>("author_capability_package", {
    kind: "skill",
    name: SKILL,
    description: `${SKILL} skill`,
    content: skillContent,
  });
  const setup = await command.invoke<{ id: string }>("set_capability_setup", {
    setup: { name: "Leaf session tools" },
  });
  const preview = await command.invoke<{ operation: { id: string; planDigest: string } }>(
    "preview_capability_change",
    {
      change: {
        kind: "add-to-setup",
        inspectionId: inspection.inspectionId,
        setupId: setup.id,
        required: true,
      },
    },
  );
  await command.invoke("apply_capability_change", {
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  const assignment = await command.invoke<{ revision: number }>("get_capability_assignment", {
    scope: "session",
    scopeId: SESSION_KEY,
  });
  await command.invoke("assign_capability_setup", {
    scope: "session",
    scopeId: SESSION_KEY,
    setupIds: [setup.id],
    expectedRevision: assignment.revision,
  });
  const componentId = inspection.components[0]?.id;
  if (!componentId) throw new SetupError("The authored package has no component.");

  // The leaf launches that session: its store holds no setups, so its command
  // node resolves the launch, sends the artifact and answers.
  const sessionArgs = (logicalSessionKey: string) => ({
    environmentId,
    agent: "pi",
    logicalSessionKey,
    model: MODEL_ID,
  });
  await leaf.invoke("ensure_native_agent_session", sessionArgs(SESSION_KEY));
  await leaf.invoke("dispatch_native_agent_intent", {
    ...sessionArgs(SESSION_KEY),
    prompt: "first leaf question",
    requestId: "leaf-launch:prompt-1",
  });
  const asked = await until(
    "the leaf's Pi session to reach the fake model",
    async () => model!.requests.find((entry) => entry.prompt.includes("first leaf question")),
    (entry) => entry !== undefined,
    180_000,
    signal,
  ).catch(() => undefined);
  const leafPlugins = path.join(leaf.dir, "data", "capability-session-plugins");
  const staged = (await filesUnder(leafPlugins)).filter((entry) =>
    entry.endsWith(path.join("skills", SKILL, "SKILL.md")),
  );
  const stagedPath =
    staged.length === 1 ? await realpath(path.join(leafPlugins, staged[0]!)) : undefined;
  check(
    "the leaf staged the session's skill from the command node's answer",
    stagedPath !== undefined && (await readFile(stagedPath, "utf8")) === skillContent,
    staged.join(", ") || "nothing staged",
  );
  check(
    "the leaf's Pi session was told about the skill at its staged path",
    Boolean(stagedPath && asked?.system.includes(`<location>${stagedPath}</location>`)),
    asked ? undefined : "the fake model received no request",
  );
  const sharedHomes = [
    ...(await filesUnder(path.join(piAgent, "skills"))),
    ...(await filesUnder(path.join(leafHome, ".agents", "skills"))),
  ];
  check(
    "nothing was written into the leaf's shared Pi homes",
    sharedHomes.length === 0,
    sharedHomes.join(", ") || undefined,
  );

  // Another Pi session on the leaf, with no assignment, does not see it.
  await leaf.invoke("ensure_native_agent_session", sessionArgs(OTHER_SESSION_KEY));
  await leaf.invoke("dispatch_native_agent_intent", {
    ...sessionArgs(OTHER_SESSION_KEY),
    prompt: "other leaf question",
    requestId: "leaf-launch:prompt-2",
  });
  const other = await until(
    "the other Pi session to reach the fake model",
    async () => model!.requests.find((entry) => entry.prompt.includes("other leaf question")),
    (entry) => entry !== undefined,
    180_000,
    signal,
  ).catch(() => undefined);
  check(
    "another Pi session on the leaf does not see the skill",
    Boolean(other && !other.system.includes(SKILL)),
    other ? undefined : "the fake model received no request",
  );

  // The command node recorded the launch it resolved for the leaf (the plugin
  // record itself stays on the leaf, which stages and passes it).
  const view = await command.invoke<{
    launchManifestDigest?: string;
    components: Array<{ componentId: string; status: string }>;
  }>("get_capability_session_view", {
    sessionKey: SESSION_KEY,
    target: { nodeId: leafId, provider: "pi", environmentId },
  });
  facts.commandNodeLaunchManifest = view.launchManifestDigest;
  check(
    "the command node records the launch it resolved for the leaf",
    typeof view.launchManifestDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(view.launchManifestDigest),
    view.launchManifestDigest ?? "no launch record",
  );

  // Test on the command node asks the leaf for the session's own report.
  const verification = await command.invoke<{
    checks: Array<{ componentId: string; level: string; status: string; detail: string }>;
  }>("verify_agent_capability", {
    consent: true,
    target: { nodeId: leafId, provider: "pi", environmentId, sessionId: SESSION_KEY },
    componentIds: [componentId],
  });
  const graded = verification.checks.find((entry) => entry.componentId === componentId);
  facts.verification = graded;
  check(
    "Test on the command node grades the leaf session's skill load-confirmed",
    graded?.level === "load-confirmed",
    graded ? `${graded.level}: ${graded.detail}` : "no check",
  );
  facts.leafIdSuffix = leafId.slice(-6);
  facts.modelRequests = model.requests.length;
  return checks.length > 0 && checks.every((entry) => entry.passed);
}

async function cleanup(): Promise<void> {
  const failures: string[] = [];
  for (const node of nodes.reverse()) {
    try {
      await node.stop();
    } catch (error) {
      failures.push(`${node.label}: ${String(error)}`);
    }
  }
  model?.stop();
  if (root && !keep) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(`${root}: ${String(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}

const exitCode = await runCapabilityQualification(qualify, cleanup, (label, error) =>
  console.error(`${label}: ${String(error).slice(0, 650)}`),
);
const report = { facts, checks, exitCode, finishedAt: new Date().toISOString() };
const target =
  reportPath ??
  path.join(ROOT, "output", "agent-testing", "capabilities-leaf-launch", "report.json");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: ${target}`);
// The leaf's backend output, on failure only; it carries no token (never printed).
if (exitCode !== 0) {
  for (const node of nodes) {
    let tail = node.output.join("").split("\n").slice(-40).join("\n");
    for (const owner of nodes) tail = tail.replaceAll(owner.token, "[token]");
    console.error(`--- ${node.label} output (tail) ---\n${tail}`);
  }
}
process.exitCode = exitCode;
