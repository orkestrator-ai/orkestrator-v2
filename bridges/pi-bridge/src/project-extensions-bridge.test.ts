/**
 * A planted repository extension against the real bridge (to-do 7251).
 *
 * The bridge's HTTP server, its session creation and attach, and Pi's SDK
 * are all real; the workspace is a temporary checkout carrying a `.pi/`
 * extension, and the only credential is a synthetic runtime API key. An
 * extension's factory runs while the session is built, before any model call,
 * so no provider request is made and no turn is run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

const root = mkdtempSync(join(tmpdir(), "pi-bridge-planted-extension-"));
const project = join(root, "checkout");
const agentDir = join(root, "agent");
const stateDir = join(root, "state");
mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
mkdirSync(join(project, ".pi", "skills", "release"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
// What a planted extension would do first: note that it is inside the bridge,
// where every later `Authorization` header and the approval gate live.
writeFileSync(
  join(project, ".pi", "extensions", "planted.ts"),
  `globalThis.__orkPlantedExtensionRan = (globalThis.__orkPlantedExtensionRan ?? 0) + 1;
process.on("ork-planted-probe", () => {
  globalThis.__orkPlantedExtensionRan = (globalThis.__orkPlantedExtensionRan ?? 0) + 1;
});
export default function planted(pi) {
  pi.registerCommand("planted-probe", { description: "planted", handler: async () => {} });
}
`,
);
writeFileSync(
  join(project, ".pi", "skills", "release", "SKILL.md"),
  "---\nname: release\ndescription: release skill\n---\nSteps.\n",
);

const ENV_KEYS = [
  "PORT",
  "HOSTNAME",
  "CWD",
  "PI_BRIDGE_TOKEN",
  "PI_BRIDGE_LIBRARY_ONLY",
  "PI_BRIDGE_STATE_DIR",
  "PI_AGENT_DIR",
  "PI_SESSION_DIR",
  "ORKESTRATOR_BRIDGE_EXECUTION_POLICY",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
// `config.ts` reads its environment once, at import: everything below loads after this.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.CWD = project;
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
process.env.PI_BRIDGE_STATE_DIR = stateDir;
process.env.PI_AGENT_DIR = agentDir;
process.env.PI_SESSION_DIR = join(root, "sessions");
delete process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { closeSession } = await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { nativeFetch } = await import("./testing/native-fetch.js");
const { ModelRuntime } = await import("./pi-sdk.js");
const { PROJECT_EXTENSIONS_REFUSED_NOTE } = await import("./project-extensions.js");

const globals = globalThis as { __orkPlantedExtensionRan?: number };
let origin: string;

beforeAll(async () => {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  // Synthetic: satisfies the signed-in check; no request is ever made with it.
  await runtime.setRuntimeApiKey("anthropic", "test-only-no-provider-requests");
  setModelRuntimeFactoryForTests(async () => runtime);
  refreshModels();
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const state of Array.from(sessions.values())) await closeSession(state);
  sessions.clear();
  clientSessionKeys.clear();
  await shutdown();
  setModelRuntimeFactoryForTests();
  refreshModels();
  delete globals.__orkPlantedExtensionRan;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function post(path: string, body: unknown): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

const container = (approvals: NativeAgentExecutionPolicy["approvals"]) =>
  ({
    id: "interactive-container",
    sandbox: "container",
    approvals,
    projectResources: true,
    networkAccess: "restricted",
  }) satisfies NativeAgentExecutionPolicy;

/** Create and attach a session; attaching is what builds Pi's session. */
async function attached(clientSessionKey: string, policy: NativeAgentExecutionPolicy) {
  const created = await post("/session/create", { clientSessionKey, policy });
  expect(created.status).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };
  const attach = await post(`/session/${sessionId}/attach`, {});
  expect(attach.status).toBe(200);
  const state = sessions.get(sessionId)!;
  expect(state.session).not.toBeNull();
  return state;
}

function commands(state: NonNullable<ReturnType<typeof sessions.get>>): string[] {
  return state
    .session!.resourceLoader.getExtensions()
    .extensions.flatMap((extension) => [...extension.commands.keys()]);
}

describe("a planted Pi extension and the bridge process", () => {
  test("never runs in an ask session, which keeps the project's skills and says why", async () => {
    const state = await attached("planted-ask", container("ask"));
    expect(globals.__orkPlantedExtensionRan).toBeUndefined();
    expect(commands(state)).not.toContain("planted-probe");
    expect(state.session!.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain(
      "release",
    );
    const read = await nativeFetch(`${origin}/session/${state.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await read.json()) as { policy: NativeAgentExecutionPolicy };
    expect(body.policy.projectResources).toBe(true);
    expect(body.policy.note).toContain(PROJECT_EXTENSIONS_REFUSED_NOTE);
  });

  test("auto-approve cannot plant a persistent callback before narrowing or a separate ask session", async () => {
    const state = await attached("planted-auto", container("auto-approve"));
    // Auto-approve shares the process with future ask sessions, so it also refuses it.
    expect(globals.__orkPlantedExtensionRan).toBeUndefined();
    expect(commands(state)).not.toContain("planted-probe");

    // Narrowing a live session's policy detaches it; the rebuild uses the new one.
    const narrowed = await post("/session/create", {
      clientSessionKey: "planted-auto",
      policy: container("ask"),
    });
    expect(narrowed.status).toBeLessThan(300);
    expect(state.session).toBeNull();
    const ranBefore = globals.__orkPlantedExtensionRan;
    const reattach = await post(`/session/${state.id}/attach`, {});
    expect(reattach.status).toBe(200);
    expect(globals.__orkPlantedExtensionRan).toBe(ranBefore);
    expect(commands(state)).not.toContain("planted-probe");
    await attached("planted-separate-ask", container("ask"));
    expect(process.listenerCount("ork-planted-probe")).toBe(0);
    process.emit("ork-planted-probe");
    expect(globals.__orkPlantedExtensionRan).toBeUndefined();
  });
});
